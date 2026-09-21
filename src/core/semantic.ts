import type { Db } from './db.js';
import { getMeta, setMeta } from './db.js';
import type { Embedder } from './embedder.js';
import { UserError } from './errors.js';
import { buildFilterSql, type SearchFilters } from './filters.js';
import type { RankedSession, Role, Snippet } from './types.js';

/** Target chunk size in characters. */
export const CHUNK_SIZE = 800;
/** Never produce more than this many chunks for one message. */
export const MAX_CHUNKS_PER_MESSAGE = 6;
/** Chunks shorter than this carry no signal. */
export const MIN_CHUNK_CHARS = 20;
/** Default embedding batch size. */
export const DEFAULT_BATCH_SIZE = 32;
/** Snippet length for semantic hits. */
export const SEMANTIC_SNIPPET_CHARS = 240;
/**
 * Cosine similarity a message must reach to be counted in `matchCount`.
 * Semantic search scores every message, so without a floor the count would just
 * be the session's message count.
 */
export const SEMANTIC_MATCH_THRESHOLD = 0.3;

export const NO_EMBEDDINGS_HINT =
  'Smart search has no embeddings yet.\nOpen the picker or the browser UI once and they are built in the background.';

/**
 * Splits a message into ~800 character chunks on paragraph then sentence
 * boundaries, at most 6 per message, dropping anything under 20 characters.
 */
export function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHUNK_CHARS) return [];
  if (trimmed.length <= CHUNK_SIZE) return [trimmed];

  const pieces = splitOnBoundaries(trimmed);
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current === '') {
      current = piece;
    } else if (current.length + piece.length + 1 <= CHUNK_SIZE) {
      current = `${current} ${piece}`;
    } else {
      chunks.push(current);
      current = piece;
      if (chunks.length >= MAX_CHUNKS_PER_MESSAGE) break;
    }
  }
  if (chunks.length < MAX_CHUNKS_PER_MESSAGE && current !== '') chunks.push(current);

  return chunks
    .slice(0, MAX_CHUNKS_PER_MESSAGE)
    .map((c) => c.trim())
    .filter((c) => c.length >= MIN_CHUNK_CHARS);
}

function splitOnBoundaries(text: string): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const para = paragraph.trim();
    if (para === '') continue;
    if (para.length <= CHUNK_SIZE) {
      out.push(para);
      continue;
    }
    for (const sentence of para.split(/(?<=[.!?])\s+/)) {
      const s = sentence.trim();
      if (s === '') continue;
      if (s.length <= CHUNK_SIZE) {
        out.push(s);
        continue;
      }
      for (let i = 0; i < s.length; i += CHUNK_SIZE) out.push(s.slice(i, i + CHUNK_SIZE));
    }
  }
  return out;
}

export interface EmbedProgress {
  embedded: number;
  total: number;
}

export interface EmbedMissingOptions {
  batchSize?: number | undefined;
  onProgress?: ((progress: EmbedProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface EmbedMissingResult {
  /** Chunks embedded during this call. */
  embedded: number;
  /** Chunks that needed embedding when the call started. */
  total: number;
  /** Chunks still without an embedding. */
  remaining: number;
  aborted: boolean;
  modelId: string;
  dims: number;
}

/**
 * Embeds every chunk whose embedding is NULL, in batches, committing each batch
 * so an interrupted run resumes where it stopped. If the stored model id
 * differs from `embedder.id`, all embeddings are cleared first.
 */
export async function embedMissing(
  db: Db,
  embedder: Embedder,
  options: EmbedMissingOptions = {},
): Promise<EmbedMissingResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const storedModel = getMeta(db, 'embedding_model');
  if (storedModel !== null && storedModel !== embedder.id) {
    db.prepare('UPDATE chunks SET embedding = NULL WHERE embedding IS NOT NULL').run();
  }
  setMeta(db, 'embedding_model', embedder.id);
  setMeta(db, 'embedding_dims', String(embedder.dims));
  invalidateVectorCache(db);

  const total = (db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL').get() as { n: number }).n;
  const pending = db.prepare('SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT ?');
  const update = db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?');

  let embedded = 0;
  let aborted = false;

  for (;;) {
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    const batch = pending.all(batchSize) as { id: number; text: string }[];
    if (batch.length === 0) break;

    const vectors = await embedder.embed(batch.map((row) => row.text));
    if (vectors.length !== batch.length) {
      throw new Error(`Embedder returned ${vectors.length} vectors for ${batch.length} texts`);
    }

    const write = db.transaction(() => {
      for (let i = 0; i < batch.length; i += 1) {
        update.run(toBlob(vectors[i]!), batch[i]!.id);
      }
    });
    write();

    embedded += batch.length;
    options.onProgress?.({ embedded, total });
  }

  setMeta(db, 'embedding_dims', String(embedder.dims));
  invalidateVectorCache(db);
  const remaining = (db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL').get() as { n: number }).n;
  return { embedded, total, remaining, aborted, modelId: embedder.id, dims: embedder.dims };
}

/** Float32 little-endian blob, as stored in `chunks.embedding`. */
export function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

interface VectorMatrix {
  signature: string;
  dims: number;
  count: number;
  data: Float32Array;
  chunkIds: Int32Array;
  messageIds: Int32Array;
  sessionIds: string[];
}

const matrixCache = new WeakMap<object, VectorMatrix>();

/** Drops the cached vector matrix for this database handle. */
export function invalidateVectorCache(db: Db): void {
  matrixCache.delete(db as unknown as object);
}

function signatureOf(db: Db): string {
  const row = db
    .prepare('SELECT COUNT(*) AS n, IFNULL(MAX(id), 0) AS maxId FROM chunks WHERE embedding IS NOT NULL')
    .get() as { n: number; maxId: number };
  // Counting is not enough on its own: carrying embeddings over a re-index can
  // leave the count and the highest id identical while every row id moved, so
  // the file's own change counter is part of the signature.
  const dataVersion = (db.pragma('data_version', { simple: true }) as number | undefined) ?? 0;
  return `${getMeta(db, 'embedding_model') ?? ''}|${row.n}|${row.maxId}|${dataVersion}`;
}

/** Loads every embedded chunk into one contiguous Float32Array, cached per handle. */
export function loadVectorMatrix(db: Db): VectorMatrix {
  const signature = signatureOf(db);
  const cached = matrixCache.get(db as unknown as object);
  if (cached && cached.signature === signature) return cached;

  const rows = db
    .prepare(
      'SELECT id, message_id, session_id, embedding FROM chunks WHERE embedding IS NOT NULL ORDER BY id',
    )
    .all() as { id: number; message_id: number; session_id: string; embedding: Buffer }[];

  const dims = rows.length > 0 ? rows[0]!.embedding.byteLength / 4 : 0;
  const data = new Float32Array(rows.length * dims);
  const chunkIds = new Int32Array(rows.length);
  const messageIds = new Int32Array(rows.length);
  const sessionIds: string[] = new Array(rows.length);

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const vec = new Float32Array(
      row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength),
    );
    data.set(vec.subarray(0, dims), i * dims);
    chunkIds[i] = row.id;
    messageIds[i] = row.message_id;
    sessionIds[i] = row.session_id;
  }

  const matrix: VectorMatrix = { signature, dims, count: rows.length, data, chunkIds, messageIds, sessionIds };
  matrixCache.set(db as unknown as object, matrix);
  return matrix;
}

export interface SemanticSearchOptions {
  limit?: number | undefined;
  filters?: SearchFilters | undefined;
}

/** True when at least one chunk has an embedding. */
export function hasEmbeddings(db: Db): boolean {
  const row = db.prepare('SELECT 1 AS ok FROM chunks WHERE embedding IS NOT NULL LIMIT 1').get() as
    | { ok: number }
    | undefined;
  return row !== undefined;
}

/**
 * Brute-force cosine similarity over every embedded chunk (vectors are
 * normalised, so a dot product is the cosine). A message scores its best chunk;
 * a session scores the mean of its three best messages.
 */
export async function semanticSearch(
  db: Db,
  query: string,
  embedder: Embedder,
  options: SemanticSearchOptions = {},
): Promise<RankedSession[]> {
  if (query.trim() === '') return [];
  if (!hasEmbeddings(db)) throw new UserError(NO_EMBEDDINGS_HINT);

  const matrix = loadVectorMatrix(db);
  if (matrix.count === 0 || matrix.dims === 0) throw new UserError(NO_EMBEDDINGS_HINT);

  const [queryVector] = await embedder.embed([query]);
  if (!queryVector) return [];
  if (queryVector.length !== matrix.dims) {
    throw new UserError(
      `Embedding model changed (index has ${matrix.dims} dims, model produces ${queryVector.length}).\n` +
        'They are rebuilt in the background next time you open the picker or the browser UI.',
    );
  }

  const allowed = allowedChunkIds(db, options.filters ?? {});

  const { data, dims, count } = matrix;
  const bestPerMessage = new Map<number, { score: number; chunkIndex: number }>();
  for (let i = 0; i < count; i += 1) {
    if (allowed && !allowed.has(matrix.chunkIds[i]!)) continue;
    let dot = 0;
    const offset = i * dims;
    for (let j = 0; j < dims; j += 1) dot += data[offset + j]! * queryVector[j]!;
    const messageId = matrix.messageIds[i]!;
    const existing = bestPerMessage.get(messageId);
    if (!existing || dot > existing.score) bestPerMessage.set(messageId, { score: dot, chunkIndex: i });
  }

  const perSession = new Map<string, { scores: number[]; best: { score: number; chunkIndex: number } }>();
  for (const [messageId, hit] of bestPerMessage) {
    void messageId;
    const sessionId = matrix.sessionIds[hit.chunkIndex]!;
    const entry = perSession.get(sessionId);
    if (!entry) {
      perSession.set(sessionId, { scores: [hit.score], best: hit });
    } else {
      entry.scores.push(hit.score);
      if (hit.score > entry.best.score) entry.best = hit;
    }
  }

  const limit = options.limit ?? 10;
  const ranked = [...perSession.entries()]
    .map(([sessionId, entry]) => {
      const sorted = entry.scores.sort((a, b) => b - a);
      const top = sorted.slice(0, 3);
      const score = top.reduce((sum, s) => sum + s, 0) / top.length;
      const matchCount = Math.max(1, sorted.filter((s) => s >= SEMANTIC_MATCH_THRESHOLD).length);
      return { sessionId, score, matchCount, best: entry.best };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const chunkStmt = db.prepare(
    `SELECT c.text AS text, m.id AS message_id, m.role AS role, m.ts AS ts
     FROM chunks c JOIN messages m ON m.id = c.message_id WHERE c.id = ?`,
  );

  return ranked.map((entry) => {
    const chunkId = matrix.chunkIds[entry.best.chunkIndex]!;
    const row = chunkStmt.get(chunkId) as { text: string; message_id: number; role: Role; ts: string } | undefined;
    const snippet: Snippet | null = row
      ? { messageId: row.message_id, role: row.role, ts: row.ts, text: truncate(row.text, SEMANTIC_SNIPPET_CHARS), highlights: [] }
      : null;
    return { sessionId: entry.sessionId, score: entry.score, matchCount: entry.matchCount, snippet };
  });
}

/**
 * The messages of one session ranked by meaning, best first.
 *
 * Reads that session's chunks directly instead of the process-wide matrix:
 * one session is a handful of vectors, and this runs while somebody is
 * stepping through matches.
 */
export async function semanticMessageMatches(
  db: Db,
  query: string,
  embedder: Embedder,
  sessionId: string,
  limit: number,
): Promise<{ snippet: Snippet; score: number }[]> {
  if (query.trim() === '') return [];
  const rows = db
    .prepare(
      `SELECT c.text AS text, c.embedding AS embedding, m.id AS message_id, m.role AS role, m.ts AS ts
       FROM chunks c JOIN messages m ON m.id = c.message_id
       WHERE c.session_id = ? AND c.embedding IS NOT NULL`,
    )
    .all(sessionId) as {
    text: string;
    embedding: Buffer;
    message_id: number;
    role: Role;
    ts: string;
  }[];
  if (rows.length === 0) return [];

  const [queryVector] = await embedder.embed([query]);
  if (!queryVector) return [];

  const best = new Map<number, { snippet: Snippet; score: number }>();
  for (const row of rows) {
    const vec = new Float32Array(
      row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength),
    );
    // A stale vector from another model is skipped, not a reason to throw:
    // this view is a convenience on top of results the user already has.
    if (vec.length !== queryVector.length) continue;
    let dot = 0;
    for (let i = 0; i < vec.length; i += 1) dot += vec[i]! * queryVector[i]!;
    const existing = best.get(row.message_id);
    if (existing && existing.score >= dot) continue;
    best.set(row.message_id, {
      score: dot,
      snippet: {
        messageId: row.message_id,
        role: row.role,
        ts: row.ts,
        text: truncate(row.text, SEMANTIC_SNIPPET_CHARS),
        highlights: [],
      },
    });
  }

  return [...best.values()]
    .filter((entry) => entry.score >= SEMANTIC_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

/** Returns null when no filter narrows anything, otherwise the chunk ids still in play. */
function allowedChunkIds(db: Db, filters: SearchFilters): Set<number> | null {
  const { sql, params } = buildFilterSql(filters, 'm', 's');
  if (sql === '') return null;
  const rows = db
    .prepare(
      `SELECT c.id AS id FROM chunks c
       JOIN messages m ON m.id = c.message_id
       JOIN sessions s ON s.id = c.session_id
       WHERE c.embedding IS NOT NULL${sql}`,
    )
    .all(...params) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
