/**
 * The recency tilt.
 *
 * Best match stays the primary signal: the tilt is a multiplier in `(1, 1.25]`
 * that decays with age, so it decides between sessions that fit the words about
 * equally well and can never overturn a clearly stronger match. These tests pin
 * both halves of that promise — the shape of the curve, its hard maximum, and
 * the two orderings it produces — for the session list and for the matches
 * inside a session alike.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { MessageMatch } from '../src/core/keyword.js';
import { orderMatches } from '../src/core/matches.js';
import {
  MAX_RECENCY_WEIGHT,
  RECENCY_BOOST,
  RECENCY_DECAY_DAYS,
  recencyWeight,
  sessionSortFor,
  tiltByRecency,
  tiltScore,
} from '../src/core/ranking.js';
import { search, sessionMatches, syncIndex } from '../src/core/index.js';
import type { Db } from '../src/core/db.js';
import {
  assistantMessage,
  cleanupTempDirs,
  makeFixture,
  openFixtureDb,
  userMessage,
  writeSession,
} from './helpers.js';

afterAll(cleanupTempDirs);

/** A fixed clock, so every number below is reproducible. */
const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const DAY = 86_400_000;

/** `now` minus `days`, as an ISO timestamp. */
const daysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString();

describe('recencyWeight: the curve', () => {
  it('is 1.25 today and decays towards 1 over months', () => {
    const at = (days: number): number => recencyWeight(daysAgo(days), NOW);
    expect(at(0)).toBeCloseTo(1.25, 10);
    expect(at(7)).toBeCloseTo(1.198, 3);
    expect(at(30)).toBeCloseTo(1.092, 3);
    expect(at(90)).toBeCloseTo(1.0124, 4);
    expect(at(365)).toBeCloseTo(1.0000, 4);
    // Monotonic: older is never worth more.
    const ages = [0, 1, 7, 30, 90, 365, 3650].map(at);
    expect([...ages].sort((a, b) => b - a)).toEqual(ages);
  });

  it('agrees with 1 + 0.25 · e^(−ageDays / 30), the documented formula', () => {
    for (const days of [0, 3, 17, 45, 200]) {
      const expected = 1 + RECENCY_BOOST * Math.exp(-days / RECENCY_DECAY_DAYS);
      expect(recencyWeight(daysAgo(days), NOW)).toBeCloseTo(expected, 12);
    }
  });

  it('never exceeds MAX_RECENCY_WEIGHT, which is the margin a strong match needs', () => {
    expect(MAX_RECENCY_WEIGHT).toBe(1.25);
    // The bound holds for every age, including a future timestamp (clock skew).
    for (const days of [-3650, -1, 0, 0.5, 10, 1000]) {
      const weight = recencyWeight(daysAgo(days), NOW);
      expect(weight).toBeLessThanOrEqual(MAX_RECENCY_WEIGHT);
      expect(weight).toBeGreaterThan(1);
    }
    // 1.3× is therefore always safe: the ratio the tests below rely on.
    expect(1.3).toBeGreaterThan(MAX_RECENCY_WEIGHT);
  });

  it('weighs a missing or unreadable timestamp as 1 — no boost, no penalty', () => {
    for (const ts of ['', 'not a date', 'yesterday', '2026-13-45']) {
      expect(recencyWeight(ts, NOW), ts).toBe(1);
    }
    expect(recencyWeight(daysAgo(1), Number.NaN)).toBe(1);
  });
});

describe('tiltByRecency: the session list', () => {
  const session = (id: string, score: number, days: number): { sessionId: string; score: number; lastTs: string } => ({
    sessionId: id,
    score,
    lastTs: daysAgo(days),
  });

  it('puts the newer of two equally good sessions first', () => {
    const tilted = tiltByRecency([session('older', 1, 400), session('newer', 1, 1)], NOW);
    expect(tilted.map((r) => r.sessionId)).toEqual(['newer', 'older']);
    expect(tilted[0]!.score).toBeGreaterThan(tilted[1]!.score);
  });

  it('leaves a clearly better match on top, however old it is', () => {
    // Two years older and 1.3× better: more than the curve's whole range.
    const tilted = tiltByRecency([session('new-and-vague', 1, 0), session('old-and-exact', 1.3, 730)], NOW);
    expect(tilted.map((r) => r.sessionId)).toEqual(['old-and-exact', 'new-and-vague']);
  });

  it('multiplies rather than replaces the score, and breaks ties by id', () => {
    const [first, second] = tiltByRecency([session('b', 2, 0), session('a', 2, 0)], NOW);
    expect(first!.sessionId).toBe('a');
    expect(second!.sessionId).toBe('b');
    expect(first!.score).toBeCloseTo(2 * MAX_RECENCY_WEIGHT, 10);
  });

  it('leaves a negative score alone, so recency never makes it worse', () => {
    // Semantic scores are cosine similarities with no floor: below zero, a
    // multiplier would push the newest session furthest down.
    const tilted = tiltByRecency([session('neg-new', -0.2, 0), session('neg-old', -0.1, 700)], NOW);
    expect(tilted.map((r) => r.sessionId)).toEqual(['neg-old', 'neg-new']);
    expect(tilted.map((r) => r.score)).toEqual([-0.1, -0.2]);
    expect(tiltScore(0, daysAgo(0), NOW)).toBe(0);
    expect(tiltScore(2, daysAgo(0), NOW)).toBeCloseTo(2 * MAX_RECENCY_WEIGHT, 10);
  });

  it('does not touch the list it was given', () => {
    const list = [session('a', 1, 0)];
    tiltByRecency(list, NOW);
    expect(list[0]!.score).toBe(1);
  });
});

describe('orderMatches: inside one session', () => {
  const match = (messageId: number, score: number, days: number): MessageMatch => ({
    score,
    snippet: { messageId, role: 'user', ts: daysAgo(days), text: `m${messageId}`, highlights: [] },
  });

  it('best: the newer of two equally good messages comes first', () => {
    const ordered = orderMatches([match(1, 1, 400), match(2, 1, 1)], 50, 'best', NOW);
    expect(ordered.map((m) => m.messageId)).toEqual([2, 1]);
  });

  it('best: a 1.3× stronger match stays first, two years older', () => {
    const ordered = orderMatches([match(1, 1, 0), match(2, 1.3, 730)], 50, 'best', NOW);
    expect(ordered.map((m) => m.messageId)).toEqual([2, 1]);
  });

  it('newest and oldest ignore the scores entirely', () => {
    const list = [match(1, 10, 5), match(2, 0.1, 1), match(3, 5, 400)];
    expect(orderMatches(list, 50, 'newest', NOW).map((m) => m.messageId)).toEqual([2, 1, 3]);
    expect(orderMatches(list, 50, 'oldest', NOW).map((m) => m.messageId)).toEqual([3, 1, 2]);
  });

  it('breaks a timestamp tie by message id, in the direction asked for', () => {
    const same = [match(7, 1, 3), match(9, 1, 3), match(8, 1, 3)];
    expect(orderMatches(same, 50, 'oldest', NOW).map((m) => m.messageId)).toEqual([7, 8, 9]);
    expect(orderMatches(same, 50, 'newest', NOW).map((m) => m.messageId)).toEqual([9, 8, 7]);
  });

  it('leaves negative match scores untilted too', () => {
    const ordered = orderMatches([match(1, -0.5, 0), match(2, -0.2, 700)], 50, 'best', NOW);
    expect(ordered.map((m) => m.messageId)).toEqual([2, 1]);
  });

  it('cuts to the limit after ordering, not before', () => {
    const list = [match(1, 10, 400), match(2, 1, 1)];
    expect(orderMatches(list, 1, 'newest', NOW).map((m) => m.messageId)).toEqual([2]);
    expect(orderMatches(list, 1, 'oldest', NOW).map((m) => m.messageId)).toEqual([1]);
  });
});

describe('sessionSortFor', () => {
  it('maps the picker order onto a session order', () => {
    expect(sessionSortFor('best')).toBe('relevance');
    expect(sessionSortFor('newest')).toBe('recent');
    expect(sessionSortFor('oldest')).toBe('recent');
  });
});

/** Two sessions with word-for-word identical content, days apart. */
async function twinFixture(): Promise<Db> {
  const fixture = makeFixture();
  for (const [id, days] of [
    ['twin-old', 400],
    ['twin-new', 1],
  ] as const) {
    writeSession(fixture.projectsDir, `-tmp-${id}`, id, [
      userMessage('how I will be recording the videos', { cwd: `/tmp/${id}`, timestamp: daysAgo(days) }),
      assistantMessage('recording the videos is the easy part', {
        cwd: `/tmp/${id}`,
        timestamp: daysAgo(days),
      }),
    ]);
  }
  const db = openFixtureDb(fixture);
  await syncIndex(db, { projectsDir: fixture.projectsDir });
  return db;
}

/** One old session that matches strongly, one new one that barely matches. */
async function lopsidedFixture(): Promise<Db> {
  const fixture = makeFixture();
  writeSession(fixture.projectsDir, '-tmp-old-exact', 'old-exact', [
    userMessage('recording videos, recording videos, recording the videos again', {
      cwd: '/tmp/old-exact',
      timestamp: daysAgo(730),
    }),
    assistantMessage('recording videos with OBS, then recording the videos once more', {
      cwd: '/tmp/old-exact',
      timestamp: daysAgo(730),
    }),
    userMessage('so, recording videos', { cwd: '/tmp/old-exact', timestamp: daysAgo(730) }),
  ]);
  writeSession(fixture.projectsDir, '-tmp-new-vague', 'new-vague', [
    userMessage(
      'a long note about invoices, tax, deadlines, the bank, the accountant, the quarter ' +
        'and one passing mention of videos somewhere near the end of it all',
      { cwd: '/tmp/new-vague', timestamp: daysAgo(0) },
    ),
  ]);
  const db = openFixtureDb(fixture);
  await syncIndex(db, { projectsDir: fixture.projectsDir });
  return db;
}

describe('search: the tilt, end to end', () => {
  it('multiplies the raw score by the weight, and says so in `score`', async () => {
    const db = await twinFixture();
    // `--sort recent` keeps the raw scores, so it is the baseline.
    const raw = await search({ db, query: 'recording videos', sort: 'recent', now: NOW });
    const tilted = await search({ db, query: 'recording videos', now: NOW });
    const rawById = new Map(raw.map((r) => [r.sessionId, r.score]));
    for (const result of tilted) {
      const expected = rawById.get(result.sessionId)! * recencyWeight(result.lastTs, NOW);
      expect(result.score, result.sessionId).toBeCloseTo(expected, 10);
    }
    db.close();
  });

  it('puts the newer of two identical sessions first', async () => {
    const db = await twinFixture();
    const raw = await search({ db, query: 'recording videos', sort: 'recent', now: NOW });
    // The premise: word for word the same, so the same raw score.
    expect(raw[0]!.score).toBeCloseTo(raw[1]!.score, 10);

    const tilted = await search({ db, query: 'recording videos', now: NOW });
    expect(tilted.map((r) => r.sessionId)).toEqual(['twin-new', 'twin-old']);
    db.close();
  });

  it('leaves a much better, much older session on top', async () => {
    const db = await lopsidedFixture();
    const raw = await search({ db, query: 'recording videos', sort: 'recent', now: NOW });
    const rawById = new Map(raw.map((r) => [r.sessionId, r.score]));
    // The premise the curve can never overturn: better by more than 1.3×.
    expect(rawById.get('old-exact')! / rawById.get('new-vague')!).toBeGreaterThanOrEqual(1.3);

    const tilted = await search({ db, query: 'recording videos', now: NOW });
    expect(tilted[0]!.sessionId).toBe('old-exact');
    db.close();
  });

  it("leaves `--sort recent` alone: pure recency, untilted scores", async () => {
    const db = await lopsidedFixture();
    const early = await search({ db, query: 'recording videos', sort: 'recent', now: NOW });
    // A clock two years later cannot change a recency-ordered list, or its
    // scores, because nothing on that path is weighted at all.
    const later = await search({ db, query: 'recording videos', sort: 'recent', now: NOW + 730 * DAY });
    expect(later).toEqual(early);
    expect(early.map((r) => r.sessionId)).toEqual(['new-vague', 'old-exact']);
    db.close();
  });

  it('is reproducible: the same `now` gives the same answer twice', async () => {
    const db = await lopsidedFixture();
    const first = await search({ db, query: 'recording videos', now: NOW });
    const second = await search({ db, query: 'recording videos', now: NOW });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.every((r) => typeof r.score === 'number' && Number.isFinite(r.score))).toBe(true);
    db.close();
  });
});

describe('sessionMatches: the order inside one session', () => {
  async function build(): Promise<Db> {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-one', 'one', [
      userMessage('recording videos, recording videos, recording videos', {
        cwd: '/tmp/one',
        timestamp: daysAgo(400),
      }),
      assistantMessage('a passing note about recording', { cwd: '/tmp/one', timestamp: daysAgo(200) }),
      userMessage('recording again, briefly', { cwd: '/tmp/one', timestamp: daysAgo(1) }),
    ]);
    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });
    return db;
  }

  it('walks the conversation by the clock for newest and oldest', async () => {
    const db = await build();
    const newest = await sessionMatches({ db, sessionId: 'one', query: 'recording', order: 'newest', now: NOW });
    const oldest = await sessionMatches({ db, sessionId: 'one', query: 'recording', order: 'oldest', now: NOW });
    expect(newest.map((m) => m.ts)).toEqual([...newest.map((m) => m.ts)].sort().reverse());
    expect(oldest.map((m) => m.ts)).toEqual([...oldest.map((m) => m.ts)].sort());
    expect(oldest.map((m) => m.messageId)).toEqual([...newest.map((m) => m.messageId)].reverse());
    db.close();
  });

  it('defaults to best, which is neither of those', async () => {
    const db = await build();
    const best = await sessionMatches({ db, sessionId: 'one', query: 'recording videos', now: NOW });
    // The strongest match is the oldest message, and it still leads.
    expect(best[0]!.text).toContain('recording videos');
    expect(best).toEqual(await sessionMatches({ db, sessionId: 'one', query: 'recording videos', order: 'best', now: NOW }));
    db.close();
  });
});
