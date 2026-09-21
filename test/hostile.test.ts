/**
 * Everything in a transcript is attacker-controlled: the file name that becomes
 * a session id, the title, the message text and the `cwd` field. These tests
 * treat all of it as hostile.
 */
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildResumeCommand,
  hasControlCharacters,
  isValidSessionId,
  recentSessions,
  sanitizeLine,
  sanitizeText,
  search,
  shellQuote,
  spawnResume,
  sync,
  UserError,
} from '../src/core/index.js';
import { readSessionFile } from '../src/core/parser.js';
import { isSafeSpawnCwd } from '../src/tui/index.js';
import {
  aiTitle,
  assistantMessage,
  childEnv,
  cleanupTempDirs,
  type Fixture,
  makeFixture,
  tempDir,
  openFixtureDb,
  userMessage,
  writeSession,
} from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');

/** A file name that would run two extra commands if it were ever interpolated. */
const HOSTILE_ID = 'x; echo PWNED; #';
/** OSC (window title / clipboard), BEL and SGR colour, as a transcript could carry them. */
const ESCAPES = '\u001b]0;PWNED\u0007\u001b[31mRED\u001b[0m';

let fixture: Fixture;
let pwnedMarker: string;

beforeAll(async () => {
  fixture = makeFixture();
  pwnedMarker = path.join(fixture.root, 'PWNED');

  writeSession(fixture.projectsDir, '-tmp-safe', 'safe-session', [
    aiTitle('A perfectly ordinary session'),
    userMessage('recording and editing videos', { cwd: '/tmp/safe' }),
  ]);
  // The injection attempt: a session file whose *name* is a shell command.
  writeSession(fixture.projectsDir, '-tmp-evil', HOSTILE_ID, [
    aiTitle('Injection attempt'),
    userMessage('recording and editing videos', { cwd: '/tmp/evil' }),
  ]);
  // Escape sequences in the title and in the message body.
  writeSession(fixture.projectsDir, '-tmp-esc', 'escape-session', [
    aiTitle(`${ESCAPES} escaped title`),
    userMessage(`before ${ESCAPES} after recording videos`, { cwd: '/tmp/esc' }),
  ]);
  // A forged, relative cwd: resuming this must never land in the launch folder.
  writeSession(fixture.projectsDir, '-tmp-dot', 'dot-session', [
    aiTitle('Relative cwd'),
    userMessage('recording videos from a relative folder', { cwd: '.' }),
  ]);

  const db = openFixtureDb(fixture);
  await sync({ db, projectsDir: fixture.projectsDir });
  db.close();
});

afterAll(cleanupTempDirs);

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--projects-dir', fixture.projectsDir], {
    encoding: 'utf8',
    env: childEnv({ CCFIND_HOME: fixture.home }),
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/* ------------------------------------------------------- 1. shell injection */

describe('a session id can never reach a shell (must-fix 1)', () => {
  it('refuses to index a file whose name is a shell command', async () => {
    const db = openFixtureDb(fixture);
    const rows = db.prepare('SELECT path, session_id, state FROM files').all() as {
      path: string;
      session_id: string | null;
      state: string;
    }[];
    const evil = rows.find((row) => row.path.includes(HOSTILE_ID));

    expect(evil, 'the hostile file is tracked, not ignored').toBeDefined();
    expect(evil?.session_id).toBeNull();
    expect(evil?.state).toBe('invalid');
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 2 });
    db.close();
  });

  it('records the skipped file so it is not re-parsed on every run', async () => {
    const db = openFixtureDb(fixture);
    const again = await sync({ db, projectsDir: fixture.projectsDir });
    expect(again.indexedFiles).toBe(0);
    expect(again.skippedFiles).toBe(4);
    db.close();
  });

  it('never returns the hostile session from a search', async () => {
    const db = openFixtureDb(fixture);
    const results = await search({ db, query: 'recording videos', limit: 10 });
    expect(results.map((r) => r.sessionId)).not.toContain(HOSTILE_ID);
    expect(results.every((r) => isValidSessionId(r.sessionId))).toBe(true);
    db.close();
  });

  it('throws rather than build a command around an unsafe id', () => {
    for (const id of [HOSTILE_ID, '$(id)', '`id`', 'a b', '../../etc/passwd', '', 'a'.repeat(200), '-rf']) {
      expect(() => buildResumeCommand('/tmp/app', id), id).toThrow(UserError);
    }
    expect(buildResumeCommand('/tmp/app', 'ok-123')).toBe("cd '/tmp/app' && claude --resume 'ok-123'");
  });

  it('quotes the id so /bin/sh would run nothing extra even if one got through', () => {
    const dir = tempDir('sf-shim-');
    const marker = path.join(dir, 'PWNED');
    const argvFile = path.join(dir, 'argv.txt');
    // A stand-in for `claude` that records its argv. The real CLI never runs.
    fs.writeFileSync(
      path.join(dir, 'claude'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvFile)}\n`,
      { mode: 0o755 },
    );
    const hostile = `${HOSTILE_ID}; touch ${JSON.stringify(marker)}`;
    const command = `cd ${shellQuote(dir)} && claude --resume ${shellQuote(hostile)}`;

    const result = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      env: childEnv({ CCFIND_HOME: fixture.home, PATH: `${dir}:${process.env['PATH'] ?? ''}` }),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('PWNED');
    expect(fs.existsSync(marker), 'the injected command must not have run').toBe(false);
    expect(fs.readFileSync(argvFile, 'utf8')).toBe(`--resume\n${hostile}\n`);
  });

  it('every resume command the CLI prints is inert in a real shell', () => {
    const json = runCli(['recording videos', '--json']);
    expect(json.status).toBe(0);
    const results = JSON.parse(json.stdout) as { resumeCommand: string }[];
    expect(results.length).toBeGreaterThan(0);

    const dir = tempDir('sf-shim2-');
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (const result of results) {
      const run = spawnSync('/bin/sh', ['-c', result.resumeCommand], {
        encoding: 'utf8',
        env: childEnv({ CCFIND_HOME: fixture.home, PATH: `${dir}:${process.env['PATH'] ?? ''}` }),
      });
      expect([result.resumeCommand, (run.stdout ?? '') + (run.stderr ?? '')].join(' ')).not.toContain('PWNED');
    }
    expect(fs.existsSync(pwnedMarker)).toBe(false);
  });

  it('refuses to spawn an unsafe id even if one reached the index', async () => {
    await expect(spawnResume({ cwd: fixture.root, sessionId: HOSTILE_ID })).rejects.toBeInstanceOf(UserError);
  });
});

/* ---------------------------------------------------- 2. terminal escapes */

/** Everything an ESC or BEL byte could be, minus the SGR colours a UI writes itself. */
function residualEscapes(text: string): string[] {
  // eslint-disable-next-line no-control-regex
  const withoutSgr = text.replace(/\u001b\[[0-9;]*m/g, '');
  // eslint-disable-next-line no-control-regex
  return withoutSgr.match(/[\u001b\u0007]/g) ?? [];
}

describe('escape sequences never reach a terminal (must-fix 2)', () => {
  it('strips control and format characters but keeps newlines and tabs', () => {
    expect(sanitizeText(`a${ESCAPES}b`)).toBe('a]0;PWNED[31mRED[0mb');
    expect(sanitizeText('a\nb\tc')).toBe('a\nb\tc');
    expect(sanitizeLine('a\nb\tc')).toBe('a b c');
    expect(sanitizeText('a​b‍c')).toBe('abc');
    expect(sanitizeText('a\ud800b')).toBe('ab');
    expect(sanitizeText('ok 😀')).toBe('ok 😀');
  });

  it('stores sanitised text, so highlight offsets still index what is shown', async () => {
    const parsed = await readSessionFile(path.join(fixture.projectsDir, '-tmp-esc', 'escape-session.jsonl'));
    expect(parsed).not.toBeNull();
    expect(parsed?.meta.title).not.toMatch(/[\u001b\u0007]/);
    expect(parsed?.messages.every((m) => !/[\u001b\u0007]/.test(m.text))).toBe(true);

    const db = openFixtureDb(fixture);
    const results = await search({ db, query: 'recording videos', limit: 10 });
    const hit = results.find((r) => r.sessionId === 'escape-session');
    expect(hit).toBeDefined();
    for (const [start, end] of hit?.snippet.highlights ?? []) {
      const slice = hit?.snippet.text.slice(start, end) ?? '';
      expect(slice.length).toBe(end - start);
      expect(slice).not.toMatch(/[\u001b\u0007]/);
    }
    db.close();
  });

  it('keeps ESC and BEL out of plain search output', () => {
    const result = runCli(['recording videos']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('escaped title');
    expect(residualEscapes(result.stdout)).toEqual([]);
    expect(residualEscapes(result.stderr)).toEqual([]);
  });

  it('keeps ESC and BEL out of every --json string value', () => {
    const result = runCli(['recording videos', '--json']);
    expect(result.status).toBe(0);
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(JSON.parse(result.stdout));
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.filter((s) => /[\u001b\u0007]/.test(s))).toEqual([]);
  });
});

/* --------------------------------------------------------- 3. forged cwd */

describe('a forged cwd cannot point at the launch folder (must-fix 3)', () => {
  it('ignores records whose cwd is not absolute, and skips a session with only those', async () => {
    const parsed = await readSessionFile(path.join(fixture.projectsDir, '-tmp-dot', 'dot-session.jsonl'));
    expect(parsed, 'a session with no absolute cwd is skipped entirely').toBeNull();

    const db = openFixtureDb(fixture);
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get('dot-session')).toBeUndefined();
    expect(recentSessions({ db, limit: 20 }).every((r) => path.isAbsolute(r.cwd))).toBe(true);
    db.close();
  });

  it('takes the first absolute cwd when earlier records are relative', async () => {
    const dir = tempDir('sf-mixed-');
    const file = writeSession(dir, '-tmp-mixed', 'mixed-session', [
      userMessage('first message with a relative cwd', { cwd: '..' }),
      assistantMessage('second message with a real cwd', { cwd: '/tmp/real-folder' }),
    ]);
    const parsed = await readSessionFile(file);
    expect(parsed?.meta.cwd).toBe('/tmp/real-folder');
  });

  it('only calls an absolute, existing directory safe to spawn in', () => {
    expect(isSafeSpawnCwd('.')).toBe(false);
    expect(isSafeSpawnCwd('')).toBe(false);
    expect(isSafeSpawnCwd('relative/path')).toBe(false);
    expect(isSafeSpawnCwd('/nonexistent-folder-for-tests')).toBe(false);
    expect(isSafeSpawnCwd(fixture.root)).toBe(true);
    expect(isSafeSpawnCwd(path.join(fixture.projectsDir, '-tmp-safe', 'safe-session.jsonl'))).toBe(false);
  });

  it('spawns an argv array with no shell', async () => {
    const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
    const fakeSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      setTimeout(() => child.emit('close', 0), 0);
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    const code = await spawnResume({ cwd: fixture.root, sessionId: 'safe-session', spawn: fakeSpawn });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('claude');
    expect(calls[0]?.args).toEqual(['--resume', 'safe-session']);
    expect(Object.keys(calls[0]?.options ?? {}).sort()).toEqual(['cwd', 'stdio']);
    expect('shell' in (calls[0]?.options ?? {})).toBe(false);
  });
});

/* ------------------------- second review, should-fix 8: exotic line breaks */

describe('line separators that are not \\n', () => {
  it('become spaces, and are reported as control characters', () => {
    for (const ch of ['\u0085', ' ', ' ']) {
      expect([ch, sanitizeLine(`a${ch}b`)]).toEqual([ch, 'a b']);
      expect([ch, sanitizeText(`a${ch}b`)]).toEqual([ch, 'a b']);
      expect([ch, hasControlCharacters(`a${ch}b`)]).toEqual([ch, true]);
      // One line in, one line out: a title cannot push the row below it.
      expect([ch, sanitizeLine(`a${ch}b`).split('\n')]).toEqual([ch, ['a b']]);
    }
  });
});
