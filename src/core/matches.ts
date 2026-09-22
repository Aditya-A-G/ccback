/**
 * Looking inside one session.
 *
 * The session list answers "which conversation was it"; these two answer
 * "where in it". The picker uses `sessionMatches` for ←/→ stepping and
 * `getMessage` for the full-message view.
 */
import type { Db } from './db.js';
import { createDefaultEmbedder, type Embedder, isTransformersAvailable } from './embedder.js';
import { keywordMessageMatches, type MessageMatch } from './keyword.js';
import { resolveModelCacheDir } from './paths.js';
import { tiltScore } from './ranking.js';
import { sanitizeText } from './sanitize.js';
import { hasEmbeddings, semanticMessageMatches } from './semantic.js';
import { type IndexAccessOptions, resolveAutoMode, resolveDb } from './search.js';
import type { MatchOrder, MatchSnippet, ResolvedSearchMode, Role, SearchMode } from './types.js';

/** How many matches one session returns unless asked otherwise. */
export const DEFAULT_SESSION_MATCH_LIMIT = 50;

/** Rank-fusion constant, the same one session-level hybrid search uses. */
const RRF_K = 60;

export interface SessionMatchesOptions extends IndexAccessOptions {
  sessionId: string;
  /** Empty or all-punctuation returns `[]`: nothing was asked for. */
  query: string;
  /** Defaults to `auto`. */
  mode?: SearchMode | undefined;
  /** Defaults to 50. */
  limit?: number | undefined;
  /**
   * Defaults to `best`: the tilted ranking. `newest` and `oldest` are pure
   * chronology over the same matched set.
   */
  order?: MatchOrder | undefined;
  /**
   * The clock the recency tilt is measured against, as epoch milliseconds.
   * Defaults to `Date.now()`; only `best` uses it.
   */
  now?: number | undefined;
  /** Injected in tests so no model is ever loaded. */
  embedder?: Embedder | undefined;
}

/**
 * Every matching message of one session.
 *
 * `best` (the default) ranks them by how well they match, tilted towards
 * recent ones when the scores are close, so two equally good matches are shown
 * newest first. `newest` and `oldest` ignore the scores and walk the
 * conversation by its clock.
 *
 * Never throws for setup reasons: `auto` degrades to keyword, and a semantic
 * half that cannot run is simply left out.
 */
export async function sessionMatches(options: SessionMatchesOptions): Promise<MatchSnippet[]> {
  const db = resolveDb(options);
  const limit = Math.max(1, options.limit ?? DEFAULT_SESSION_MATCH_LIMIT);
  if (options.query.trim() === '') return [];

  const requested = options.mode ?? 'auto';
  const mode: ResolvedSearchMode = requested === 'auto' ? resolveAutoMode(db, options.embedder) : requested;

  const wanted = options.order ?? 'best';
  const now = options.now ?? Date.now();

  const keyword = mode === 'semantic' ? [] : keywordMessageMatches(db, options.query, options.sessionId, limit * 2);
  const semantic =
    mode === 'keyword' ? [] : await semanticHalf(db, options, limit * 2).catch(() => [] as MessageMatch[]);

  if (semantic.length === 0) return orderMatches(keyword, limit, wanted, now);
  if (keyword.length === 0) return orderMatches(semantic, limit, wanted, now);
  return orderMatches(fuse(keyword, semantic), limit, wanted, now);
}

async function semanticHalf(
  db: Db,
  options: SessionMatchesOptions,
  limit: number,
): Promise<MessageMatch[]> {
  if (!hasEmbeddings(db)) return [];
  const embedder = options.embedder ?? (await defaultEmbedder(options.appHome));
  if (embedder === null) return [];
  return semanticMessageMatches(db, options.query, embedder, options.sessionId, limit);
}

async function defaultEmbedder(appHome: string | undefined): Promise<Embedder | null> {
  if (!isTransformersAvailable()) return null;
  return createDefaultEmbedder({ cacheDir: resolveModelCacheDir(appHome) });
}

/** Reciprocal rank fusion over messages, keeping the keyword snippet's highlights. */
function fuse(keyword: MessageMatch[], semantic: MessageMatch[]): MessageMatch[] {
  const scores = new Map<number, number>();
  const snippets = new Map<number, MatchSnippet>();
  const add = (list: MessageMatch[], preferSnippet: boolean): void => {
    list.forEach((entry, index) => {
      const id = entry.snippet.messageId;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1));
      if (preferSnippet || !snippets.has(id)) snippets.set(id, entry.snippet);
    });
  };
  add(semantic, false);
  add(keyword, true);
  return [...scores.entries()].map(([id, score]) => ({ score, snippet: snippets.get(id)! }));
}

/**
 * Puts the matched messages in the asked-for order and cuts to `limit`.
 *
 * Exported for the tests that pin the two ranking promises — equal scores go
 * to the newer message, and a match more than `MAX_RECENCY_WEIGHT` times
 * better stays first however old it is — without needing a corpus that happens
 * to produce those scores.
 */
export function orderMatches(
  matches: MessageMatch[],
  limit: number,
  order: MatchOrder,
  now: number,
): MatchSnippet[] {
  const sorted = order === 'best' ? best(matches, now) : chronological(matches, order);
  return sorted.slice(0, limit).map((entry) => entry.snippet);
}

/** Best first, tilted towards recent messages, chronological between equals. */
function best(matches: MessageMatch[], now: number): MessageMatch[] {
  return matches
    .map((entry) => ({ ...entry, score: tiltScore(entry.score, entry.snippet.ts, now) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.snippet.ts !== b.snippet.ts) return a.snippet.ts < b.snippet.ts ? -1 : 1;
      return a.snippet.messageId - b.snippet.messageId;
    });
}

/** Pure chronology: by timestamp, then by message id in the same direction. */
function chronological(matches: MessageMatch[], order: 'newest' | 'oldest'): MessageMatch[] {
  const direction = order === 'newest' ? -1 : 1;
  return [...matches].sort((a, b) => {
    if (a.snippet.ts !== b.snippet.ts) return a.snippet.ts < b.snippet.ts ? -direction : direction;
    return direction * (a.snippet.messageId - b.snippet.messageId);
  });
}

/** One indexed message, whole. */
export interface FullMessage {
  messageId: number;
  sessionId: string;
  role: Role;
  ts: string;
  /** The complete indexed text, with control characters removed. */
  text: string;
}

export interface GetMessageOptions extends IndexAccessOptions {}

/**
 * The full text behind a snippet, for the picker's expand view. Null when the
 * message is not in the index (it may have been re-indexed away).
 */
export function getMessage(messageId: number, options: GetMessageOptions = {}): FullMessage | null {
  const db = resolveDb(options);
  if (!Number.isInteger(messageId)) return null;
  const row = db
    .prepare('SELECT id, session_id, role, ts, text FROM messages WHERE id = ?')
    .get(messageId) as { id: number; session_id: string; role: Role; ts: string; text: string } | undefined;
  if (!row) return null;
  return {
    messageId: row.id,
    sessionId: row.session_id,
    role: row.role,
    ts: row.ts,
    // Transcript text reaches a terminal from here, so escape sequences go.
    text: sanitizeText(row.text),
  };
}
