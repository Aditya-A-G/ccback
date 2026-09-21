import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { UserError } from './errors.js';
import { chunkHash } from './hash.js';

export type Db = Database.Database;

/**
 * Bumping this runs the matching entry of {@link MIGRATIONS} on next open.
 * A bump with no migration falls back to a rebuild, which throws every
 * embedding away — so a bump that can be migrated must be.
 */
export const SCHEMA_VERSION = 3;

/**
 * How long a statement waits for another process's write lock. A TUI in one
 * terminal and `web` in another is a normal flow, and so is a first run in
 * both at once: neither may fail with `database is locked`.
 */
export const BUSY_TIMEOUT_MS = 10_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  path      TEXT PRIMARY KEY,
  session_id TEXT,
  mtime_ms  REAL NOT NULL,
  size      INTEGER NOT NULL,
  -- why this file holds no searchable session, so a skipped file is never
  -- re-parsed and a duplicate can still be promoted later:
  -- indexed | empty | duplicate | invalid
  state     TEXT NOT NULL DEFAULT 'indexed'
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  cwd           TEXT NOT NULL,
  title         TEXT NOT NULL,
  git_branch    TEXT NOT NULL DEFAULT '',
  first_ts      TEXT NOT NULL DEFAULT '',
  last_ts       TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  file_path     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_ts ON sessions(last_ts DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  uuid       TEXT,
  role       TEXT NOT NULL,
  ts         TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- External-content FTS5 tables do not follow their content table on their own.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS chunks (
  id         INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  text       TEXT NOT NULL,
  -- digest of the chunk text: re-indexing a session carries an embedding over to the
  -- new chunk that has the same hash, so only genuinely new text is embedded.
  text_hash  TEXT NOT NULL DEFAULT '',
  embedding  BLOB
);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_chunks_message ON chunks(message_id);
CREATE INDEX IF NOT EXISTS idx_chunks_pending ON chunks(id) WHERE embedding IS NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(session_id, text_hash);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * Opens (creating and migrating if needed) the index database.
 *
 * Every failure a user can act on — a corrupt file, a file that is not a
 * database, an index written by a newer build — comes back as a
 * {@link UserError} carrying the one-line fix, never a stack trace.
 */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  let db: Db | undefined;
  try {
    // `new Database()` does not read the file; the first pragma does, so the
    // open, the pragmas and the migration are guarded together.
    db = new Database(dbPath);
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    enableWal(db);
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    migrate(db, dbPath);
    return db;
  } catch (err) {
    try {
      db?.close();
    } catch {
      /* the handle never opened */
    }
    throw asIndexError(err, dbPath);
  }
}

/** Blocks this thread without a promise, which is what a sync open needs. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusy(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code ?? '';
  return code.startsWith('SQLITE_BUSY') || /database is locked/i.test(String((err as Error)?.message ?? ''));
}

/**
 * Switches the file to WAL, tolerating a concurrent first run.
 *
 * Turning WAL on needs an exclusive lock, and unlike ordinary statements it
 * does not wait for `busy_timeout`, so a lock held by another process is the
 * one case worth retrying. Anything else — `:memory:`, a file system that has
 * no WAL — answers with a different journal mode straight away, and that is an
 * answer, not a failure: WAL is a preference, never a requirement.
 */
function enableWal(db: Db): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      // Whatever mode comes back, the question has been answered.
      db.pragma('journal_mode = WAL', { simple: true });
      return;
    } catch (err) {
      if (!isBusy(err)) throw err;
    }
    try {
      // WAL is a property of the file: if the other process already set it,
      // this connection has it too and there is nothing left to wait for.
      if (db.pragma('journal_mode', { simple: true }) === 'wal') return;
    } catch (err) {
      if (!isBusy(err)) throw err;
    }
    if (Date.now() >= deadline) return;
    sleepSync(20);
  }
}

/** One line: what happened, and the exact command that fixes it. */
export function corruptIndexMessage(dbPath: string, detail: string): string {
  return `The search index at ${dbPath} is unusable (${detail}). Delete ${dbPath} and run again; it is rebuilt automatically.`;
}

/** One line for the only other thing SQLite says at open time that is not damage. */
export function busyIndexMessage(dbPath: string): string {
  return `The search index at ${dbPath} is still in use by another ccfind process; try again in a moment.`;
}

const CORRUPT_CODES = new Set(['SQLITE_NOTADB', 'SQLITE_CORRUPT', 'SQLITE_CORRUPT_VTAB', 'SQLITE_FORMAT']);
const CORRUPT_TEXT = /not a database|malformed|corrupt|file is encrypted|unsupported file format/i;

/**
 * Maps a raw SQLite failure onto an actionable one-liner, or passes it through.
 *
 * Every `SqliteError` raised while opening or migrating means the file cannot
 * serve as an index, whatever the code says, so all of them come back as a
 * {@link UserError} the CLI prints as one line (exit 2). Only a lock held by
 * another process gets a different sentence: telling someone to delete an index
 * they would get back in a second is advice that destroys their embeddings.
 */
export function asIndexError(err: unknown, dbPath: string): unknown {
  if (err instanceof UserError) return err;
  const error = err as NodeJS.ErrnoException & { code?: string };
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : String(err);
  if (CORRUPT_CODES.has(code) || CORRUPT_TEXT.test(message)) {
    return new UserError(corruptIndexMessage(dbPath, message.replace(/\s+/g, ' ').trim()));
  }
  if (isBusy(err)) return new UserError(busyIndexMessage(dbPath));
  if (err instanceof Database.SqliteError || code.startsWith('SQLITE_')) {
    return new UserError(corruptIndexMessage(dbPath, message.replace(/\s+/g, ' ').trim()));
  }
  return err;
}

/** Schema version recorded in the file. 0 when the index is empty or brand new. */
function readSchemaVersion(db: Db): number {
  const hasMeta = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`)
    .get() as { name?: string } | undefined;
  if (!hasMeta) return 0;
  const value = Number(getMeta(db, 'schema_version') ?? '0');
  return Number.isFinite(value) ? value : 0;
}

/**
 * In-place upgrades, keyed by the version they upgrade *from*. A version with
 * an entry here keeps its rows — sessions, messages, FTS, and above all
 * `chunks.embedding`, which costs minutes of CPU to recompute.
 */
const MIGRATIONS: Record<number, (db: Db) => void> = {
  // v1 tracked the same files without saying why one was unusable. The default
  // makes every existing row look indexed, and the next sync repairs that for
  // free: a row claiming `indexed` with no session of its own is re-parsed.
  1: (db) => {
    if (!hasColumn(db, 'files', 'state')) {
      db.exec(`ALTER TABLE files ADD COLUMN state TEXT NOT NULL DEFAULT 'indexed'`);
    }
  },
  // v2 had no chunk digests, so re-indexing a session threw its embeddings
  // away. The digests are computed from the chunk text that is already there,
  // which means every existing embedding survives and stays reusable.
  2: (db) => {
    if (!hasColumn(db, 'chunks', 'text_hash')) {
      db.exec(`ALTER TABLE chunks ADD COLUMN text_hash TEXT NOT NULL DEFAULT ''`);
    }
    backfillChunkHashes(db);
  },
};

/** Fills in `chunks.text_hash` for rows written before the column existed. */
function backfillChunkHashes(db: Db): void {
  const rows = db.prepare(`SELECT id, text FROM chunks WHERE text_hash = ''`).all() as {
    id: number;
    text: string;
  }[];
  if (rows.length === 0) return;
  const update = db.prepare('UPDATE chunks SET text_hash = ? WHERE id = ?');
  for (const row of rows) update.run(chunkHash(row.text), row.id);
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.pragma(`table_info("${table.replace(/"/g, '""')}")`) as { name: string }[];
  return columns.some((row) => row.name === column);
}

/** True when the file already holds objects of ours (or somebody else's). */
function hasUserObjects(db: Db): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' LIMIT 1`)
    .get() as { ok?: number } | undefined;
  return row !== undefined;
}

/**
 * Creates or upgrades the schema.
 *
 * The common case (already current) is a plain read, so a long-running writer
 * in another process never delays a reader. Anything else happens inside one
 * `BEGIN IMMEDIATE`, with the version re-checked once the lock is held: when
 * two first runs race, the loser sees the winner's schema and does nothing.
 *
 * Upgrades run one step at a time and in place. A full rebuild is the fallback
 * for a version with no migration path, and for a file that has tables but no
 * version at all (a pre-versioning or half-written index): there is no way to
 * know what its columns mean, and `CREATE TABLE IF NOT EXISTS` on top of it
 * would leave a half-right schema that fails later with `no such column`.
 */
function migrate(db: Db, dbPath: string): void {
  if (readSchemaVersion(db) === SCHEMA_VERSION) return;

  const apply = db.transaction(() => {
    let version = readSchemaVersion(db);
    if (version === SCHEMA_VERSION) return; // another process got there first
    if (version > SCHEMA_VERSION) {
      throw new UserError(
        `The search index at ${dbPath} was written by a newer version of ccfind ` +
          `(schema ${version}, this build understands ${SCHEMA_VERSION}). ` +
          `Delete ${dbPath} and run again; it is rebuilt automatically.`,
      );
    }

    if (version === 0) {
      // An empty file is simply created; anything else is unknown territory.
      if (hasUserObjects(db)) discardEverything(db);
    } else {
      while (version < SCHEMA_VERSION) {
        const step = MIGRATIONS[version];
        if (step === undefined) {
          discardEverything(db);
          break;
        }
        step(db);
        version += 1;
      }
    }

    db.exec(SCHEMA_SQL);
    setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  });
  apply.immediate();
}

/** Drops everything, after telling the user what that costs them. */
function discardEverything(db: Db): void {
  noteDiscardedEmbeddings(db);
  dropEverything(db);
}

let embeddingLossReported = false;

/**
 * Says once, in one sentence, that a rebuild took the embeddings with it.
 * Silence would leave `semantic` quietly falling back to keyword search.
 */
function noteDiscardedEmbeddings(db: Db): void {
  if (embeddingLossReported) return;
  let embedded = 0;
  try {
    embedded = (db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get() as { n: number }).n;
  } catch {
    return; // no chunks table: nothing to lose
  }
  if (embedded === 0) return;
  embeddingLossReported = true;
  process.stderr.write(
    `The search index had to be rebuilt, so its ${embedded} embeddings are gone; ` +
      'they are rebuilt in the background the next time you open the picker or the browser UI.\n',
  );
}

const DROP_KEYWORD: Record<string, string> = {
  view: 'VIEW',
  trigger: 'TRIGGER',
  index: 'INDEX',
  table: 'TABLE',
};

/**
 * Empties the file of every object we can drop, whatever it is.
 *
 * Dropping only tables left a database holding a view named `sessions`
 * unrecoverable: `CREATE TABLE IF NOT EXISTS sessions` sees the view and does
 * nothing. Order matters — views and triggers can reference tables, and an
 * FTS5 shadow table can only go with its virtual table — so objects are dropped
 * views first, then triggers, then virtual tables, then the rest.
 */
function dropEverything(db: Db): void {
  const rows = db
    .prepare(
      `SELECT type, name, IFNULL(sql, '') AS sql FROM sqlite_master
       WHERE type IN ('table','trigger','index','view') AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as { type: string; name: string; sql: string }[];

  const rank = (row: { type: string; sql: string }): number => {
    if (row.type === 'view') return 0;
    if (row.type === 'trigger') return 1;
    if (row.type === 'table') return /^\s*CREATE\s+VIRTUAL/i.test(row.sql) ? 2 : 3;
    return 4; // an index, if its table somehow outlived this loop
  };

  for (const row of [...rows].sort((a, b) => rank(a) - rank(b))) {
    const keyword = DROP_KEYWORD[row.type];
    if (keyword === undefined) continue;
    try {
      db.exec(`DROP ${keyword} IF EXISTS "${row.name.replace(/"/g, '""')}"`);
    } catch {
      /* already removed together with the object that owned it */
    }
  }
}

/**
 * Drops and recreates every table, atomically. Backs `index --rebuild`: another
 * process reading the index sees either the old content or an empty index,
 * never a half-dropped schema. The refill is the sync that follows, in its own
 * transactions, so a reader during a rebuild can legitimately see an index that
 * is still filling up.
 */
export function rebuildDatabase(db: Db): void {
  const apply = db.transaction(() => {
    discardEverything(db);
    db.exec(SCHEMA_SQL);
    setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  });
  apply.immediate();
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

const shared = new Map<string, Db>();

/**
 * Returns a process-wide cached handle for `dbPath`. Front ends call this so a
 * long-lived TUI or web server keeps one connection.
 */
export function getSharedDatabase(dbPath: string): Db {
  const existing = shared.get(dbPath);
  if (existing && existing.open) return existing;
  const db = openDatabase(dbPath);
  shared.set(dbPath, db);
  return db;
}

/** Closes every cached handle. Tests and CLI shutdown call this. */
export function closeSharedDatabases(): void {
  for (const db of shared.values()) {
    if (db.open) db.close();
  }
  shared.clear();
}
