import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildResumeCommand, shellQuote, spawnResume } from '../src/core/resume.js';
import { syncIndex } from '../src/core/indexer.js';
import { search } from '../src/core/search.js';
import { cleanupTempDirs, makeFixture, openFixtureDb, tempDir, userMessage, writeSession } from './helpers.js';

afterAll(cleanupTempDirs);

describe('resume command quoting', () => {
  it('quotes a plain path', () => {
    expect(buildResumeCommand('/tmp/app', 'abc-123')).toBe("cd '/tmp/app' && claude --resume 'abc-123'");
  });

  it('quotes a path with a space and a single quote', () => {
    const cwd = "/tmp/my folder/it's here";
    expect(buildResumeCommand(cwd, 'abc-123')).toBe(
      "cd '/tmp/my folder/it'\\''s here' && claude --resume 'abc-123'",
    );
  });

  // `shellQuote` produces POSIX single-quoting, and the only thing that can
  // settle whether it is right is a POSIX shell. Windows has no `/bin/sh`, and
  // the copyable command is not what starts `claude` there — the Windows spawn
  // path is proved instead in "spawning claude" below.
  it.skipIf(process.platform === 'win32')('the quoted path survives a real shell round trip', () => {
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

  // The Windows counterpart of the `/bin/sh` round trip above: `shell: true`
  // means cmd.exe parses the command line, so the question is what is allowed
  // onto it. The answer has to be "the shim path and nothing else".
  it('keeps a hostile folder off the Windows command line entirely', async () => {
    const hostile = [
      'C:\\Users\\me\\a & calc.exe',
      'C:\\Users\\me\\a | calc.exe',
      'C:\\Users\\me\\a ^ b',
      'C:\\Users\\me\\%PATH%',
      'C:\\Users\\me\\a " b',
      'C:\\Users\\me\\(paren) dir',
      'C:\\Users\\me\\a && del /q *',
    ];
    for (const cwd of hostile) {
      const { calls, spawn } = record();
      await spawnResume({
        cwd,
        sessionId: 'abc-123',
        spawn,
        platform: 'win32',
        which: () => 'C:\\Program Files\\nodejs\\claude.cmd',
      });
      const call = calls[0]!;
      // Whatever the folder is called, it travels as an option.
      expect([cwd, call.options.cwd]).toEqual([cwd, cwd]);
      // …and never as text in the command line or the arguments.
      expect([cwd, call.command]).toEqual([cwd, '"C:\\Program Files\\nodejs\\claude.cmd"']);
      expect([cwd, call.args]).toEqual([cwd, ['--resume', 'abc-123']]);
    }
  });

  it('refuses every hostile session id before a Windows shell could see it', async () => {
    for (const id of ['a & calc', 'a | calc', 'a ^ b', '%PATH%', 'a" & calc & "', 'a (b)', 'a && del']) {
      const { calls, spawn } = record();
      await expect(
        spawnResume({
          cwd: 'C:\\app',
          sessionId: id,
          spawn,
          platform: 'win32',
          which: () => 'C:\\Program Files\\nodejs\\claude.cmd',
        }),
      ).rejects.toThrow(/unsafe session id/);
      expect([id, calls]).toEqual([id, []]);
    }
  });
});

/**
 * The Windows spawn path for real, with a `claude.cmd` on PATH.
 *
 * `.cmd` is the one case that goes through cmd.exe, so nothing here is proved
 * by the injected-spawn tests above: this runs the actual shim, in a folder
 * whose name contains every cmd.exe metacharacter a Windows path is allowed to
 * hold (`| " < > : ? *` are illegal in a directory name).
 */
describe.runIf(process.platform === 'win32')('spawning a real claude.cmd on Windows', () => {
  /** A `.cmd` that writes its working directory and each argument on its own line. */
  function argvRecorderCmd(exitCode: number): string {
    return [
      '@echo off',
      '>"%CCFIND_TEST_ARGV%" echo %CD%',
      ':loop',
      'if "%~1"=="" goto done',
      '>>"%CCFIND_TEST_ARGV%" echo %~1',
      'shift',
      'goto loop',
      ':done',
      `exit /b ${exitCode}`,
      '',
    ].join('\r\n');
  }

  it('runs the shim in the session folder with the id as one argument', async () => {
    const binDir = tempDir('ccfind-resume-bin-');
    // A space is as far as `echo %CD%` can be pushed: cmd.exe expands `%VAR%`
    // before it looks for `&`, so a folder whose *name* contains one cannot be
    // echoed at all. The hostile names are covered by the next test, which
    // never puts the folder on a command line.
    const workdir = path.join(tempDir('ccfind-resume-cwd-'), 'my session folder');
    fs.mkdirSync(workdir, { recursive: true });
    const outFile = path.join(binDir, 'argv.txt');
    // The shim reports where it ran and what it was given through an
    // environment variable, so the file name never touches the command line.
    fs.writeFileSync(path.join(binDir, 'claude.cmd'), argvRecorderCmd(7));
    const previousPath = process.env['PATH'];
    const previousOut = process.env['CCFIND_TEST_ARGV'];
    process.env['PATH'] = `${binDir}${path.delimiter}${previousPath ?? ''}`;
    process.env['CCFIND_TEST_ARGV'] = outFile;
    try {
      const code = await spawnResume({ cwd: workdir, sessionId: 'abc-123' });
      expect(code).toBe(7);
      const recorded = fs.readFileSync(outFile, 'utf8').trim().split(/\r?\n/);
      // Both sides through realpath: cmd.exe reports `%CD%` in the spelling it
      // was handed, and `os.tmpdir()` on a CI runner hands out the 8.3 short
      // name. Same folder, two names.
      expect(fs.realpathSync.native(recorded[0]!)).toBe(fs.realpathSync.native(workdir));
      expect(recorded.slice(1)).toEqual(['--resume', 'abc-123']);
    } finally {
      process.env['PATH'] = previousPath;
      if (previousOut === undefined) delete process.env['CCFIND_TEST_ARGV'];
      else process.env['CCFIND_TEST_ARGV'] = previousOut;
    }
  }, 20_000);

  it('a hostile folder name is not a command, even through cmd.exe', async () => {
    const binDir = tempDir('ccfind-resume-bin2-');
    // `& md PWNED` would create a folder if this name ever reached a command
    // line. It is a directory name, so it must only ever be a directory name.
    // (`> | " < : ? *` cannot be tested this way: Windows will not let a
    // directory be called that in the first place.)
    const parent = tempDir('ccfind-resume-cwd2-');
    for (const name of ['a & md PWNED', 'a ^ b %PATH%', 'x (paren) & md PWNED2']) {
      const workdir = path.join(parent, name);
      fs.mkdirSync(workdir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'claude.cmd'), '@echo off\r\nexit /b 0\r\n');
      const previousPath = process.env['PATH'];
      process.env['PATH'] = `${binDir}${path.delimiter}${previousPath ?? ''}`;
      try {
        expect([name, await spawnResume({ cwd: workdir, sessionId: 'abc-123' })]).toEqual([name, 0]);
        for (const pwned of ['PWNED', 'PWNED2']) {
          expect([name, fs.existsSync(path.join(workdir, pwned))]).toEqual([name, false]);
          expect([name, fs.existsSync(path.join(parent, pwned))]).toEqual([name, false]);
          expect([name, fs.existsSync(path.join(binDir, pwned))]).toEqual([name, false]);
        }
      } finally {
        process.env['PATH'] = previousPath;
      }
    }
  }, 30_000);
});
