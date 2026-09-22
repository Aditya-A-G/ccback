/**
 * The recency tilt.
 *
 * Best match is the primary signal: what a session is about decides whether it
 * is an answer at all. But two sessions that fit the words equally well are not
 * equally likely to be the one being looked for — the newer one almost always
 * is. So the final score is multiplied by a small weight that decays with age:
 *
 * ```
 * weight = 1 + 0.25 · e^(−ageDays / 30)
 * ```
 *
 * | age     | weight |
 * | ------- | ------ |
 * | today   | 1.25   |
 * | 7 days  | ≈1.198 |
 * | 30 days | ≈1.092 |
 * | 90 days | ≈1.012 |
 * | a year  | ≈1.000 |
 *
 * The weight never leaves `(1, 1.25]`, so the largest reordering it can ever
 * do is between scores within a factor of {@link MAX_RECENCY_WEIGHT} of each
 * other: anything that matches more than 1.25× better than its rival still
 * wins, however old it is. That bound is the whole point — a strong exact
 * match must never lose to something newer and vaguer.
 */

import type { MatchOrder, SortOrder } from './types.js';

/** How much a conversation from this minute is favoured: +25%. */
export const RECENCY_BOOST = 0.25;

/** e-folding time of the decay, in days. */
export const RECENCY_DECAY_DAYS = 30;

/**
 * The largest weight the curve can return, at age zero. Also the exact factor
 * by which one raw score must beat another to be safe from the tilt: a score
 * more than `MAX_RECENCY_WEIGHT` times another cannot be overtaken by it.
 */
export const MAX_RECENCY_WEIGHT = 1 + RECENCY_BOOST;

const MS_PER_DAY = 86_400_000;

/**
 * The multiplier for something that last happened at `ts`, seen from `now`.
 *
 * A missing, empty or unparseable timestamp weighs 1 — no boost, no penalty.
 * A timestamp in the future (clock skew, or a transcript written by a machine
 * running ahead) is treated as "now" rather than extrapolated, so the bound
 * above holds whatever the data says.
 */
export function recencyWeight(ts: string, now: number): number {
  if (!Number.isFinite(now)) return 1;
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return 1;
  const ageDays = Math.max(0, (now - at) / MS_PER_DAY);
  return 1 + RECENCY_BOOST * Math.exp(-ageDays / RECENCY_DECAY_DAYS);
}

/**
 * `score × weight`, but only where that means "better".
 *
 * Semantic scores are cosine similarities with no floor under them, so they can
 * be negative; multiplying a negative score by 1.25 would push the *newest*
 * session furthest down, which is the opposite of the whole idea. A score at or
 * below zero is left exactly as it was.
 */
export function tiltScore(score: number, ts: string, now: number): number {
  return score > 0 ? score * recencyWeight(ts, now) : score;
}

/** The shape the session tilt needs: a score, an age, and a stable tiebreak. */
export interface RecencyTiltable {
  sessionId: string;
  score: number;
  /** Last activity of the session, ISO. */
  lastTs: string;
}

/**
 * Applies {@link recencyWeight} to every score and re-orders best first.
 *
 * Returns copies: the caller's list is untouched, and `score` on the result is
 * the tilted one, which is what every front end shows and `--json` emits.
 */
export function tiltByRecency<T extends RecencyTiltable>(results: T[], now: number): T[] {
  return results
    .map((result) => ({ ...result, score: tiltScore(result.score, result.lastTs, now) }))
    .sort((a, b) => b.score - a.score || a.sessionId.localeCompare(b.sessionId));
}

/**
 * The session ordering one of the picker's three combined orders implies.
 *
 * `best` is the tilted ranking above. Both chronological orders list the
 * sessions by last activity: "oldest first" is about the messages inside a
 * session, not about which conversation deserves the top row.
 */
export function sessionSortFor(order: MatchOrder): SortOrder {
  return order === 'best' ? 'relevance' : 'recent';
}
