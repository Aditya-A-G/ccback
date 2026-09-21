import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Db } from './db.js';
import { getMeta, rebuildDatabase, setMeta } from './db.js';
import { UserError } from './errors.js';
import { chunkHash } from './hash.js';
import { parseSessionFile, sessionIdFromPath } from './parser.js';
import { missingProjectsDirMessage, projectsDirExists } from './paths.js';
import { chunkText, invalidateVectorCache } from './semantic.js';
import { isValidSessionId } from './session-id.js';

/** Progress reported while syncing. */
export interface SyncProgress {
  phase: 'scan' | 'index' | 'prune';
  /** Files processed so far in this phase. */
  current: number;
  /** Total files this phase will touch (0 while scanning). */
  total: number;
  /** Absolute path of the file being handled, when relevant. */
  file?: string;
}

export interface SyncOptions {
  /** Root that holds `<encoded-cwd>/<sessionId>.jsonl`. */
  projectsDir: string;
  /** Drop the whole index before syncing. */
  rebuild?: boolean | undefined;
  onProgress?: ((progress: SyncProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface SyncResult {
  /** Session files found on disk. */
  scannedFiles: number;
  /** Files parsed because they were new or changed. */
  indexedFiles: number;
  /** Files whose (mtime, size) were unchanged. */
  skippedFiles: number;
  /** Files that vanished from disk and were pruned from the index. */
  removedFiles: number;
  /**
   * Files tracked but not searchable: nothing indexable in them, an unsafe
   * session id, or a duplicate id another file owns. Counted by state, not by
   * write, so two runs over an unchanged disk report the same number.
   */
  skippedSessions: number;
  /**
   * Files whose parse threw (unreadable, vanished mid-read). They are left
   * unrecorded so the next sync retries them, counted once per run, and
   * reported on stderr.
   */
  failedFiles: number;
  /** Sessions in the index after the sync. */
  sessions: number;
  /** Messages in the index after the sync. */
  messages: number;
  /** Chunks in the index after the sync. */
  chunks: number;
  durationMs: number;
  /** True when an AbortSignal stopped the sync early. */
  aborted: boolean;
}

interface FileRow {
  path: string;
  session_id: string | null;
  mtime_ms: number;
  size: number;
  state: FileState;
}

/**
 * Why a tracked file holds no searchable session.
 *
 * `empty` and `invalid` are final for that (mtime, size); `duplicate` is not —
 * the same file becomes the owner of its session id the moment the file that
 * beat it disappears or stops yielding a session, so it is re-examined every
 * sync.
 */
export type FileState = 'indexed' | 'empty' | 'duplicate' | 'invalid';

interface Candidate {
  path: string;
  mtimeMs: number;
  size: number;
  sessionId: string;
  /** False when the file name is not a safe session id. */
  valid: boolean;
}

/**
 * Lists session transcripts. Only files at exactly
 * `<projectsDir>/<encoded-cwd>/<sessionId>.jsonl` count, which is what keeps
 * `<sessionId>/subagents/*.jsonl` out of the index: we never recurse deeper.
 */
export async function listSessionFiles(projectsDir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, entry.name);
    let inner: fs.Dirent[];
    try {
      inner = await fsp.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of inner) {
      // Anything that is not a plain .jsonl file at this depth is ignored,
      // including the `<sessionId>/` directories that hold subagent transcripts.
      if (!file.isFile()) continue;
      if (!file.name.endsWith('.jsonl')) continue;
      files.push(path.join(projectDir, file.name));
    }
  }
  files.sort();
  return files;
}

/** Meta key remembering which transcripts folder an index was built from. */
const PROJECTS_DIR_META = 'projects_dir';

/**
 * One index belongs to one transcripts folder. Syncing it against a different
 * folder would look like "every session was deleted" and prune the lot,
 * embeddings included, so that is refused rather than done quietly.
 */
function assertSameProjectsDir(db: Db, projectsDir: string): void {
  const root = canonicalDir(projectsDir);
  let indexedRoot = getMeta(db, PROJECTS_DIR_META);
  if (indexedRoot === null) {
    // Index from before this was recorded: the folder is two levels above any
    // file it holds (<root>/<encoded-cwd>/<id>.jsonl). Always inferred, never
    // assumed, or pointing at an ancestor such as ~ would slip through.
    const row = db.prepare('SELECT path FROM files LIMIT 1').get() as { path: string } | undefined;
    if (row) indexedRoot = path.dirname(path.dirname(row.path));
  }
  if (indexedRoot !== null && !sameDirectory(indexedRoot, root)) {
    throw new UserError(
      `This index was built from ${indexedRoot}, not ${root}. ` +
        'Set CCFIND_HOME to keep a separate index for that folder, or run with --reindex --full to switch this one over.',
    );
  }
  if (indexedRoot === null) setMeta(db, PROJECTS_DIR_META, root);
}

/** Symlinks resolved where possible, so `/tmp/x` and `/private/tmp/x` compare equal. */
function canonicalDir(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Two spellings of one folder are the same folder: a symlinked `~/.claude`, or
 * different letter case on a case-insensitive disk. Identity is decided by
 * device and inode; text comparison is only the fallback when one side is gone.
 */
function sameDirectory(a: string, b: string): boolean {
  const left = canonicalDir(a);
  const right = canonicalDir(b);
  if (left === right) return true;
  try {
    const sa = fs.statSync(left);
    const sb = fs.statSync(right);
    return sa.ino === sb.ino && sa.dev === sb.dev && sa.ino !== 0;
  } catch {
    return false;
  }
}

/**
 * Brings the index in line with the transcripts on disk.
 *
 * Unchanged files (same mtime and size) are not reopened. A new or changed file
 * has its session, messages, FTS rows and chunks deleted and rebuilt inside one
 * transaction. Files that disappeared are pruned. Nothing is ever written
 * inside `projectsDir`.
 */
export async function syncIndex(db: Db, options: SyncOptions): Promise<SyncResult> {
  const started = Date.now();
  // A directory that is not there is a setup mistake, not an empty history.
  if (!projectsDirExists(options.projectsDir)) {
    throw new UserError(missingProjectsDirMessage(options.projectsDir));
  }
  if (options.rebuild) rebuildDatabase(db);
  assertSameProjectsDir(db, options.projectsDir);

  const files = await listSessionFiles(options.projectsDir);
  options.onProgress?.({ phase: 'scan', current: files.length, total: files.length });

  // Stat everything before indexing anything: which file owns a session id that
  // appears twice depends on all of them, and the answer must not depend on the
  // order we happen to walk in.
  const candidates: Candidate[] = [];
  for (const filePath of files) {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      continue;
    }
    const sessionId = sessionIdFromPath(filePath);
    candidates.push({
      path: filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sessionId,
      valid: isValidSessionId(sessionId),
    });
  }

  // The same session id in two project folders: the candidates are ranked, most
  // recently modified first and ties broken by path so two runs always agree,
  // and the first one that actually yields a session owns the rows. Ranking is
  // not the same as owning: a newer file that cannot be read, or holds nothing,
  // must not hide the readable older one behind it.
  const ranked = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (!candidate.valid) continue;
    const group = ranked.get(candidate.sessionId);
    if (group) group.push(candidate);
    else ranked.set(candidate.sessionId, [candidate]);
  }
  for (const group of ranked.values()) {
    group.sort((a, b) => (a.mtimeMs === b.mtimeMs ? (a.path < b.path ? -1 : 1) : b.mtimeMs - a.mtimeMs));
  }

  const known = new Map<string, FileRow>();
  for (const row of db.prepare('SELECT path, session_id, mtime_ms, size, state FROM files').all() as FileRow[]) {
    known.set(row.path, row);
  }

  const insertMessage = db.prepare(
    'INSERT INTO messages(session_id, uuid, role, ts, text) VALUES (?, ?, ?, ?, ?)',
  );
  const insertChunk = db.prepare(
    'INSERT INTO chunks(message_id, session_id, text, text_hash, embedding) VALUES (?, ?, ?, ?, ?)',
  );
  const carryOverRows = db.prepare(
    'SELECT text_hash AS hash, embedding FROM chunks WHERE session_id = ? AND embedding IS NOT NULL',
  );
  const insertSession = db.prepare(
    `INSERT INTO sessions(id, cwd, title, git_branch, first_ts, last_ts, message_count, file_path)
     VALUES (@id, @cwd, @title, @gitBranch, @firstTs, @lastTs, @messageCount, @filePath)
     ON CONFLICT(id) DO UPDATE SET
       cwd=excluded.cwd, title=excluded.title, git_branch=excluded.git_branch,
       first_ts=excluded.first_ts, last_ts=excluded.last_ts,
       message_count=excluded.message_count, file_path=excluded.file_path`,
  );
  const upsertFile = db.prepare(
    `INSERT INTO files(path, session_id, mtime_ms, size, state) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       session_id=excluded.session_id, mtime_ms=excluded.mtime_ms, size=excluded.size,
       state=excluded.state`,
  );
  const deleteChunks = db.prepare('DELETE FROM chunks WHERE session_id = ?');
  const deleteMessages = db.prepare('DELETE FROM messages WHERE session_id = ?');
  const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
  const deleteFile = db.prepare('DELETE FROM files WHERE path = ?');
  const sessionOwnedBy = db.prepare('SELECT 1 AS ok FROM sessions WHERE id = ? AND file_path = ?');

  /** True when the rows for `sessionId` are the ones this file put there. */
  const owns = (sessionId: string, filePath: string): boolean =>
    sessionOwnedBy.get(sessionId, filePath) !== undefined;

  const purgeSession = (sessionId: string): void => {
    deleteChunks.run(sessionId);
    deleteMessages.run(sessionId); // trigger keeps messages_fts in step
    deleteSession.run(sessionId);
  };

  /**
   * The embeddings a session already has, keyed by chunk digest.
   *
   * A session that gained one message re-parses whole, so without this every
   * chunk it had would come back with a NULL embedding and need embedding
   * again. The same text can appear twice in one session, so each hash keeps a
   * list and every carried-over vector is used at most once.
   */
  const takeCarryOver = (sessionId: string): Map<string, Buffer[]> => {
    const carried = new Map<string, Buffer[]>();
    for (const row of carryOverRows.all(sessionId) as { hash: string; embedding: Buffer }[]) {
      if (row.hash === '') continue;
      const list = carried.get(row.hash);
      if (list) list.push(row.embedding);
      else carried.set(row.hash, [row.embedding]);
    }
    return carried;
  };

  let indexedFiles = 0;
  let skippedFiles = 0;
  let removedFiles = 0;
  let skippedSessions = 0;
  let failedFiles = 0;
  let aborted = false;
  let processed = 0;

  const seen = new Set<string>();
  const resolved = new Set<string>();

  /** Records a file that carries no searchable session, without touching rows. */
  const recordSkipped = (candidate: Candidate, state: FileState): void => {
    const apply = db.transaction(() => {
      upsertFile.run(candidate.path, null, candidate.mtimeMs, candidate.size, state);
    });
    apply.immediate();
  };

  const isUnchanged = (candidate: Candidate, previous: FileRow | undefined): previous is FileRow =>
    previous !== undefined && previous.mtime_ms === candidate.mtimeMs && previous.size === candidate.size;

  /**
   * Parses one candidate and writes what it found. Returns whether it yielded a
   * session, or `null` when the parse threw.
   */
  const indexCandidate = async (candidate: Candidate, previous: FileRow | undefined): Promise<boolean | null> => {
    const filePath = candidate.path;
    const sessionId = candidate.sessionId;
    options.onProgress?.({ phase: 'index', current: processed, total: candidates.length, file: filePath });

    // Parse outside the transaction (it is async), buffering into staged rows,
    // then apply everything atomically.
    const staged: { uuid: string; role: string; ts: string; text: string }[] = [];
    let meta;
    try {
      meta = await parseSessionFile(filePath, {
        sessionId,
        onMessage: (m) => staged.push(m),
      });
    } catch {
      // A parse that threw proved nothing. Leaving the file unrecorded is what
      // makes the next sync try again instead of treating it as done.
      failedFiles += 1;
      return null;
    }

    const apply = db.transaction(() => {
      // Read the vectors before the rows that hold them are deleted.
      const carried = meta ? takeCarryOver(sessionId) : new Map<string, Buffer[]>();
      if (previous?.session_id && previous.session_id !== sessionId) purgeSession(previous.session_id);
      // Rows this file did not put there belong to another copy of the same
      // session id: a file that turns out to hold nothing must not delete them.
      if (meta || owns(sessionId, filePath)) purgeSession(sessionId);
      if (meta) {
        for (const m of staged) {
          const info = insertMessage.run(sessionId, m.uuid, m.role, m.ts, m.text);
          const messageId = Number(info.lastInsertRowid);
          for (const chunk of chunkText(m.text)) {
            const hash = chunkHash(chunk);
            const reusable = carried.get(hash);
            const embedding = reusable && reusable.length > 0 ? reusable.shift()! : null;
            insertChunk.run(messageId, sessionId, chunk, hash, embedding);
          }
        }
        insertSession.run({
          id: sessionId,
          cwd: meta.cwd,
          title: meta.title,
          gitBranch: meta.gitBranch,
          firstTs: meta.firstTs,
          lastTs: meta.lastTs,
          messageCount: meta.messageCount,
          filePath,
        });
      }
      // A file that parsed cleanly but holds nothing indexable is recorded so
      // it is not re-parsed on every sync.
      upsertFile.run(filePath, meta ? sessionId : null, candidate.mtimeMs, candidate.size, meta ? 'indexed' : 'empty');
    });
    apply.immediate();

    if (meta) indexedFiles += 1;
    else skippedSessions += 1;
    return Boolean(meta);
  };

  /**
   * Settles every file that claims one session id, best candidate first. The
   * first one that yields a session owns it; the ones before it yielded nothing
   * or could not be read, and the ones after it are duplicates.
   */
  const resolveGroup = async (group: Candidate[]): Promise<void> => {
    let owned = false;
    for (const candidate of group) {
      if (options.signal?.aborted) {
        aborted = true;
        return;
      }
      resolved.add(candidate.path);
      processed += 1;

      const previous = known.get(candidate.path);
      const unchanged = isUnchanged(candidate, previous);

      if (owned) {
        // Behind the owner: nothing to parse, only a state to record.
        skippedSessions += 1;
        if (unchanged && previous.state === 'duplicate') skippedFiles += 1;
        else recordSkipped(candidate, 'duplicate');
        continue;
      }

      if (unchanged && previous.state === 'empty') {
        // A settled answer for this (mtime, size): it holds nothing, so the
        // next candidate gets its chance.
        skippedFiles += 1;
        skippedSessions += 1;
        continue;
      }
      if (unchanged && previous.state === 'indexed' && owns(candidate.sessionId, candidate.path)) {
        skippedFiles += 1;
        owned = true;
        continue;
      }

      const yielded = await indexCandidate(candidate, previous);
      if (yielded === true) owned = true;
    }
  };

  for (const candidate of candidates) {
    seen.add(candidate.path);
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    if (resolved.has(candidate.path)) continue;

    if (!candidate.valid) {
      resolved.add(candidate.path);
      processed += 1;
      skippedSessions += 1;
      const previous = known.get(candidate.path);
      if (isUnchanged(candidate, previous) && previous.state === 'invalid') skippedFiles += 1;
      else recordSkipped(candidate, 'invalid');
      continue;
    }

    await resolveGroup(ranked.get(candidate.sessionId) ?? [candidate]);
    if (aborted) break;
  }

  if (!aborted) {
    const prune = db.transaction(() => {
      for (const [filePath, row] of known) {
        if (seen.has(filePath)) continue;
        // Only rows nobody claims any more are purged: deleting one copy of a
        // duplicated session id must leave the surviving copy's data alone,
        // including when the survivor was just promoted in this same run.
        if (row.session_id && !ranked.has(row.session_id)) purgeSession(row.session_id);
        deleteFile.run(filePath);
        removedFiles += 1;
      }
    });
    prune.immediate();
    if (removedFiles > 0) {
      options.onProgress?.({ phase: 'prune', current: removedFiles, total: removedFiles });
    }
  }

  // Chunk rows moved, so any vector matrix cached against this handle now
  // points at row ids that may mean something else.
  if (indexedFiles > 0 || removedFiles > 0 || options.rebuild) invalidateVectorCache(db);

  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
              (SELECT COUNT(*) FROM messages) AS messages,
              (SELECT COUNT(*) FROM chunks)   AS chunks`,
    )
    .get() as { sessions: number; messages: number; chunks: number };

  return {
    scannedFiles: candidates.length,
    indexedFiles,
    skippedFiles,
    removedFiles,
    skippedSessions,
    failedFiles,
    sessions: counts.sessions,
    messages: counts.messages,
    chunks: counts.chunks,
    durationMs: Date.now() - started,
    aborted,
  };
}
