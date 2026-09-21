import fs from 'node:fs';
import { getMeta } from './db.js';
import {
  createDefaultEmbedder,
  DEFAULT_MODEL_ID,
  type Embedder,
  INSTALL_HINT,
  isTransformersAvailable,
} from './embedder.js';
import { UserError } from './errors.js';
import { syncIndex, type SyncOptions, type SyncResult } from './indexer.js';
import {
  missingProjectsDirMessage,
  projectsDirExists,
  resolveIndexPath,
  resolveModelCacheDir,
  resolveProjectsDir,
} from './paths.js';
import { buildResumeCommand } from './resume.js';
import {
  embedMissing as embedChunks,
  type EmbedMissingOptions,
  type EmbedMissingResult,
} from './semantic.js';
import { type IndexAccessOptions, resolveDb } from './search.js';
import { type SemanticStatus, semanticStatus } from './smart.js';
import type { IndexedMessage, SearchMode, SessionMeta } from './types.js';

export interface SyncApiOptions extends IndexAccessOptions, Omit<SyncOptions, 'projectsDir'> {
  /** Defaults to `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`. */
  projectsDir?: string | undefined;
}

/**
 * Brings the index up to date with the transcripts on disk. Cheap when nothing
 * changed. Strictly read-only inside the projects directory.
 */
export async function sync(options: SyncApiOptions = {}): Promise<SyncResult> {
  const db = resolveDb(options);
  return syncIndex(db, {
    projectsDir: resolveProjectsDir(options.projectsDir),
    rebuild: options.rebuild,
    onProgress: options.onProgress,
    signal: options.signal,
  });
}

/** Meta key the indexer records the transcripts folder under. */
const PROJECTS_DIR_META = 'projects_dir';

/**
 * The transcripts folder this index was built from, or null when it is empty or
 * was built before that was recorded.
 *
 * Read-only: `sync` is the only thing that writes it. It exists so a front end
 * can say where results came from when it was told to skip the sync.
 */
export function indexedProjectsDir(options: IndexAccessOptions = {}): string | null {
  return getMeta(resolveDb(options), PROJECTS_DIR_META);
}

export interface EmbedApiOptions extends IndexAccessOptions, EmbedMissingOptions {
  /** Defaults to the transformers.js MiniLM embedder. Tests inject a fake. */
  embedder?: Embedder | undefined;
}

/**
 * Embeds every chunk that has no vector yet, in batches, reporting progress and
 * honouring an AbortSignal. Interrupting and re-running continues where it
 * stopped.
 */
export async function embedMissing(options: EmbedApiOptions = {}): Promise<EmbedMissingResult> {
  const db = resolveDb(options);
  const embedder =
    options.embedder ??
    (await (async () => {
      if (!isTransformersAvailable()) throw new UserError(INSTALL_HINT);
      return createDefaultEmbedder({ cacheDir: resolveModelCacheDir(options.appHome) });
    })());
  return embedChunks(db, embedder, {
    batchSize: options.batchSize,
    onProgress: options.onProgress,
    signal: options.signal,
  });
}

export interface GetSessionOptions extends IndexAccessOptions {
  /** First message to return. Defaults to 0. */
  offset?: number | undefined;
  /** How many messages to return. Defaults to 200. */
  limit?: number | undefined;
}

export interface SessionTranscript {
  session: SessionMeta;
  messages: IndexedMessage[];
  /** Total indexed messages in this session, ignoring pagination. */
  total: number;
  offset: number;
  limit: number;
}

/** One session with a page of its indexed messages. Returns null if unknown. */
export function getSession(sessionId: string, options: GetSessionOptions = {}): SessionTranscript | null {
  const db = resolveDb(options);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? 200);

  const row = db
    .prepare(
      `SELECT id, cwd, title, git_branch, first_ts, last_ts, message_count, file_path
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as
    | {
        id: string;
        cwd: string;
        title: string;
        git_branch: string;
        first_ts: string;
        last_ts: string;
        message_count: number;
        file_path: string;
      }
    | undefined;
  if (!row) return null;

  const total = (
    db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number }
  ).n;
  const messages = db
    .prepare('SELECT id, uuid, role, ts, text FROM messages WHERE session_id = ? ORDER BY id LIMIT ? OFFSET ?')
    .all(sessionId, limit, offset) as IndexedMessage[];

  return {
    session: {
      sessionId: row.id,
      title: row.title,
      cwd: row.cwd,
      cwdExists: directoryExists(row.cwd),
      gitBranch: row.git_branch,
      firstTs: row.first_ts,
      lastTs: row.last_ts,
      messageCount: row.message_count,
      filePath: row.file_path,
      resumeCommand: buildResumeCommand(row.cwd, row.id),
    },
    messages,
    total,
    offset,
    limit,
  };
}

export interface FolderInfo {
  cwd: string;
  sessionCount: number;
  lastTs: string;
  exists: boolean;
}

/** Distinct session folders with counts, most recently used first. */
export function listFolders(options: IndexAccessOptions = {}): FolderInfo[] {
  const db = resolveDb(options);
  const rows = db
    .prepare(
      `SELECT cwd, COUNT(*) AS n, MAX(last_ts) AS last_ts
       FROM sessions GROUP BY cwd ORDER BY last_ts DESC`,
    )
    .all() as { cwd: string; n: number; last_ts: string }[];
  return rows.map((row) => ({
    cwd: row.cwd,
    sessionCount: row.n,
    lastTs: row.last_ts ?? '',
    exists: directoryExists(row.cwd),
  }));
}

export interface IndexStatus {
  projectsDir: string;
  /** False when that directory is not on disk: a setup problem, not an empty history. */
  projectsDirExists: boolean;
  /** The one sentence every front end shows when the directory is missing. */
  projectsDirHint: string | null;
  dbPath: string;
  /** Bytes on disk for index.db (WAL sidecars not counted). */
  dbSizeBytes: number;
  sessions: number;
  messages: number;
  chunks: number;
  chunksEmbedded: number;
  /** Model id recorded in the index, or null before any embedding run. */
  embeddingModel: string | null;
  embeddingDims: number | null;
  /** True when the optional embedding dependency is installed. */
  transformersAvailable: boolean;
  /** Modes usable right now. Keyword is always available. */
  availableModes: SearchMode[];
  /** Model id the tool would download if asked to embed. */
  defaultEmbeddingModel: string;
  /** Where smart search stands: enabled, runtime present, chunks still pending. */
  semantic: SemanticStatus;
}

/** Counts and capabilities, for `stats`, the TUI header and `/api/status`. */
export function status(options: SyncApiOptions = {}): IndexStatus {
  const db = resolveDb(options);
  const dbPath = options.dbPath ?? resolveIndexPath(options.appHome);
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
              (SELECT COUNT(*) FROM messages) AS messages,
              (SELECT COUNT(*) FROM chunks)   AS chunks,
              (SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL) AS embedded`,
    )
    .get() as { sessions: number; messages: number; chunks: number; embedded: number };

  const transformersAvailable = isTransformersAvailable();
  const semanticReady = counts.embedded > 0 && transformersAvailable;
  const dims = getMeta(db, 'embedding_dims');
  const projectsDir = resolveProjectsDir(options.projectsDir);
  const dirExists = projectsDirExists(projectsDir);

  return {
    projectsDir,
    projectsDirExists: dirExists,
    projectsDirHint: dirExists ? null : missingProjectsDirMessage(projectsDir),
    dbPath,
    dbSizeBytes: fileSize(dbPath),
    sessions: counts.sessions,
    messages: counts.messages,
    chunks: counts.chunks,
    chunksEmbedded: counts.embedded,
    embeddingModel: getMeta(db, 'embedding_model'),
    embeddingDims: dims === null ? null : Number(dims),
    transformersAvailable,
    availableModes: semanticReady ? ['auto', 'keyword', 'semantic', 'hybrid'] : ['auto', 'keyword'],
    defaultEmbeddingModel: DEFAULT_MODEL_ID,
    semantic: semanticStatus({ db }),
  };
}

function directoryExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}
