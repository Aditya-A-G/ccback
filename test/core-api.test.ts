/**
 * The core API the front ends are written against.
 *
 * `search` with a mode and a sort, `sessionMatches` for stepping through one
 * conversation, `getMessage` for the full text, and the three smart-search
 * calls. The picker and the web UI are only allowed to know about these.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/core/db.js';
import {
  enableSemantic,
  getMessage,
  recentSessions,
  resolveAutoMode,
  search,
  semanticStatus,
  sessionMatches,
  syncIndex,
  topUpEmbeddings,
} from '../src/core/index.js';
import { APP_HOME_ENV, LEGACY_APP_HOME_ENV, resolveAppHome, shortenHomePath } from '../src/core/paths.js';
import {
  aiTitle,
  appendSession,
  assistantMessage,
  cleanupTempDirs,
  fakeEmbedder,
  type Fixture,
  makeFixture,
  openFixtureDb,
  userMessage,
  writeSession,
} from './helpers.js';

afterAll(cleanupTempDirs);

const LONG_TEXT =
  'We talked at length about recording screencasts: OBS for capture, a lapel microphone for the voice, ' +
  'and a separate pass for the editing. The editing itself is where most of the time goes, so we agreed ' +
  'to cut the silences first and only then worry about captions, titles and the thumbnail.';

interface Built {
  fixture: Fixture;
  db: Db;
  file: string;
}

async function build(): Promise<Built> {
  const fixture = makeFixture();
  const file = writeSession(fixture.projectsDir, '-tmp-alpha', 'alpha', [
    aiTitle('Recording and editing videos'),
    userMessage('how I will be recording the videos', {
      cwd: '/tmp/alpha',
      timestamp: '2026-01-01T00:00:00.000Z',
    }),
    assistantMessage(LONG_TEXT, { cwd: '/tmp/alpha', timestamp: '2026-01-01T00:05:00.000Z' }),
    userMessage('and the editing? recording again tomorrow?', {
      cwd: '/tmp/alpha',
      timestamp: '2026-01-01T00:10:00.000Z',
    }),
  ]);
  writeSession(fixture.projectsDir, '-tmp-beta', 'beta', [
    aiTitle('Invoices'),
    userMessage('a much later conversation about invoices and recording expenses', {
      cwd: '/tmp/beta',
      timestamp: '2026-06-01T00:00:00.000Z',
    }),
  ]);
  const db = openFixtureDb(fixture);
  await syncIndex(db, { projectsDir: fixture.projectsDir });
  return { fixture, db, file };
}

describe('search: mode auto, sort, modeUsed', () => {
  it('auto stays keyword while there are no embeddings, and says so', async () => {
    const { db } = await build();
    expect(resolveAutoMode(db)).toBe('keyword');
    const hits = await search({ db, query: 'recording videos' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.modeUsed === 'keyword')).toBe(true);
    db.close();
  });

  it('auto becomes hybrid once embeddings exist', async () => {
    const { db } = await build();
    const embedder = fakeEmbedder();
    await enableSemantic({ db, embedder });
    expect(resolveAutoMode(db, embedder)).toBe('hybrid');
    const hits = await search({ db, query: 'recording videos', embedder });
    expect(hits.every((hit) => hit.modeUsed === 'hybrid')).toBe(true);
    db.close();
  });

  it('auto never fails because of setup: a broken embedder falls back to keyword', async () => {
    const { db } = await build();
    await enableSemantic({ db, embedder: fakeEmbedder() });
    const broken = {
      id: 'fake-bow-v1',
      dims: 64,
      embed: (): Promise<Float32Array[]> => Promise.reject(new Error('model refused to load')),
    };
    const hits = await search({ db, query: 'recording videos', embedder: broken });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.modeUsed === 'keyword')).toBe(true);
    // An explicit request for semantic still surfaces the failure.
    await expect(search({ db, query: 'recording videos', mode: 'semantic', embedder: broken })).rejects.toThrow();
    db.close();
  });

  it("sort 'recent' keeps the same matched set and orders it by last activity", async () => {
    const { db } = await build();
    const relevance = await search({ db, query: 'recording' });
    const recent = await search({ db, query: 'recording', sort: 'recent' });
    expect(recent.map((r) => r.sessionId).sort()).toEqual(relevance.map((r) => r.sessionId).sort());
    expect(recent.map((r) => r.sessionId)).toEqual(['beta', 'alpha']);
    expect(relevance[0]!.sessionId).toBe('alpha');
    db.close();
  });

  it('recentSessions carries modeUsed too, so one row type renders everywhere', async () => {
    const { db } = await build();
    expect(recentSessions({ db }).every((r) => r.modeUsed === 'keyword')).toBe(true);
    db.close();
  });
});

describe('sessionMatches', () => {
  it('returns every matching message of one session, best first', async () => {
    const { db } = await build();
    const matches = await sessionMatches({ db, sessionId: 'alpha', query: 'recording' });
    expect(matches.length).toBe(3);
    expect(new Set(matches.map((m) => m.messageId)).size).toBe(3);
    // Nothing from another session leaks in.
    const other = await sessionMatches({ db, sessionId: 'beta', query: 'recording' });
    expect(other.map((m) => m.messageId)).not.toEqual(expect.arrayContaining(matches.map((m) => m.messageId)));
    db.close();
  });

  it('highlights the matched words and carries role and timestamp', async () => {
    const { db } = await build();
    const [first] = await sessionMatches({ db, sessionId: 'alpha', query: 'recording' });
    expect(first!.highlights.length).toBeGreaterThan(0);
    const [start, end] = first!.highlights[0]!;
    expect(first!.text.slice(start, end).toLowerCase()).toContain('record');
    expect(['user', 'assistant']).toContain(first!.role);
    expect(first!.ts).toMatch(/^2026-/);
    db.close();
  });

  it('breaks ties chronologically, so stepping forward moves through the conversation', async () => {
    const { db } = await build();
    const matches = await sessionMatches({ db, sessionId: 'alpha', query: 'recording' });
    const tied = matches.filter((m, i, all) => i > 0 && all[i - 1]!.ts <= m.ts);
    expect(tied.length).toBeGreaterThan(0);
    db.close();
  });

  it('honours limit and answers an empty query with nothing', async () => {
    const { db } = await build();
    expect(await sessionMatches({ db, sessionId: 'alpha', query: 'recording', limit: 1 })).toHaveLength(1);
    expect(await sessionMatches({ db, sessionId: 'alpha', query: '   ' })).toEqual([]);
    db.close();
  });

  it('works in hybrid too, and never throws when the semantic half cannot run', async () => {
    const { db } = await build();
    const embedder = fakeEmbedder();
    await enableSemantic({ db, embedder });
    const hybrid = await sessionMatches({ db, sessionId: 'alpha', query: 'editing footage', embedder });
    expect(hybrid.length).toBeGreaterThan(0);

    const broken = {
      id: 'fake-bow-v1',
      dims: 64,
      embed: (): Promise<Float32Array[]> => Promise.reject(new Error('no model')),
    };
    const fallback = await sessionMatches({ db, sessionId: 'alpha', query: 'recording', embedder: broken });
    expect(fallback.length).toBeGreaterThan(0);
    db.close();
  });
});

describe('getMessage', () => {
  it('returns the whole message behind a snippet', async () => {
    const { db } = await build();
    const [match] = await sessionMatches({ db, sessionId: 'alpha', query: 'captions' });
    const full = getMessage(match!.messageId, { db });
    expect(full).not.toBeNull();
    expect(full!.sessionId).toBe('alpha');
    expect(full!.messageId).toBe(match!.messageId);
    expect(full!.text.length).toBeGreaterThan(match!.text.length);
    expect(full!.text).toContain('thumbnail');
    expect(['user', 'assistant']).toContain(full!.role);
    db.close();
  });

  it('returns null for a message that is not in the index', async () => {
    const { db } = await build();
    expect(getMessage(999_999, { db })).toBeNull();
    expect(getMessage(Number.NaN, { db })).toBeNull();
    db.close();
  });
});

describe('semanticStatus, enableSemantic, topUpEmbeddings', () => {
  it('starts off, with every chunk pending', async () => {
    const { db } = await build();
    const state = semanticStatus({ db, embedder: fakeEmbedder() });
    expect(state.enabled).toBe(false);
    expect(state.runtimeInstalled).toBe(true);
    expect(state.totalChunks).toBeGreaterThan(0);
    expect(state.pendingChunks).toBe(state.totalChunks);
    expect(state.downloadMb).toBe(165);
    db.close();
  });

  it('enableSemantic embeds everything and reports embed progress', async () => {
    const { db } = await build();
    const phases: string[] = [];
    await enableSemantic({
      db,
      embedder: fakeEmbedder(),
      batchSize: 1,
      onProgress: (p) => phases.push(p.phase),
    });
    expect(phases).toContain('embed');
    const after = semanticStatus({ db, embedder: fakeEmbedder() });
    expect(after.enabled).toBe(true);
    expect(after.pendingChunks).toBe(0);
    db.close();
  });

  it('is resumable: an aborted run keeps what it finished', async () => {
    const { db } = await build();
    const controller = new AbortController();
    await enableSemantic({
      db,
      embedder: fakeEmbedder(),
      batchSize: 1,
      signal: controller.signal,
      // Stop it once one batch is actually done, the way Ctrl+C or a closing
      // browser tab would.
      onProgress: (p) => {
        if ((p.done ?? 0) >= 1) controller.abort();
      },
    });
    const midway = semanticStatus({ db, embedder: fakeEmbedder() });
    expect(midway.pendingChunks).toBeGreaterThan(0);
    expect(midway.pendingChunks).toBeLessThan(midway.totalChunks);
    expect(midway.enabled).toBe(true);

    await enableSemantic({ db, embedder: fakeEmbedder() });
    expect(semanticStatus({ db, embedder: fakeEmbedder() }).pendingChunks).toBe(0);
    db.close();
  });

  it('stays off when the model cannot be loaded, rather than claiming to be building', async () => {
    const { db } = await build();
    // No injected embedder, and the suite forbids loading the real model, so
    // this is exactly the offline-first-run case.
    await enableSemantic({ db });
    const after = semanticStatus({ db });
    expect(after.enabled).toBe(false);
    expect(after.pendingChunks).toBe(after.totalChunks);
    expect(await topUpEmbeddings({ db })).toEqual({ embedded: 0 });
    db.close();
  });

  it('topUpEmbeddings does nothing at all until smart search is on', async () => {
    const { db } = await build();
    const before = semanticStatus({ db, embedder: fakeEmbedder() });
    expect(await topUpEmbeddings({ db, embedder: fakeEmbedder() })).toEqual({ embedded: 0 });
    expect(semanticStatus({ db, embedder: fakeEmbedder() }).pendingChunks).toBe(before.pendingChunks);
    db.close();
  });

  it('topUpEmbeddings embeds only what appeared since last time', async () => {
    const { db, fixture, file } = await build();
    await enableSemantic({ db, embedder: fakeEmbedder() });
    expect(await topUpEmbeddings({ db, embedder: fakeEmbedder() })).toEqual({ embedded: 0 });

    appendSession(file, [
      assistantMessage('A brand new answer about colour grading in Resolve, written today.', {
        cwd: '/tmp/alpha',
        timestamp: '2026-01-02T00:00:00.000Z',
      }),
    ]);
    const now = new Date(Date.now() + 2000);
    (await import('node:fs')).utimesSync(file, now, now);
    await syncIndex(db, { projectsDir: fixture.projectsDir });

    expect(await topUpEmbeddings({ db, embedder: fakeEmbedder() })).toEqual({ embedded: 1 });
    expect(semanticStatus({ db, embedder: fakeEmbedder() }).pendingChunks).toBe(0);
    db.close();
  });
});

describe('where the tool keeps its own files', () => {
  it('prefers CCFIND_HOME, still honours the old variable, and can be overridden', () => {
    const previous = { ...process.env };
    try {
      delete process.env[APP_HOME_ENV];
      process.env[LEGACY_APP_HOME_ENV] = '/tmp/legacy-home';
      expect(resolveAppHome()).toBe('/tmp/legacy-home');
      process.env[APP_HOME_ENV] = '/tmp/new-home';
      expect(resolveAppHome()).toBe('/tmp/new-home');
      expect(resolveAppHome('/tmp/explicit')).toBe('/tmp/explicit');
    } finally {
      process.env = previous;
    }
  });

  it('shortens a home path on posix and windows shapes', () => {
    expect(shortenHomePath('/Users/me/code/app', '/Users/me')).toBe('~/code/app');
    expect(shortenHomePath('/Users/me', '/Users/me')).toBe('~');
    expect(shortenHomePath('/Users/meandmore/app', '/Users/me')).toBe('/Users/meandmore/app');
    expect(shortenHomePath('/var/tmp/x', '/Users/me')).toBe('/var/tmp/x');
  });
});
