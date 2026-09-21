import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion, RRF_K } from '../src/core/hybrid.js';
import type { RankedSession, Snippet } from '../src/core/types.js';

const snippet = (text: string, highlights: [number, number][] = []): Snippet => ({
  messageId: 1,
  role: 'user',
  ts: '2026-01-01T00:00:00.000Z',
  text,
  highlights,
});

const ranked = (sessionId: string, matchCount = 1, snip: Snippet | null = null): RankedSession => ({
  sessionId,
  score: 0,
  matchCount,
  snippet: snip,
});

describe('reciprocal rank fusion (criterion 10)', () => {
  it('scores by 1/(k + rank) summed over lists', () => {
    const fused = reciprocalRankFusion([
      { source: 'keyword', sessions: [ranked('a'), ranked('b')] },
      { source: 'semantic', sessions: [ranked('b'), ranked('c')] },
    ]);
    const byId = new Map(fused.map((f) => [f.sessionId, f]));
    expect(byId.get('a')!.score).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(byId.get('b')!.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 10);
    expect(byId.get('c')!.score).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  it('puts a session that both lists agree on first', () => {
    const fused = reciprocalRankFusion([
      { source: 'keyword', sessions: [ranked('a'), ranked('b')] },
      { source: 'semantic', sessions: [ranked('b'), ranked('c')] },
    ]);
    expect(fused[0]?.sessionId).toBe('b');
  });

  it('records why each session matched', () => {
    const fused = reciprocalRankFusion([
      { source: 'keyword', sessions: [ranked('a'), ranked('b')] },
      { source: 'semantic', sessions: [ranked('b'), ranked('c')] },
    ]);
    const byId = new Map(fused.map((f) => [f.sessionId, f]));
    expect(byId.get('a')!.sources).toEqual(['keyword']);
    expect(byId.get('b')!.sources).toEqual(['keyword', 'semantic']);
    expect(byId.get('c')!.sources).toEqual(['semantic']);
  });

  it('prefers the keyword snippet, because it carries highlights', () => {
    const fused = reciprocalRankFusion([
      { source: 'semantic', sessions: [ranked('b', 1, snippet('semantic text'))] },
      { source: 'keyword', sessions: [ranked('b', 4, snippet('keyword text', [[0, 7]]))] },
    ]);
    expect(fused[0]?.snippet?.text).toBe('keyword text');
    expect(fused[0]?.matchCount).toBe(4);
  });

  it('keeps the keyword match count even when the semantic count is larger', () => {
    const fused = reciprocalRankFusion([
      { source: 'keyword', sessions: [ranked('b', 3, snippet('keyword text', [[0, 7]]))] },
      { source: 'semantic', sessions: [ranked('b', 99, snippet('semantic text'))] },
    ]);
    expect(fused[0]?.matchCount).toBe(3);
  });

  it('uses the semantic count when only semantic found the session', () => {
    const fused = reciprocalRankFusion([
      { source: 'keyword', sessions: [ranked('a', 5)] },
      { source: 'semantic', sessions: [ranked('b', 7)] },
    ]);
    expect(fused.find((f) => f.sessionId === 'b')?.matchCount).toBe(7);
  });

  it('keeps the semantic snippet when keyword has none', () => {
    const fused = reciprocalRankFusion([
      { source: 'keyword', sessions: [ranked('b', 0, null)] },
      { source: 'semantic', sessions: [ranked('b', 1, snippet('semantic text'))] },
    ]);
    expect(fused[0]?.snippet?.text).toBe('semantic text');
  });

  it('honours the limit', () => {
    const fused = reciprocalRankFusion(
      [{ source: 'keyword', sessions: [ranked('a'), ranked('b'), ranked('c')] }],
      RRF_K,
      2,
    );
    expect(fused.map((f) => f.sessionId)).toEqual(['a', 'b']);
  });

  it('handles empty lists', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([{ source: 'keyword', sessions: [] }])).toEqual([]);
  });
});
