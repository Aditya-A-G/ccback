import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSession, listFolders, status, sync } from '../src/core/api.js';
import type { Db } from '../src/core/db.js';
import { recentSessions, search } from '../src/core/search.js';
import {
  assistantMessage,
  cleanupTempDirs,
  fakeEmbedder,
  makeFixture,
  openFixtureDb,
  userMessage,
  writeSession,
} from './helpers.js';
import { embedMissing } from '../src/core/api.js';

afterAll(cleanupTempDirs);

describe('public core API', () => {
  let db: Db;
  let projectsDir: string;

  beforeAll(async () => {
    const fixture = makeFixture();
    projectsDir = fixture.projectsDir;
    writeSession(fixture.projectsDir, '-tmp-alpha', 'alpha', [
      userMessage('first question about recording videos', {
        cwd: '/tmp/alpha',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      assistantMessage('first answer about editing videos', {
        cwd: '/tmp/alpha',
        timestamp: '2026-01-01T00:01:00.000Z',
      }),
    ]);
    writeSession(fixture.projectsDir, '-tmp-beta', 'beta', [
      userMessage('a later conversation about invoices', {
        cwd: '/tmp/beta',
        timestamp: '2026-02-01T00:00:00.000Z',
      }),
    ]);
    writeSession(fixture.projectsDir, '-tmp-alpha', 'alpha2', [
      userMessage('a second session in the same folder', {
        cwd: '/tmp/alpha',
        timestamp: '2026-03-01T00:00:00.000Z',
      }),
    ]);
    db = openFixtureDb(fixture);
    await sync({ db, projectsDir });
  });

  afterAll(() => db.close());

  it('sync() reports what it did', async () => {
    const again = await sync({ db, projectsDir });
    expect(again.scannedFiles).toBe(3);
    expect(again.indexedFiles).toBe(0);
    expect(again.sessions).toBe(3);
  });

  it('getSession() returns metadata plus a page of messages', () => {
    const transcript = getSession('alpha', { db });
    expect(transcript?.session.cwd).toBe('/tmp/alpha');
    expect(transcript?.session.resumeCommand).toBe("cd '/tmp/alpha' && claude --resume 'alpha'");
    expect(transcript?.total).toBe(2);
    expect(transcript?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('getSession() paginates', () => {
    const page = getSession('alpha', { db, offset: 1, limit: 1 });
    expect(page?.messages).toHaveLength(1);
    expect(page?.messages[0]?.role).toBe('assistant');
    expect(page?.total).toBe(2);
  });

  it('getSession() returns null for an unknown id', () => {
    expect(getSession('does-not-exist', { db })).toBeNull();
  });

  it('listFolders() groups sessions by folder', () => {
    const folders = listFolders({ db });
    expect(folders.map((f) => `${f.cwd}:${f.sessionCount}`).sort()).toEqual([
      '/tmp/alpha:2',
      '/tmp/beta:1',
    ]);
    expect(folders.every((f) => f.exists === false)).toBe(true);
  });

  it('status() reports counts and available modes', async () => {
    const before = status({ db, projectsDir });
    expect(before.sessions).toBe(3);
    expect(before.messages).toBe(4);
    expect(before.availableModes).toEqual(['auto', 'keyword']);
    expect(before.embeddingModel).toBeNull();

    await embedMissing({ db, embedder: fakeEmbedder() });
    const after = status({ db, projectsDir });
    expect(after.chunksEmbedded).toBe(after.chunks);
    expect(after.embeddingModel).toBe('fake-bow-v1');
    expect(after.embeddingDims).toBe(64);
  });

  it('recentSessions() lists newest first and accepts a bare limit', () => {
    const recent = recentSessions({ db, limit: 10 });
    expect(recent.map((r) => r.sessionId)).toEqual(['alpha2', 'beta', 'alpha']);
    expect(recentSessions({ db, limit: 1 }).map((r) => r.sessionId)).toEqual(['alpha2']);
    expect(recent[0]?.snippet.text).toContain('second session');
    expect(recent[0]?.sources).toEqual([]);
  });

  it('recentSessions() can be scoped to a folder', () => {
    const recent = recentSessions({ db, cwdPrefix: '/tmp/alpha' });
    expect(recent.map((r) => r.sessionId)).toEqual(['alpha2', 'alpha']);
  });

  it('search() hydrates every documented field', async () => {
    // Without an embedder this would try to load the real model; the fake keeps
    // every test offline, and `auto` resolves to keyword here anyway.
    // Pinned to keyword so the field-by-field check does not depend on whether
    // an earlier test in this file already built embeddings.
    const results = await search({ db, query: 'recording videos', mode: 'keyword', embedder: fakeEmbedder() });
    const first = results[0]!;
    expect(first.sessionId).toBe('alpha');
    expect(first.title).toBe('first question about recording videos');
    expect(first.cwdExists).toBe(false);
    expect(first.gitBranch).toBe('main');
    expect(first.firstTs).toBe('2026-01-01T00:00:00.000Z');
    expect(first.lastTs).toBe('2026-01-01T00:01:00.000Z');
    expect(first.messageCount).toBe(2);
    expect(first.matchCount).toBeGreaterThan(0);
    expect(first.score).toBeGreaterThan(0);
    expect(first.sources).toEqual(['keyword']);
    expect(first.modeUsed).toBe('keyword');
    expect(first.snippet.text.length).toBeGreaterThan(0);
  });
});
