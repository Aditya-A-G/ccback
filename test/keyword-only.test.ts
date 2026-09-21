/**
 * Keyword-only, from the command line.
 *
 * `--keyword-only` means no model work of any kind: nothing loads the embedding
 * library, downloads a model or embeds a chunk. A user who opts out must never
 * pay a 23 MB download for it, so ranking by keywords this time is not enough —
 * the background setup has to stay off too. The tests therefore count *load
 * attempts* rather than reading the output and hoping.
 *
 * `createDefaultEmbedder` is the only door to `@huggingface/transformers` in
 * the whole tool, so a counter around it is that count. The real one is left
 * underneath, and `CCFIND_NO_MODEL=1` is still set, so no test here can reach
 * the network even if the counter were wrong.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assistantMessage,
  cleanupTempDirs,
  makeFixture,
  userMessage,
  writeSession,
  type Fixture,
} from './helpers.js';

const loads = vi.hoisted(() => [] as { cacheDir?: string | undefined }[]);

vi.mock('../src/core/embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/embedder.js')>();
  return {
    ...actual,
    createDefaultEmbedder: async (options: { cacheDir?: string | undefined } = {}) => {
      loads.push(options);
      return actual.createDefaultEmbedder(options);
    },
  };
});

const { keywordOnlyFromEnv, resolveKeywordOnly, KEYWORD_ONLY_ENV } = await import('../src/core/keyword-only.js');
const { UserError } = await import('../src/core/errors.js');
const { runCli } = await import('../src/cli.js');

afterAll(cleanupTempDirs);

let fixture: Fixture;

function freshFixture(): Fixture {
  const next = makeFixture();
  writeSession(next.projectsDir, '-tmp-alpha', 'alpha', [
    userMessage('how I will be recording the videos and how you will edit them', {
      cwd: '/tmp/alpha',
      timestamp: '2026-01-01T00:00:00.000Z',
    }),
    assistantMessage('You can record with OBS and I will edit the footage afterwards', {
      cwd: '/tmp/alpha',
      timestamp: '2026-01-01T00:05:00.000Z',
    }),
  ]);
  return next;
}

interface Run {
  code: number;
  out: string;
  err: string;
}

/**
 * `runCli` in this process, so the mocked embedder is the one it would use.
 *
 * Everything that decides where the tool reads and writes is set explicitly
 * and put back afterwards, including `process.exitCode`: leaving that behind
 * would fail the whole worker.
 */
async function cli(args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  const saved: Record<string, string | undefined> = {};
  const set = (key: string, value: string | undefined): void => {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  set('CCFIND_HOME', fixture.home);
  set(KEYWORD_ONLY_ENV, undefined);
  for (const [key, value] of Object.entries(env)) set(key, value);

  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  const previousCode = process.exitCode;

  try {
    await runCli([...args, '--projects-dir', fixture.projectsDir]);
    return { code: Number(process.exitCode ?? 0), out: out.join(''), err: err.join('') };
  } finally {
    process.exitCode = previousCode;
    outSpy.mockRestore();
    errSpy.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeEach(() => {
  loads.length = 0;
  fixture = freshFixture();
});

describe('CCFIND_KEYWORD_ONLY', () => {
  it('reads every spelling of yes and no, in any case', () => {
    for (const yes of ['1', 'true', 'TRUE', 'Yes', ' yes ']) expect(keywordOnlyFromEnv(yes), yes).toBe(true);
    for (const no of [undefined, '', '0', 'false', 'NO', 'No']) expect(keywordOnlyFromEnv(no), String(no)).toBe(false);
  });

  it('refuses anything that is neither, in one line', () => {
    for (const bad of ['maybe', 'ture', '2', 'on']) {
      let thrown: unknown;
      try {
        keywordOnlyFromEnv(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, bad).toBeInstanceOf(UserError);
      expect((thrown as Error).message.includes('\n'), bad).toBe(false);
      expect((thrown as Error).message).toContain(KEYWORD_ONLY_ENV);
    }
  });

  it('names whichever switch asked for it, the flag first', () => {
    expect(resolveKeywordOnly(false, {})).toBeNull();
    expect(resolveKeywordOnly(true, {})).toBe('--keyword-only');
    expect(resolveKeywordOnly(false, { [KEYWORD_ONLY_ENV]: 'yes' })).toBe(KEYWORD_ONLY_ENV);
    expect(resolveKeywordOnly(true, { [KEYWORD_ONLY_ENV]: '1' })).toBe('--keyword-only');
    // The variable is still read when the flag is passed, so a typo is still
    // reported rather than silently overruled.
    expect(() => resolveKeywordOnly(true, { [KEYWORD_ONLY_ENV]: 'maybe' })).toThrow(UserError);
  });
});

/** The flag and the variable have to be the same thing everywhere. */
const BOTH_WAYS: { name: string; args: string[]; env: Record<string, string> }[] = [
  { name: '--keyword-only', args: ['--keyword-only'], env: {} },
  { name: 'CCFIND_KEYWORD_ONLY=1', args: [], env: { [KEYWORD_ONLY_ENV]: '1' } },
];

describe('a scripted search', () => {
  for (const way of BOTH_WAYS) {
    it(`answers from the keyword index and loads nothing (${way.name})`, async () => {
      const run = await cli(['-p', 'recording videos', '--json', ...way.args], way.env);
      expect(run.code).toBe(0);
      const results = JSON.parse(run.out) as { sessionId: string; modeUsed: string }[];
      expect(results[0]?.sessionId).toBe('alpha');
      expect(results[0]?.modeUsed).toBe('keyword');
      expect(loads).toEqual([]);
    });
  }
});

describe('--reindex', () => {
  for (const way of BOTH_WAYS) {
    it(`builds the keyword index only, and says how to turn smart search back on (${way.name})`, async () => {
      const run = await cli(['--reindex', ...way.args], way.env);
      expect(run.code).toBe(0);
      expect(loads).toEqual([]);
      const said = run.out.split('\n').filter((line) => line.toLowerCase().includes('smart search'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('Smart search is disabled');
      expect(said[0]).toContain(way.args.length > 0 ? '--keyword-only' : KEYWORD_ONLY_ENV);
      // The sessions really were indexed; only the embedding half was skipped.
      expect(run.out).toContain('1 sessions');
    });
  }

  it('still tries to set smart search up when neither switch is set', async () => {
    const run = await cli(['--reindex']);
    expect(run.code).toBe(0);
    // One load attempt, which `CCFIND_NO_MODEL=1` then refuses — the point is
    // that the attempt is made at all on the normal path.
    expect(loads.length).toBeGreaterThan(0);
    expect(run.out).toContain('Smart search could not start');
  });

  it('leaves embeddings that are already on disk exactly where they are', async () => {
    // Embed the fixture with a fake embedder, then reindex under keyword-only.
    const { embedMissing } = await import('../src/core/api.js');
    const { fakeEmbedder } = await import('./helpers.js');
    const { openDatabase } = await import('../src/core/db.js');

    await cli(['--reindex', '--keyword-only']);
    const db = openDatabase(fixture.dbPath);
    const embedded = await embedMissing({ db, embedder: fakeEmbedder() });
    expect(embedded.embedded).toBeGreaterThan(0);
    const before = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get() as { n: number };
    db.close();

    const run = await cli(['--reindex', '--keyword-only']);
    expect(run.code).toBe(0);
    expect(loads).toEqual([]);

    const after = openDatabase(fixture.dbPath);
    const kept = after.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get() as { n: number };
    after.close();
    expect(kept.n).toBe(before.n);
    expect(kept.n).toBeGreaterThan(0);
  });
});

describe('--stats', () => {
  it('says which switch disabled smart search: the flag', async () => {
    const run = await cli(['--stats', '--keyword-only']);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/smart search\s+disabled \(--keyword-only\)/);
    expect(loads).toEqual([]);
  });

  it('says which switch disabled smart search: the variable', async () => {
    const run = await cli(['--stats'], { [KEYWORD_ONLY_ENV]: 'yes' });
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/smart search\s+disabled \(CCFIND_KEYWORD_ONLY\)/);
  });

  it('says nothing of the sort when neither switch is set', async () => {
    const run = await cli(['--stats']);
    expect(run.code).toBe(0);
    expect(run.out).not.toContain('disabled');
  });

  it('carries the same answer into --json', async () => {
    const run = await cli(['--stats', '--json'], { [KEYWORD_ONLY_ENV]: 'true' });
    const body = JSON.parse(run.out) as { keywordOnly: string | null; availableModes: string[] };
    expect(body.keywordOnly).toBe(KEYWORD_ONLY_ENV);
    expect(body.availableModes).toEqual(['keyword']);
  });

  it('takes a 0, a no and an empty value as off', async () => {
    for (const off of ['0', 'no', 'false', '']) {
      const run = await cli(['--stats'], { [KEYWORD_ONLY_ENV]: off });
      expect(run.code, off).toBe(0);
      expect(run.out, off).not.toContain('disabled (');
    }
  });
});

describe('an explicit mode alongside keyword-only', () => {
  it('is a usage error from the flag', async () => {
    const run = await cli(['--keyword-only', '--mode', 'semantic']);
    expect(run.code).toBe(2);
    expect(run.err).toContain('--keyword-only');
    expect(run.err).toContain('contradict');
  });

  it('is a usage error from the variable too', async () => {
    const run = await cli(['--mode', 'hybrid'], { [KEYWORD_ONLY_ENV]: '1' });
    expect(run.code).toBe(2);
    expect(run.err).toContain(KEYWORD_ONLY_ENV);
    expect(run.err).toContain('contradict');
    expect(run.err.trim().includes('\n')).toBe(false);
  });

  it('allows the one mode that agrees with it', async () => {
    const run = await cli(['-p', 'recording', '--json', '--mode', 'keyword'], { [KEYWORD_ONLY_ENV]: '1' });
    expect(run.code).toBe(0);
    expect(loads).toEqual([]);
  });
});

describe('a value that is neither yes nor no', () => {
  it('is one line and exit 2, before anything is searched', async () => {
    const run = await cli(['-p', 'recording'], { [KEYWORD_ONLY_ENV]: 'maybe' });
    expect(run.code).toBe(2);
    expect(run.err).toContain(KEYWORD_ONLY_ENV);
    expect(run.err.trim().includes('\n')).toBe(false);
    expect(run.out).toBe('');
  });
});

describe('the index directory', () => {
  it('is the only place any of this wrote', () => {
    // Nothing above may have created a stray file in the projects directory.
    const entries = fs.readdirSync(path.join(fixture.projectsDir, '-tmp-alpha'));
    expect(entries).toEqual(['alpha.jsonl']);
  });
});
