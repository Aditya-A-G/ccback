import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { buildResumeCommand, shellQuote, spawnResume } from '../src/core/resume.js';
import { syncIndex } from '../src/core/indexer.js';
import { search } from '../src/core/search.js';
import { cleanupTempDirs, makeFixture, openFixtureDb, userMessage, writeSession } from './helpers.js';

afterAll(cleanupTempDirs);

describe('resume command quoting (criterion 11)', () => {
  it('quotes a plain path', () => {
    expect(buildResumeCommand('/tmp/app', 'abc-123')).toBe("cd '/tmp/app' && claude --resume 'abc-123'");
  });

  it('quotes a path with a space and a single quote', () => {
    const cwd = "/tmp/my folder/it's here";
    expect(buildResumeCommand(cwd, 'abc-123')).toBe(
      "cd '/tmp/my folder/it'\\''s here' && claude --resume 'abc-123'",
    );
  });

  it('the quoted path survives a real shell round trip', () => {
    for (const cwd of [
      "/tmp/my folder/it's here",
      '/tmp/a "quoted" dir',
      '/tmp/semi;colon && rm -rf x',
      '/tmp/dollar$HOME/`backtick`',
      "/tmp/''",
    ]) {
      const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(cwd)}`], { encoding: 'utf8' });
      expect(out).toBe(cwd);
    }
  });

  it('refuses an unsafe session id before anything is spawned', async () => {
    const calls: unknown[] = [];
    await expect(
      spawnResume({
        cwd: '/tmp',
        sessionId: 'a b; rm -rf /',
        spawn: ((...args: unknown[]) => {
          calls.push(args);
          throw new Error('must not be called');
        }) as never,
      }),
    ).rejects.toThrow(/unsafe session id/);
    expect(calls).toEqual([]);
  });

  it('search results carry the quoted command', async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-odd', 'odd-session', [
      userMessage('a message in an awkward folder', { cwd: "/tmp/my folder/it's here" }),
    ]);
    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });
    const results = await search({ db, query: 'awkward folder' });
    expect(results[0]?.resumeCommand).toBe(
      "cd '/tmp/my folder/it'\\''s here' && claude --resume 'odd-session'",
    );
    db.close();
  });
});

/**
 * Starting `claude` itself. On Windows it is a `.cmd` shim, and since Node's
 * 2024 security fix a shell is the only way to run one — which is why the
 * session id is validated first and never becomes part of a command string.
 */
describe('spawning claude', () => {
  interface Call {
    command: string;
    args: string[];
    options: { cwd?: string; shell?: boolean };
  }

  function record(): { calls: Call[]; spawn: never } {
    const calls: Call[] = [];
    const spawn = ((command: string, args: string[], options: Call['options']) => {
      calls.push({ command, args, options });
      return {
        on(event: string, listener: (code: number) => void) {
          if (event === 'close') queueMicrotask(() => listener(0));
          return this;
        },
      };
    }) as never;
    return { calls, spawn };
  }

  it('uses no shell on macOS and Linux', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { calls, spawn } = record();
      const code = await spawnResume({ cwd: '/tmp/app', sessionId: 'abc-123', spawn, platform });
      expect(code).toBe(0);
      expect(calls[0]!.command).toBe('claude');
      expect(calls[0]!.args).toEqual(['--resume', 'abc-123']);
      expect(calls[0]!.options.shell).toBeUndefined();
      expect(calls[0]!.options.cwd).toBe('/tmp/app');
    }
  });

  it('runs a Windows .cmd shim through a shell, quoted, with the id still an argument', async () => {
    const { calls, spawn } = record();
    const code = await spawnResume({
      cwd: 'C:\\Users\\me\\my app',
      sessionId: 'abc-123',
      spawn,
      platform: 'win32',
      which: () => 'C:\\Program Files\\nodejs\\claude.cmd',
    });
    expect(code).toBe(0);
    expect(calls[0]!.command).toBe('"C:\\Program Files\\nodejs\\claude.cmd"');
    expect(calls[0]!.args).toEqual(['--resume', 'abc-123']);
    expect(calls[0]!.options.shell).toBe(true);
    // The folder travels as an option, never as text in a command line.
    expect(calls[0]!.options.cwd).toBe('C:\\Users\\me\\my app');
  });

  it('uses no shell for a real Windows executable', async () => {
    const { calls, spawn } = record();
    await spawnResume({
      cwd: 'C:\\app',
      sessionId: 'abc-123',
      spawn,
      platform: 'win32',
      which: () => 'C:\\tools\\claude.exe',
    });
    expect(calls[0]!.command).toBe('C:\\tools\\claude.exe');
    expect(calls[0]!.options.shell).toBeUndefined();
  });

  it('falls back to the bare name when Windows PATH has no claude, so ENOENT is reported as usual', async () => {
    const { calls, spawn } = record();
    await spawnResume({ cwd: 'C:\\app', sessionId: 'abc-123', spawn, platform: 'win32', which: () => null });
    expect(calls[0]!.command).toBe('claude');
    expect(calls[0]!.options.shell).toBeUndefined();
  });
});
