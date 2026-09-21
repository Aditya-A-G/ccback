import type { Db } from './db.js';
import { buildFilterSql, type SearchFilters } from './filters.js';
import { buildFtsMatchQuery, parseQuery, quoteTerm } from './query.js';
import type { RankedSession, Role, Snippet } from './types.js';

/** Sentinel characters wrapped around matches by FTS5 snippet(), then parsed out. */
const HL_START = '\u0002';
const HL_END = '\u0003';

/** How many top messages are pulled out of FTS5 before session-level scoring. */
export const CANDIDATE_LIMIT = 500;

/** How many of a session's best messages contribute to its score. */
export const TOP_MESSAGES_PER_SESSION = 3;

export interface KeywordSearchOptions {
  limit?: number | undefined;
  filters?: SearchFilters | undefined;
}

interface CandidateRow {
  id: number;
  session_id: string;
  role: Role;
  ts: string;
  bm: number;
  snip: string;
  session_last_ts: string;
}

/**
 * BM25 keyword search over the FTS5 index.
 *
 * Each candidate message's positive BM25 score is multiplied by the number of
 * distinct query terms it contains, so a message that mentions record + edit +
 * video beats one that repeats video alone. A session scores the sum of its
 * three best messages, ties broken by recency.
 */
export function keywordSearch(
  db: Db,
  query: string,
  options: KeywordSearchOptions = {},
): RankedSession[] {
  const limit = options.limit ?? 10;
  const terms = parseQuery(query);
  const match = buildFtsMatchQuery(terms);
  if (match === '') return [];

  const filters = options.filters ?? {};
  const { sql: filterSql, params: filterParams } = buildFilterSql(filters);

  const candidates = db
    .prepare(
      `SELECT m.id AS id, m.session_id AS session_id, m.role AS role, m.ts AS ts,
              s.last_ts AS session_last_ts,
              bm25(messages_fts) AS bm,
              snippet(messages_fts, 0, '${HL_START}', '${HL_END}', '…', 20) AS snip
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN sessions s ON s.id = m.session_id
       WHERE messages_fts MATCH ?${filterSql}
       ORDER BY bm25(messages_fts)
       LIMIT ${CANDIDATE_LIMIT}`,
    )
    .all(match, ...filterParams) as CandidateRow[];

  if (candidates.length === 0) return [];

  const coverage = termCoverage(db, terms, candidates.map((c) => c.id));

  const perSession = new Map<string, { scores: number[]; best: CandidateRow; bestScore: number; lastTs: string }>();
  for (const row of candidates) {
    // bm25() is negative and more negative means better; flip it.
    const base = Math.max(0, -row.bm);
    const score = base * Math.max(1, coverage.get(row.id) ?? 1);
    const entry = perSession.get(row.session_id);
    if (!entry) {
      perSession.set(row.session_id, {
        scores: [score],
        best: row,
        bestScore: score,
        lastTs: row.session_last_ts,
      });
    } else {
      entry.scores.push(score);
      if (score > entry.bestScore) {
        entry.bestScore = score;
        entry.best = row;
      }
    }
  }

  const ranked = [...perSession.entries()]
    .map(([sessionId, entry]) => {
      const top = entry.scores.sort((a, b) => b - a).slice(0, TOP_MESSAGES_PER_SESSION);
      const score = top.reduce((sum, s) => sum + s, 0);
      return { sessionId, score, entry };
    })
    .sort((a, b) => b.score - a.score || (a.entry.lastTs < b.entry.lastTs ? 1 : -1))
    .slice(0, limit);

  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n
     FROM messages_fts
     JOIN messages m ON m.id = messages_fts.rowid
     JOIN sessions s ON s.id = m.session_id
     WHERE messages_fts MATCH ? AND m.session_id = ?${filterSql}`,
  );

  return ranked.map(({ sessionId, score, entry }) => {
    const row = countStmt.get(match, sessionId, ...filterParams) as { n: number };
    const snippet: Snippet = {
      messageId: entry.best.id,
      role: entry.best.role,
      ts: entry.best.ts,
      ...parseSnippet(entry.best.snip),
    };
    return { sessionId, score, matchCount: row.n, snippet };
  });
}

/** One matching message, with the score the strategy gave it. */
export interface MessageMatch {
  snippet: Snippet;
  score: number;
}

/**
 * Every message of one session that matches the query, best first.
 *
 * This is the per-session view the picker steps through with ←/→, so unlike
 * {@link keywordSearch} nothing is collapsed to one snippet per session.
 */
export function keywordMessageMatches(
  db: Db,
  query: string,
  sessionId: string,
  limit: number,
): MessageMatch[] {
  const terms = parseQuery(query);
  const match = buildFtsMatchQuery(terms);
  if (match === '') return [];

  const rows = db
    .prepare(
      `SELECT m.id AS id, m.role AS role, m.ts AS ts,
              bm25(messages_fts) AS bm,
              snippet(messages_fts, 0, '${HL_START}', '${HL_END}', '…', 20) AS snip
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.session_id = ?
       ORDER BY bm25(messages_fts)
       LIMIT ?`,
    )
    .all(match, sessionId, Math.max(1, limit)) as {
    id: number;
    role: Role;
    ts: string;
    bm: number;
    snip: string;
  }[];

  const coverage = termCoverage(
    db,
    terms,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    score: Math.max(0, -row.bm) * Math.max(1, coverage.get(row.id) ?? 1),
    snippet: { messageId: row.id, role: row.role, ts: row.ts, ...parseSnippet(row.snip) },
  }));
}

/**
 * Counts how many distinct query terms each candidate message contains.
 * Done through FTS5 so that stemming applies: "recording" counts as "record".
 */
function termCoverage(db: Db, terms: string[], ids: number[]): Map<number, number> {
  const coverage = new Map<number, number>();
  if (ids.length === 0 || terms.length <= 1) return coverage;
  const idsJson = JSON.stringify(ids);
  const stmt = db.prepare(
    `SELECT rowid AS id FROM messages_fts
     WHERE messages_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))`,
  );
  for (const term of terms) {
    const quoted = quoteTerm(term);
    if (quoted === '') continue;
    let rows: { id: number }[];
    try {
      rows = stmt.all(quoted, idsJson) as { id: number }[];
    } catch {
      continue;
    }
    for (const row of rows) {
      coverage.set(row.id, (coverage.get(row.id) ?? 0) + 1);
    }
  }
  return coverage;
}

/**
 * Turns a sentinel-marked FTS5 snippet into plain text plus `[start, end)`
 * highlight ranges.
 */
export function parseSnippet(marked: string): { text: string; highlights: [number, number][] } {
  const highlights: [number, number][] = [];
  let text = '';
  let index = 0;
  while (index < marked.length) {
    const start = marked.indexOf(HL_START, index);
    if (start === -1) {
      text += marked.slice(index);
      break;
    }
    text += marked.slice(index, start);
    const end = marked.indexOf(HL_END, start + 1);
    if (end === -1) {
      text += marked.slice(start + 1);
      break;
    }
    const value = marked.slice(start + 1, end);
    highlights.push([text.length, text.length + value.length]);
    text += value;
    index = end + 1;
  }
  return { text, highlights };
}
