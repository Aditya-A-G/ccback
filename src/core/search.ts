import fs from 'node:fs';
import type { Db } from './db.js';
import { getSharedDatabase } from './db.js';
import { createDefaultEmbedder, type Embedder, isTransformersAvailable, INSTALL_HINT } from './embedder.js';
import { UserError } from './errors.js';
import type { SearchFilters } from './filters.js';
import { reciprocalRankFusion } from './hybrid.js';
import { keywordSearch } from './keyword.js';
import { resolveIndexPath, resolveModelCacheDir } from './paths.js';
import { tiltByRecency } from './ranking.js';
import { buildResumeCommand } from './resume.js';
import { hasEmbeddings, NO_EMBEDDINGS_HINT, semanticSearch } from './semantic.js';
import type {
  MatchSource,
  RankedSession,
  ResolvedSearchMode,
  Role,
  SearchMode,
  SessionResult,
  Snippet,
  SortOrder,
} from './types.js';

/** How many candidates each strategy contributes to hybrid fusion. */
export const HYBRID_CANDIDATES = 50;

/** Where the index lives, and which database handle to use. */
export interface IndexAccessOptions {
  /** Explicit path to `index.db`. Defaults to `<CCBACK_HOME>/index.db`. */
  dbPath?: string | undefined;
  /** Overrides `CCBACK_HOME` for this call. */
  appHome?: string | undefined;
  /** An already-open handle. Front ends that keep one connection pass this. */
  db?: Db | undefined;
}

export interface SearchOptions extends IndexAccessOptions, SearchFilters {
  /** The user's sentence. An empty or all-punctuation query returns `[]`. */
  query: string;
  /** Defaults to `auto`. */
  mode?: SearchMode | undefined;
  /** Defaults to `relevance`. */
  sort?: SortOrder | undefined;
  /** Defaults to 10. */
  limit?: number | undefined;
  /**
   * The clock the recency tilt is measured against, as epoch milliseconds.
   * Defaults to `Date.now()`; tests pass a fixed value so a ranking is
   * reproducible.
   */
  now?: number | undefined;
  /**
   * Embedder used by `semantic` and `hybrid`. Defaults to the transformers.js
   * model. Tests inject a deterministic fake.
   */
  embedder?: Embedder | undefined;
  /** Load the model from the local cache only, never over the network. */
  localOnly?: boolean | undefined;
}

/**
 * What `auto` becomes right now: `hybrid` when the index holds embeddings and
 * the embedding runtime is there, `keyword` otherwise. Asked on every search,
 * so a keyword-only install and a half-built index both behave.
 */
export function resolveAutoMode(db: Db, embedder?: Embedder | undefined): ResolvedSearchMode {
  if (!hasEmbeddings(db)) return 'keyword';
  if (embedder === undefined && !isTransformersAvailable()) return 'keyword';
  return 'hybrid';
}

/** Same matched set, newest activity first. Ties keep a stable order. */
function byRecency(results: SessionResult[]): SessionResult[] {
  return [...results].sort((a, b) => {
    if (a.lastTs === b.lastTs) return a.sessionId < b.sessionId ? -1 : 1;
    return a.lastTs < b.lastTs ? 1 : -1;
  });
}

/** Resolves the database handle for an API call. */
export function resolveDb(options: IndexAccessOptions): Db {
  if (options.db) return options.db;
  return getSharedDatabase(options.dbPath ?? resolveIndexPath(options.appHome));
}

function filtersOf(options: SearchFilters): SearchFilters {
  return {
    cwdPrefix: options.cwdPrefix,
    since: options.since,
    until: options.until,
    role: options.role,
  };
}

async function resolveEmbedder(options: SearchOptions): Promise<Embedder> {
  if (options.embedder) return options.embedder;
  if (!isTransformersAvailable()) throw new UserError(INSTALL_HINT);
  return createDefaultEmbedder({
    cacheDir: resolveModelCacheDir(options.appHome),
    localOnly: options.localOnly,
  });
}

/**
 * The one entry point every front end uses.
 *
 * `auto` (the default) picks hybrid when smart search is usable and keyword
 * otherwise, and falls back to keyword if the model turns out not to load, so
 * a search never fails because of setup. An explicitly requested `semantic` or
 * `hybrid` still throws a {@link UserError} (exit code 2) with an actionable
 * message, because the user asked for something specific.
 */
export async function search(options: SearchOptions): Promise<SessionResult[]> {
  const db = resolveDb(options);
  const requested = options.mode ?? 'auto';
  const limit = options.limit ?? 10;
  const sort = options.sort ?? 'relevance';
  const now = options.now ?? Date.now();
  const filters = filtersOf(options);

  if (options.query.trim() === '') return [];

  const mode: ResolvedSearchMode = requested === 'auto' ? resolveAutoMode(db, options.embedder) : requested;
  const lenient = requested === 'auto';

  const runKeyword = (): SessionResult[] =>
    hydrate(db, keywordSearch(db, options.query, { limit, filters }), () => ['keyword'], 'keyword');

  if (mode === 'keyword') return order(runKeyword(), sort, now, limit);

  try {
    if (mode === 'semantic') {
      requireEmbeddings(db);
      const embedder = await resolveEmbedder(options);
      const ranked = await semanticSearch(db, options.query, embedder, { limit, filters });
      return order(hydrate(db, ranked, () => ['semantic'], 'semantic'), sort, now, limit);
    }

    requireEmbeddings(db);
    const embedder = await resolveEmbedder(options);
    const keywordHits = keywordSearch(db, options.query, { limit: HYBRID_CANDIDATES, filters });
    const semanticHits = await semanticSearch(db, options.query, embedder, {
      limit: HYBRID_CANDIDATES,
      filters,
    });
    // Both halves are fused whole, and the tilt is applied to the fused
    // scores: cutting to `limit` first would leave the tilt shuffling a top-N
    // it had no say in choosing.
    const fused = reciprocalRankFusion([
      { source: 'keyword', sessions: keywordHits },
      { source: 'semantic', sessions: semanticHits },
    ]);
    const sourcesById = new Map(fused.map((f) => [f.sessionId, f.sources]));
    return order(
      hydrate(
        db,
        fused.map((f) => ({
          sessionId: f.sessionId,
          score: f.score,
          matchCount: f.matchCount,
          snippet: f.snippet,
        })),
        (id) => sourcesById.get(id) ?? ['keyword'],
        'hybrid',
      ),
      sort,
      now,
      limit,
    );
  } catch (err) {
    // Nobody asked for semantic search here; a model that will not load is a
    // reason to answer with keyword results, not to fail the search.
    if (!lenient) throw err;
    return order(runKeyword(), sort, now, limit);
  }
}

/**
 * The last step of every mode: cut to `limit` and put the rows in order.
 *
 * `recent` is pure recency over the matched set the ranking already chose, and
 * keeps the raw scores. `relevance` tilts the scores towards recent activity
 * first (see `ranking.ts`) and then cuts, so the tilt decides membership as
 * well as order.
 */
function order(results: SessionResult[], sort: SortOrder, now: number, limit: number): SessionResult[] {
  if (sort === 'recent') return byRecency(results.slice(0, limit));
  return tiltByRecency(results, now).slice(0, limit);
}

function requireEmbeddings(db: Db): void {
  if (!hasEmbeddings(db)) throw new UserError(NO_EMBEDDINGS_HINT);
}

interface SessionRow {
  id: string;
  cwd: string;
  title: string;
  git_branch: string;
  first_ts: string;
  last_ts: string;
  message_count: number;
}

/** Turns ranked session ids into fully populated results, order preserved. */
export function hydrate(
  db: Db,
  ranked: RankedSession[],
  sourcesFor: (sessionId: string) => MatchSource[],
  modeUsed: ResolvedSearchMode = 'keyword',
): SessionResult[] {
  if (ranked.length === 0) return [];
  const stmt = db.prepare(
    `SELECT id, cwd, title, git_branch, first_ts, last_ts, message_count
     FROM sessions WHERE id = ?`,
  );
  const results: SessionResult[] = [];
  for (const entry of ranked) {
    const row = stmt.get(entry.sessionId) as SessionRow | undefined;
    if (!row) continue;
    results.push({
      sessionId: row.id,
      title: row.title,
      cwd: row.cwd,
      cwdExists: folderExists(row.cwd),
      gitBranch: row.git_branch,
      firstTs: row.first_ts,
      lastTs: row.last_ts,
      messageCount: row.message_count,
      matchCount: entry.matchCount,
      score: entry.score,
      sources: sourcesFor(entry.sessionId),
      modeUsed,
      snippet: entry.snippet ?? fallbackSnippet(db, row),
      resumeCommand: buildResumeCommand(row.cwd, row.id),
    });
  }
  return results;
}

function folderExists(cwd: string): boolean {
  try {
    return fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

/** Last message of a session, so the recent list previews where each one left off. */
function fallbackSnippet(db: Db, row: SessionRow): Snippet {
  const message = db
    .prepare('SELECT id, role, ts, text FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1')
    .get(row.id) as { id: number; role: Role; ts: string; text: string } | undefined;
  if (!message) return { messageId: 0, role: 'user', ts: row.last_ts, text: '', highlights: [] };
  const text = message.text.replace(/\s+/g, ' ').trim();
  return {
    messageId: message.id,
    role: message.role,
    ts: message.ts,
    text: text.length > 240 ? `${text.slice(0, 239)}…` : text,
    highlights: [],
  };
}

export interface RecentSessionsOptions extends IndexAccessOptions, SearchFilters {
  limit?: number | undefined;
}

/**
 * The most recently active sessions, newest first. Front ends show these before
 * the user has typed anything.
 */
export function recentSessions(optionsOrLimit: RecentSessionsOptions | number = {}): SessionResult[] {
  const options: RecentSessionsOptions =
    typeof optionsOrLimit === 'number' ? { limit: optionsOrLimit } : optionsOrLimit;
  const db = resolveDb(options);
  const limit = options.limit ?? 10;
  const prefix = options.cwdPrefix;
  const rows = (
    prefix
      ? db
          .prepare(
            `SELECT id FROM sessions WHERE (cwd = ? OR substr(cwd, 1, ?) = ?)
             ORDER BY last_ts DESC LIMIT ?`,
          )
          .all(prefix, prefix.length + 1, `${prefix}/`, limit)
      : db.prepare('SELECT id FROM sessions ORDER BY last_ts DESC LIMIT ?').all(limit)
  ) as { id: string }[];
  return hydrate(
    db,
    rows.map((row) => ({ sessionId: row.id, score: 0, matchCount: 0, snippet: null })),
    () => [],
  );
}
