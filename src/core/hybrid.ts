import type { MatchSource, RankedSession, Snippet } from './types.js';

/** The usual RRF damping constant. */
export const RRF_K = 60;

export interface FusedSession {
  sessionId: string;
  score: number;
  matchCount: number;
  snippet: Snippet | null;
  sources: MatchSource[];
}

export interface RankedList {
  source: MatchSource;
  sessions: RankedSession[];
}

/**
 * Reciprocal rank fusion: `score = Σ 1 / (k + rank)` with rank starting at 1.
 *
 * The keyword snippet wins when a session appears in both lists, because it
 * carries highlights. `matchCount` takes the largest value seen.
 */
export function reciprocalRankFusion(lists: RankedList[], k: number = RRF_K, limit?: number): FusedSession[] {
  const fused = new Map<string, FusedSession>();
  const sourceOrder = new Map<string, Set<MatchSource>>();

  for (const list of lists) {
    list.sessions.forEach((session, index) => {
      const rank = index + 1;
      const contribution = 1 / (k + rank);
      const existing = fused.get(session.sessionId);
      if (!existing) {
        fused.set(session.sessionId, {
          sessionId: session.sessionId,
          score: contribution,
          matchCount: session.matchCount,
          snippet: session.snippet,
          sources: [list.source],
        });
        sourceOrder.set(session.sessionId, new Set([list.source]));
        return;
      }
      existing.score += contribution;
      const sources = sourceOrder.get(session.sessionId)!;
      // The keyword list counts messages that actually contain the terms, which
      // is the number worth showing; the semantic list cannot produce that.
      if (list.source === 'keyword') existing.matchCount = session.matchCount;
      else if (!sources.has('keyword')) {
        existing.matchCount = Math.max(existing.matchCount, session.matchCount);
      }
      // Keyword snippets carry highlights, so they are preferred.
      if (list.source === 'keyword' && session.snippet) existing.snippet = session.snippet;
      else if (!existing.snippet && session.snippet) existing.snippet = session.snippet;
      sources.add(list.source);
      existing.sources = [...sources];
    });
  }

  const results = [...fused.values()].sort((a, b) => b.score - a.score || a.sessionId.localeCompare(b.sessionId));
  return limit === undefined ? results : results.slice(0, limit);
}
