import type { Role } from './parser.js';

export type { Role };

/**
 * How a search is run.
 *
 * `auto` is the default everywhere: it runs `hybrid` when the index holds
 * embeddings and the embedding runtime can be loaded, and `keyword` otherwise.
 * It never fails because of a setup problem.
 */
export type SearchMode = 'auto' | 'keyword' | 'semantic' | 'hybrid';

/** What `auto` resolved to, and the only modes a result can actually come from. */
export type ResolvedSearchMode = 'keyword' | 'semantic' | 'hybrid';

/**
 * Result ordering. `relevance` is best-first; `recent` keeps the same matched
 * set and orders it by last activity, newest first.
 */
export type SortOrder = 'relevance' | 'recent';

/** Why a session matched. Hybrid results can carry both. */
export type MatchSource = 'keyword' | 'semantic';

/**
 * A piece of a message worth showing. `highlights` are `[start, end)` index
 * pairs into `text`, so each front end decides how to style them. The core
 * never returns HTML.
 */
export interface Snippet {
  /** Row id of the message the snippet came from; lets a reader jump straight to it. */
  messageId: number;
  role: Role;
  /** ISO timestamp of the message the snippet came from. */
  ts: string;
  text: string;
  highlights: [number, number][];
}

/** One session, ready to render. */
export interface SessionResult {
  sessionId: string;
  title: string;
  /** Real folder the session ran in, taken from the transcript. */
  cwd: string;
  /** False when that folder no longer exists on disk. */
  cwdExists: boolean;
  gitBranch: string;
  firstTs: string;
  lastTs: string;
  messageCount: number;
  /**
   * Messages in this session that contain **at least one** of the query terms
   * (the FTS query ORs them; semantic mode counts messages over a similarity
   * floor). It is not the number of messages containing the whole phrase, so
   * every front end says it as "N messages mention this" — see
   * `matchCountLabel`. Zero when there is no query (browsing recent sessions),
   * in which case nothing is shown at all.
   */
  matchCount: number;
  score: number;
  sources: MatchSource[];
  /** What the search actually ran as, once `auto` had been resolved. */
  modeUsed: ResolvedSearchMode;
  snippet: Snippet;
  /** `cd '<cwd>' && claude --resume <sessionId>`, POSIX-quoted. */
  resumeCommand: string;
}

/**
 * One matching message inside a single session, as returned by
 * `sessionMatches`. Identical to {@link Snippet}; named separately because the
 * picker steps through a list of these, not through sessions.
 */
export type MatchSnippet = Snippet;

/** Session metadata as stored in the index. */
export interface SessionMeta {
  sessionId: string;
  title: string;
  cwd: string;
  cwdExists: boolean;
  gitBranch: string;
  firstTs: string;
  lastTs: string;
  messageCount: number;
  filePath: string;
  resumeCommand: string;
}

/** One indexed message of a transcript. */
export interface IndexedMessage {
  id: number;
  uuid: string | null;
  role: Role;
  ts: string;
  text: string;
}

/** A ranked session produced by one retrieval strategy, before hydration. */
export interface RankedSession {
  sessionId: string;
  score: number;
  matchCount: number;
  snippet: Snippet | null;
}
