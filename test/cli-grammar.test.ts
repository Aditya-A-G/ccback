/**
 * The command line's grammar.
 *
 * The rule the README states is "words are always the search, everything else
 * is a flag". A word that happens to start with `-` is still a word: refusing
 * to search for "-weird" with a parser error is a confusing way to say nothing
 * went wrong. Flags this tool *does* know stay strictly validated.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitArgv, withAliasDefault } from '../src/cli.js';
import { canonicalDir } from '../src/core/index.js';
import { assistantMessage, childEnv, cleanupTempDirs, makeFixture, userMessage, writeSession } from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');
const fixture = makeFixture();

beforeAll(() => {
  if (!fs.existsSync(cliPath)) throw new Error('dist/cli.js is missing. Run "npm run build" first.');
  writeSession(fixture.projectsDir, '-tmp-weird', 'weird-session', [
    userMessage('a note about -weird dashes and --flags in prose', {
      cwd: '/tmp/weird',
      timestamp: '2026-03-01T00:00:00.000Z',
    }),
    assistantMessage('understood', { cwd: '/tmp/weird', timestamp: '2026-03-01T00:01:00.000Z' }),
  ]);
});

afterAll(cleanupTempDirs);

function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: childEnv({ CCFIND_HOME: fixture.home, ...(extraEnv as Record<string, string | undefined>) }),
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const withFixture = (args: string[]): string[] => ['--projects-dir', fixture.projectsDir, ...args];

describe('splitArgv', () => {
  it('keeps unknown dashed tokens as query words', () => {
    expect(splitArgv(['-p', '-weird'])).toEqual({ flags: ['-p'], words: ['-weird'] });
    expect(splitArgv(['--nonsense', 'x'])).toEqual({ flags: [], words: ['--nonsense', 'x'] });
  });

  it('treats everything after -- as query text, flags included', () => {
    expect(splitArgv(['-p', '--', '--json', '--sort', 'bogus'])).toEqual({
      flags: ['-p'],
      words: ['--json', '--sort', 'bogus'],
    });
  });

  it('keeps known flags and their values together, even a dashed value', () => {
    expect(splitArgv(['--sort', 'recent', 'videos'])).toEqual({
      flags: ['--sort', 'recent'],
      words: ['videos'],
    });
    expect(splitArgv(['--cwd', '-x'])).toEqual({ flags: ['--cwd', '-x'], words: [] });
    expect(splitArgv(['--sort=recent'])).toEqual({ flags: ['--sort=recent'], words: [] });
  });

  it('accepts bundled short switches but not a word that merely starts with one', () => {
    expect(splitArgv(['-pw'])).toEqual({ flags: ['-pw'], words: [] });
    expect(splitArgv(['-wat'])).toEqual({ flags: [], words: ['-wat'] });
    expect(splitArgv(['-5'])).toEqual({ flags: [], words: ['-5'] });
  });
});

describe('withAliasDefault', () => {
  it('fills in the default name for a bare --alias', () => {
    expect(withAliasDefault(['--alias'])).toEqual(['--alias', 'sf']);
    expect(withAliasDefault(['--alias', '--yes'])).toEqual(['--alias', 'sf', '--yes']);
  });

  it('never rewrites anything after --', () => {
    expect(withAliasDefault(['-p', '--', '--alias'])).toEqual(['-p', '--', '--alias']);
    expect(withAliasDefault(['--', '--alias', 'x'])).toEqual(['--', '--alias', 'x']);
  });

  it('leaves an explicit name alone', () => {
    expect(withAliasDefault(['--alias', 'qq'])).toEqual(['--alias', 'qq']);
  });
});

describe('dashed query words', () => {
  it('searches for a word starting with a dash instead of failing', () => {
    const result = run(withFixture(['-p', '-weird']));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('/tmp/weird');
  });

  it('searches for everything after -- verbatim', () => {
    const result = run(withFixture(['-p', '--', '--flags']));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('/tmp/weird');
  });

  it('still rejects a bad value for a flag it knows, quoted', () => {
    const result = run(withFixture(['anything', '--sort', 'bogus']));
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe('Unknown --sort: "bogus". Use relevance or recent.');
  });

  it('quotes an empty value so the message still makes sense', () => {
    const result = run(withFixture(['anything', '--sort', '']));
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe('Unknown --sort: "". Use relevance or recent.');
  });
});

describe('usage errors', () => {
  it('--alias with an extra word is an error, not a silent drop', () => {
    const result = run(['--alias', 'sf', 'web']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('web');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('--full without --reindex is an error', () => {
    const result = run(withFixture(['--full']));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--reindex');
  });

  it('--full with --reindex is fine', () => {
    const result = run(withFixture(['--reindex', '--full', '--keyword-only']));
    expect(result.status).toBe(0);
  });
});

describe('--stats', () => {
  it('prints JSON when asked for JSON', () => {
    const result = run(withFixture(['--stats', '--json']));
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { projectsDir: string; dbPath: string; sessions: number };
    expect(parsed.projectsDir).toBe(fixture.projectsDir);
    expect(parsed.dbPath).toContain('index.db');
    expect(parsed.sessions).toBeGreaterThanOrEqual(1);
  });

  it('still says where things live when the transcript directory is missing', () => {
    const missing = path.join(fixture.root, 'not-here');
    const result = run(['--projects-dir', missing, '--stats']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('projects dir');
    expect(result.stdout).toContain('index');
    expect(result.stdout).toContain('No Claude Code transcripts found');
  });
});

/** An ephemeral port, released again before the server is asked to take it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe('--web', () => {
  it.skipIf(process.platform === 'win32')('exits 130 when Ctrl+C ends it', async () => {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [cliPath, '--projects-dir', fixture.projectsDir, '--web', '--no-open', '--port', String(port)],
      {
        env: childEnv({ CCFIND_HOME: path.join(fixture.root, 'web-home') }),
      },
    );

    const code = await new Promise<number | null>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`server never printed its URL: ${out}`));
      }, 20_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
        if (out.includes('Ctrl-C')) child.kill('SIGINT');
      });
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });

    expect(code).toBe(130);
  }, 30_000);

  it('says on stderr when --no-sync points it at another transcripts folder', async () => {
    const home = path.join(fixture.root, 'web-mismatch-home');
    // Build an index for the fixture folder, so there is a recorded folder to
    // disagree with.
    const seeded = spawnSync(process.execPath, [cliPath, '--projects-dir', fixture.projectsDir, '--reindex'], {
      encoding: 'utf8',
      env: childEnv({ CCFIND_HOME: home }),
    });
    expect(seeded.status).toBe(0);

    const elsewhere = makeFixture();
    writeSession(elsewhere.projectsDir, '-tmp-elsewhere', 'elsewhere-session', [
      userMessage('a session that lives somewhere else entirely', { cwd: '/tmp/elsewhere' }),
    ]);

    const child = spawn(
      process.execPath,
      [
        cliPath,
        '--web',
        '--no-sync',
        '--no-open',
        '--port',
        '0',
        '--projects-dir',
        elsewhere.projectsDir,
      ],
      { env: childEnv({ CCFIND_HOME: home }) },
    );

    const stderr = await new Promise<string>((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`no warning appeared: ${err}`));
      }, 20_000);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        err += chunk;
        if (err.includes('--no-sync:')) {
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve(err);
        }
      });
      child.on('error', reject);
    });
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    // The index records the canonical spelling of the folder it was built from.
    expect(stderr).toContain(canonicalDir(fixture.projectsDir));
    expect(stderr).toContain(path.resolve(elsewhere.projectsDir));
    // Once, not on every request the page makes.
    expect(stderr.split('--no-sync:')).toHaveLength(2);
  }, 30_000);
});
