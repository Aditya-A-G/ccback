import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/core/db.js';
import { syncIndex } from '../src/core/indexer.js';
import { keywordSearch, parseSnippet } from '../src/core/keyword.js';
import { search } from '../src/core/search.js';
import {
  assistantMessage,
  cleanupTempDirs,
  makeFixture,
  openFixtureDb,
  userMessage,
  writeSession,
} from './helpers.js';

afterAll(cleanupTempDirs);

describe('ranking (criterion 7)', () => {
  let db: Db;

  beforeAll(async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-good', 'good', [
      userMessage('I will record the screen, edit the footage and publish the video.', { cwd: '/tmp/good' }),
    ]);
    writeSession(fixture.projectsDir, '-tmp-spam', 'spam', [
      userMessage(`${'video '.repeat(40)}`.trim(), { cwd: '/tmp/spam' }),
    ]);
    writeSession(fixture.projectsDir, '-tmp-stem', 'stem', [
      userMessage('Yesterday I recorded the whole call on my laptop.', { cwd: '/tmp/stem' }),
    ]);
    db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });
  });

  afterAll(() => db.close());

  it('term coverage beats term repetition', () => {
    const hits = keywordSearch(db, 'record edit video');
    expect(hits[0]?.sessionId).toBe('good');
    const good = hits.find((h) => h.sessionId === 'good')!;
    const spam = hits.find((h) => h.sessionId === 'spam')!;
    expect(good.score).toBeGreaterThan(spam.score);
  });

  it('porter stemming makes "recording" find "recorded"', () => {
    const hits = keywordSearch(db, 'recording');
    expect(hits.map((h) => h.sessionId)).toContain('stem');
  });

  it('returns a snippet with highlight ranges into its own text', () => {
    const hits = keywordSearch(db, 'footage');
    const snippet = hits[0]!.snippet!;
    expect(snippet.highlights.length).toBeGreaterThan(0);
    const [start, end] = snippet.highlights[0]!;
    expect(snippet.text.slice(start, end).toLowerCase()).toBe('footage');
    expect(snippet.text).not.toContain('\u0002');
    expect(snippet.text).not.toContain('\u0003');
  });

  it('coverage still wins when the spammer spreads "video" over several messages', async () => {
    // Session score is the sum of the top 3 messages, so a spammer with three
    // separate messages gets three contributions. Worth pinning down.
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-good', 'good', [
      userMessage('I will record the screen, edit the footage and publish the video.', { cwd: '/tmp/good' }),
    ]);
    writeSession(fixture.projectsDir, '-tmp-spam', 'spam', [
      userMessage('video video video video video', { cwd: '/tmp/spam' }),
      userMessage('video video video video video', { cwd: '/tmp/spam' }),
      userMessage('video video video video video', { cwd: '/tmp/spam' }),
    ]);
    const other = openFixtureDb(fixture);
    await syncIndex(other, { projectsDir: fixture.projectsDir });
    const hits = keywordSearch(other, 'record edit video');
    expect(hits[0]?.sessionId).toBe('good');
    other.close();
  });

  it('counts matching messages per session', () => {
    const hits = keywordSearch(db, 'video');
    expect(hits.find((h) => h.sessionId === 'spam')?.matchCount).toBe(1);
  });
});

describe('hostile queries (criterion 8)', () => {
  let db: Db;

  beforeAll(async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-a', 's1', [
      userMessage('a perfectly ordinary message about videos', { cwd: '/tmp/a' }),
    ]);
    db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });
  });

  afterAll(() => db.close());

  it.each([
    '"',
    '""',
    '*',
    'foo:bar',
    'AND OR NOT',
    '-x',
    'NEAR(a b)',
    '🐕 🚀',
    '   ',
    'the and of',
    'videos"',
    'video*',
    '(((',
    'a^b',
  ])('does not throw on %j', (query) => {
    expect(() => keywordSearch(db, query)).not.toThrow();
  });

  it('returns an empty list for an empty query', async () => {
    expect(keywordSearch(db, '')).toEqual([]);
    await expect(search({ db, query: '' })).resolves.toEqual([]);
    await expect(search({ db, query: '   ' })).resolves.toEqual([]);
  });

  it('returns results for a query made only of stopwords when they exist in the text', () => {
    expect(() => keywordSearch(db, 'about a')).not.toThrow();
  });
});

describe('filters (criterion 9)', () => {
  let db: Db;

  beforeAll(async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-a-b', 'sess-ab', [
      userMessage('shared marker text', { cwd: '/a/b', timestamp: '2026-03-01T10:00:00.000Z' }),
    ]);
    writeSession(fixture.projectsDir, '-a-bc', 'sess-abc', [
      userMessage('shared marker text', { cwd: '/a/bc', timestamp: '2026-03-02T10:00:00.000Z' }),
    ]);
    writeSession(fixture.projectsDir, '-a-b-deep', 'sess-deep', [
      userMessage('shared marker text', { cwd: '/a/b/deep', timestamp: '2026-03-03T10:00:00.000Z' }),
    ]);
    writeSession(fixture.projectsDir, '-tmp-roles', 'sess-roles', [
      userMessage('shared marker asked by a human', { cwd: '/tmp/roles', timestamp: '2026-05-01T10:00:00.000Z' }),
      assistantMessage('shared marker answered by claude', {
        cwd: '/tmp/roles',
        timestamp: '2026-05-01T10:00:05.000Z',
      }),
    ]);
    db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });
  });

  afterAll(() => db.close());

  it('cwdPrefix matches the folder and anything under it, but not a sibling with the same prefix', () => {
    const hits = keywordSearch(db, 'shared marker', { limit: 50, filters: { cwdPrefix: '/a/b' } });
    expect(hits.map((h) => h.sessionId).sort()).toEqual(['sess-ab', 'sess-deep']);
  });

  it('cwdPrefix ignores a trailing slash', () => {
    const hits = keywordSearch(db, 'shared marker', { limit: 50, filters: { cwdPrefix: '/a/b/' } });
    expect(hits.map((h) => h.sessionId).sort()).toEqual(['sess-ab', 'sess-deep']);
  });

  it('since keeps only later messages', () => {
    const hits = keywordSearch(db, 'shared marker', { limit: 50, filters: { since: '2026-03-03' } });
    expect(hits.map((h) => h.sessionId).sort()).toEqual(['sess-deep', 'sess-roles']);
  });

  it('until keeps only earlier messages and covers the whole given day', () => {
    const hits = keywordSearch(db, 'shared marker', { limit: 50, filters: { until: '2026-03-02' } });
    expect(hits.map((h) => h.sessionId).sort()).toEqual(['sess-ab', 'sess-abc']);
  });

  it('since and until combine into a window', () => {
    const hits = keywordSearch(db, 'shared marker', {
      limit: 50,
      filters: { since: '2026-03-02', until: '2026-03-02' },
    });
    expect(hits.map((h) => h.sessionId)).toEqual(['sess-abc']);
  });

  it('role narrows to one side of the conversation', () => {
    const asked = keywordSearch(db, 'asked human', { limit: 50, filters: { role: 'user' } });
    expect(asked.map((h) => h.sessionId)).toEqual(['sess-roles']);
    const answeredAsUser = keywordSearch(db, 'answered claude', { limit: 50, filters: { role: 'user' } });
    expect(answeredAsUser).toEqual([]);
    const answered = keywordSearch(db, 'answered claude', { limit: 50, filters: { role: 'assistant' } });
    expect(answered.map((h) => h.sessionId)).toEqual(['sess-roles']);
  });

  it('a path containing SQL LIKE wildcards is treated literally', async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-weird', 'w1', [
      userMessage('wildcard marker', { cwd: '/tmp/a_b' }),
    ]);
    writeSession(fixture.projectsDir, '-weird2', 'w2', [
      userMessage('wildcard marker', { cwd: '/tmp/axb' }),
    ]);
    const other = openFixtureDb(fixture);
    await syncIndex(other, { projectsDir: fixture.projectsDir });
    const hits = keywordSearch(other, 'wildcard marker', { limit: 50, filters: { cwdPrefix: '/tmp/a_b' } });
    expect(hits.map((h) => h.sessionId)).toEqual(['w1']);
    other.close();
  });
});

describe('parseSnippet', () => {
  it('turns sentinel markers into ranges', () => {
    expect(parseSnippet('a \u0002bee\u0003 c \u0002dee\u0003')).toEqual({
      text: 'a bee c dee',
      highlights: [
        [2, 5],
        [8, 11],
      ],
    });
  });

  it('passes unmarked text through unchanged', () => {
    expect(parseSnippet('nothing marked')).toEqual({ text: 'nothing marked', highlights: [] });
  });
});
