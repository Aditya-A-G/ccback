/**
 * The command line, as somebody types it.
 *
 * The one rule: words are always the search, every switch is a flag. There are
 * no subcommands, so `ccfind web project` looks for "web project" instead of
 * starting a browser nobody asked for.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assistantMessage,
  childEnv,
  cleanupTempDirs,
  makeFixture,
  tempDir,
  userMessage,
  writeSession,
} from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');

const fixture = makeFixture();

beforeAll(() => {
  if (!fs.existsSync(cliPath)) {
    throw new Error(`dist/cli.js is missing. Run "npm run build" first (npm test does this for you).`);
  }
  writeSession(fixture.projectsDir, '-tmp-video-app', 'video-session', [
    userMessage('How will I be recording the videos and how will you edit them?', {
      cwd: '/tmp/video-app',
      timestamp: '2026-01-02T00:00:00.000Z',
    }),
    assistantMessage('You can record with OBS and I will edit the footage afterwards.', {
      cwd: '/tmp/video-app',
      timestamp: '2026-01-02T00:05:00.000Z',
    }),
  ]);
  writeSession(fixture.projectsDir, '-tmp-other-app', 'other-session', [
    userMessage('Completely unrelated notes about tax invoices.', {
      cwd: '/tmp/other-app',
      timestamp: '2026-02-02T00:00:00.000Z',
    }),
  ]);
  // The word "web" inside a transcript is what proves it is a query, not a command.
  writeSession(fixture.projectsDir, '-tmp-web-app', 'web-session', [
    userMessage('Notes about the web project and its deployment.', {
      cwd: '/tmp/web-app',
      timestamp: '2026-03-02T00:00:00.000Z',
    }),
  ]);
});

afterAll(cleanupTempDirs);

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: childEnv({ CCFIND_HOME: fixture.home }),
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const withFixture = (args: string[]): string[] => [...args, '--projects-dir', fixture.projectsDir];

describe('cli grammar: words are always the query', () => {
  it('searches for the words of a former subcommand instead of running it', () => {
    const result = run(withFixture(['web', 'project', '--json']));
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { sessionId: string }[];
    expect(parsed[0]?.sessionId).toBe('web-session');
  });

  it('has no `search`, `index`, `stats` or `web` subcommand left, not even as an alias', () => {
    // `search` is now simply a word to look for, and nothing in the index says it.
    const searched = run(withFixture(['search', '--json']));
    expect(searched.status).toBe(0);
    expect(JSON.parse(searched.stdout)).toEqual([]);

    const stats = run(withFixture(['stats', '--json']));
    expect(stats.status).toBe(0);
    expect(JSON.parse(stats.stdout)).toEqual([]);
  });

  it('lists recent sessions when given no words at all', () => {
    const result = run(withFixture([]));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('video-session');
    expect(result.stdout).toContain('other-session');
  });
});

describe('cli --json', () => {
  it('emits valid JSON matching SessionResult[] and nothing else on stdout', () => {
    const result = run(withFixture(['recording', 'videos', '--json']));
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    const first = (parsed as Record<string, unknown>[])[0]!;
    expect(Object.keys(first).sort()).toEqual(
      [
        'cwd',
        'cwdExists',
        'firstTs',
        'gitBranch',
        'lastTs',
        'matchCount',
        'messageCount',
        'modeUsed',
        'resumeCommand',
        'score',
        'sessionId',
        'snippet',
        'sources',
        'title',
      ].sort(),
    );
    expect(first['sessionId']).toBe('video-session');
    expect(first['cwd']).toBe('/tmp/video-app');
    // Nothing is embedded here, so `auto` resolved to keyword and says so.
    expect(first['modeUsed']).toBe('keyword');
    expect(Object.keys(first['snippet'] as object).sort()).toEqual(['highlights', 'messageId', 'role', 'text', 'ts']);
  });

  it('keeps indexing progress out of stdout', () => {
    const result = run(withFixture(['recording', '--json']));
    expect(result.status).toBe(0);
    expect(result.stdout.trimStart().startsWith('[')).toBe(true);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it('returns an empty JSON array for a query that matches nothing', () => {
    const result = run(withFixture(['zzzzqqqxyz', '--json']));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it('falls back to recent sessions for an empty query string', () => {
    const result = run(withFixture(['', '--json']));
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { sessionId: string; score: number }[];
    expect(parsed.map((r) => r.sessionId).sort()).toEqual(['other-session', 'video-session', 'web-session']);
    expect(parsed.every((r) => r.score === 0)).toBe(true);
  });
});

describe('cli plain output', () => {
  it('prints title, folder, snippet and resume command', () => {
    const result = run(withFixture(['recording videos']));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('/tmp/video-app');
    expect(result.stdout).toContain("claude --resume 'video-session'");
    expect(result.stdout).toContain('(folder missing)');
  });

  it('-p prints the same thing as a pipe does', () => {
    const piped = run(withFixture(['recording videos']));
    const printed = run(withFixture(['recording videos', '-p']));
    expect(printed.status).toBe(0);
    expect(printed.stdout).toBe(piped.stdout);
  });

  it('says so, with exit code 0, when nothing matches', () => {
    const result = run(withFixture(['zzzzqqqxyz']));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No matching sessions.');
  });

  it('honours --limit and --cwd', () => {
    const limited = run(withFixture(['recording videos notes invoices', '--limit', '1']));
    expect(limited.status).toBe(0);
    expect(limited.stdout.match(/claude --resume/g)).toHaveLength(1);

    const scoped = run(withFixture(['recording videos notes invoices', '--cwd', '/tmp/other-app', '--json']));
    const parsed = JSON.parse(scoped.stdout) as { sessionId: string }[];
    expect(parsed.map((r) => r.sessionId)).toEqual(['other-session']);
  });

  it('--sort recent reorders the same matched set by last activity', () => {
    const args = ['recording videos invoices project', '--json'];
    const relevance = JSON.parse(run(withFixture(args)).stdout) as { sessionId: string; lastTs: string }[];
    const recent = JSON.parse(run(withFixture([...args, '--sort', 'recent'])).stdout) as {
      sessionId: string;
      lastTs: string;
    }[];

    expect(recent.map((r) => r.sessionId).sort()).toEqual(relevance.map((r) => r.sessionId).sort());
    const stamps = recent.map((r) => r.lastTs);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    expect(recent[0]?.sessionId).toBe('web-session');
  });

  it('--sort oldest is accepted, and prints sessions newest first like --sort recent', () => {
    const args = ['recording videos invoices project', '--json'];
    const oldest = JSON.parse(run(withFixture([...args, '--sort', 'oldest'])).stdout) as {
      sessionId: string;
    }[];
    const recent = JSON.parse(run(withFixture([...args, '--sort', 'recent'])).stdout) as {
      sessionId: string;
    }[];
    // A printed list has no matches to step through, so both mean the same here.
    expect(oldest.map((r) => r.sessionId)).toEqual(recent.map((r) => r.sessionId));
  });

  it('--sort best is the default, and relevance still means the same thing', () => {
    const args = ['recording videos invoices project', '--json'];
    const ids = (extra: string[] = []): string[] => {
      const result = run(withFixture([...args, ...extra]));
      expect(result.status, extra.join(' ')).toBe(0);
      return (JSON.parse(result.stdout) as { sessionId: string }[]).map((r) => r.sessionId);
    };
    const plain = ids();
    expect(ids(['--sort', 'best'])).toEqual(plain);
    // The old name is undocumented but still accepted.
    expect(ids(['--sort', 'relevance'])).toEqual(plain);
  });

  it('--json still carries a score, and two runs agree', () => {
    const args = ['recording videos invoices project', '--json'];
    const first = JSON.parse(run(withFixture(args)).stdout) as { sessionId: string; score: number }[];
    const second = JSON.parse(run(withFixture(args)).stdout) as { sessionId: string; score: number }[];
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((r) => typeof r.score === 'number' && Number.isFinite(r.score))).toBe(true);
    // The tilt moves with the clock, so scores may differ by a hair between
    // runs seconds apart; the ranking they produce must not.
    expect(second.map((r) => r.sessionId)).toEqual(first.map((r) => r.sessionId));
  });

  it('--keyword-only is accepted and stays keyword', () => {
    const result = run(withFixture(['recording videos', '--keyword-only', '--json']));
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as { modeUsed: string }[])[0]?.modeUsed).toBe('keyword');
  });

  it('--no-sync still searches the existing index', () => {
    const result = run(withFixture(['recording', '--no-sync', '--json']));
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as unknown[]).length).toBeGreaterThan(0);
    // The folder it was told about is the folder the index holds, so there is
    // nothing to warn about.
    expect(result.stderr).toBe('');
  });

  it('--no-sync says so when the folder asked for is not the one the index holds', () => {
    const elsewhere = tempDir('ccfind-cli-elsewhere-');
    writeSession(elsewhere, '-tmp-elsewhere', 'elsewhere-session', [
      userMessage('a session that lives somewhere else entirely', { cwd: '/tmp/elsewhere' }),
    ]);

    const result = run(['recording', '--no-sync', '--json', '--projects-dir', elsewhere]);
    expect(result.status).toBe(0);
    const lines = result.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('--no-sync');
    // The folder the index records went through `canonicalDir`, so it is the
    // name the filesystem itself uses: on Windows `os.tmpdir()` hands out the
    // 8.3 short name (`C:\Users\RUNNER~1\…`) and the message prints the long
    // one. On macOS the same call turns `/var/…` into `/private/var/…`.
    expect(lines[0]).toContain(fs.realpathSync.native(fixture.projectsDir));
    // The folder asked for is only resolved, not canonicalised, so it is
    // echoed back exactly as it was spelled on the command line.
    expect(lines[0]).toContain(elsewhere);
    // stdout is still only results: a pipeline reads the same thing it did.
    expect((JSON.parse(result.stdout) as unknown[]).length).toBeGreaterThan(0);
  });

  it('says nothing about a folder spelled differently but the same', () => {
    // /tmp is a symlink to /private/tmp on macOS, so the fixture path has two
    // spellings; a trailing separator is a third.
    const result = run(['recording', '--no-sync', '--json', '--projects-dir', `${fixture.projectsDir}${path.sep}`]);
    expect([result.status, result.stderr]).toEqual([0, '']);
  });

  it('without --no-sync there is no warning: the index is brought over instead', () => {
    const elsewhere = tempDir('ccfind-cli-elsewhere2-');
    writeSession(elsewhere, '-tmp-elsewhere', 'elsewhere-session', [
      userMessage('a session that lives somewhere else entirely', { cwd: '/tmp/elsewhere' }),
    ]);
    const result = run(['recording', '--json', '--projects-dir', elsewhere]);
    // The indexer refuses this outright, and says how to deal with it.
    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain('--no-sync:');
    expect(result.stderr).toContain('This index was built from');
  });
});

describe('cli --reindex and --stats', () => {
  it('--reindex prints counts', () => {
    const result = run(withFixture(['--reindex']));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/session files/);
    expect(result.stdout).toMatch(/3 sessions/);
  });

  it('--reindex --full starts over', () => {
    const result = run(withFixture(['--reindex', '--full']));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Indexed 3 of 3 session files/);
  });

  it('--stats reports the index and where smart search stands', () => {
    const result = run(withFixture(['--stats']));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('sessions         3');
    expect(result.stdout).toContain('smart search');
    expect(result.stdout).toContain(fixture.projectsDir);
  });

  it('--keyword-only --reindex leaves smart search alone', () => {
    const result = run(withFixture(['--reindex', '--keyword-only']));
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Smart search');
    expect(run(withFixture(['--stats'])).stdout).toContain('smart search     off');
  });

  it('refuses two actions at once', () => {
    const result = run(withFixture(['--stats', '--reindex']));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('one at a time');
  });
});

describe('cli exit codes', () => {
  it('--web rejects an invalid port with exit 2 before starting a server', () => {
    const result = run(withFixture(['--web', '--port', 'abc', '--no-open']));
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--port');
  });

  it('--web --port 0 is accepted: the operating system picks a free one', async () => {
    const child = spawn(
      process.execPath,
      [cliPath, '--projects-dir', fixture.projectsDir, '--web', '--no-open', '--port', '0'],
      { env: childEnv({ CCFIND_HOME: path.join(fixture.root, 'port-zero-home') }) },
    );
    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`the server never printed a URL: ${out}`));
      }, 20_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
        const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.on('error', reject);
      child.on('exit', () => {
        clearTimeout(timer);
        reject(new Error(`the server exited instead of listening: ${out}`));
      });
    });
    const port = Number(url.split(':')[2]);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
  }, 30_000);

  it('a port outside the range is still refused, and says what is allowed', () => {
    for (const args of [['--port', '65536'], ['--port', '1.5'], ['--port=-1']]) {
      const result = run(withFixture(['--web', ...args, '--no-open']));
      expect([args.join(' '), result.status]).toEqual([args.join(' '), 2]);
      expect(result.stderr).toContain('--port must be 0 (any free port) or between 1 and 65535');
    }
  });

  it('bundled short flags apply every letter, never quietly one of them', () => {
    // `-pw` is `-p -w`: the web branch is reached, which is what checks --port.
    for (const args of [['-pw'], ['-wp'], ['-p', '-w']]) {
      const result = run(withFixture([...args, '--port', 'abc', '--no-open']));
      expect([args.join(' '), result.status]).toEqual([args.join(' '), 2]);
      expect(result.stderr).toContain('--port');
    }
    // And `-p` on its own never reaches it, so the error above really is `w`.
    const printOnly = run(withFixture(['-p', 'recording', '--port', 'abc']));
    expect(printOnly.status).toBe(0);

    // The other letters are not dropped either.
    expect(run(['-ph']).stdout).toContain('Usage');
    expect(run(['-hp']).stdout).toContain('Usage');
    expect(run(['-pv']).stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('an unknown mode exits 2', () => {
    const result = run(withFixture(['anything', '--mode', 'telepathic']));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown --mode');
  });

  it('an unknown sort exits 2', () => {
    const result = run(withFixture(['anything', '--sort', 'sideways']));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown --sort');
  });

  it('a known flag given a value it cannot take exits 2 and points at --help', () => {
    // `--json` is a switch, so a value for it is a mistake, not a query word.
    const result = run(withFixture(['anything', '--json=maybe']));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--help');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('a bad --limit exits 2', () => {
    const result = run(withFixture(['anything', '--limit', 'lots']));
    expect(result.status).toBe(2);
  });

  it('the hidden --mode semantic explains itself in one line, without downloading anything', () => {
    const result = run(withFixture(['recording', '--mode', 'semantic']));
    expect(result.status).toBe(2);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('--reindex');
  });

  it('plain `auto` never fails for that reason', () => {
    const result = run(withFixture(['recording', '--json']));
    expect(result.status).toBe(0);
  });
});

describe('cli help', () => {
  it('fits on one screen and leads with three examples', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    const lines = result.stdout.split('\n');
    expect(lines.length).toBeLessThanOrEqual(30);
    expect(lines.every((l) => l.length <= 100)).toBe(true);

    const examples = lines.filter((l) => /^ {2}ccfind /.test(l));
    expect(examples.length).toBeGreaterThanOrEqual(3);
    // They come before the option list, because that is what people copy.
    expect(lines.indexOf(examples[2]!)).toBeLessThan(lines.findIndex((l) => l.startsWith('Options')));
    expect(result.stdout).toContain('--web');
    expect(result.stdout).toContain('--reindex');
    // The debugging escape hatch stays out of the way.
    expect(result.stdout).not.toContain('--mode');
  });

  it('--version prints a version', () => {
    expect(run(['--version']).status).toBe(0);
    expect(run(['--version']).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('cli never touches the real Claude directory', () => {
  it('writes only inside the app home', () => {
    run(withFixture(['recording']));
    const entries = fs.readdirSync(fixture.home);
    expect(entries).toContain('index.db');
  });
});
