/**
 * Opening an index that is not in today's shape.
 *
 * A schema bump must never silently throw embeddings away: rebuilding them
 * costs minutes of CPU, so they are expensive to lose without being told.
 * An older version with a migration path is upgraded in
 * place; only a file nobody can interpret is rebuilt, and then the user is told
 * what that cost, once, on stderr.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getMeta, openDatabase, SCHEMA_VERSION } from '../src/core/db.js';
import { chunkHash } from '../src/core/hash.js';
import { syncIndex } from '../src/core/indexer.js';
import { semanticSearch, toBlob } from '../src/core/semantic.js';
import {
  assistantMessage,
  childEnv,
  cleanupTempDirs,
  fakeEmbedder,
  tempDir,
  userMessage,
  writeSession,
} from './helpers.js';

afterAll(cleanupTempDirs);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');

/**
 * Schema version 1: exactly today's schema without `files.state`. This is the
 * shape an index left by an older install is in, and what a v1→v2 upgrade has
 * to read without discarding.
 */
const V1_SCHEMA_SQL = `
CREATE TABLE files (
  path      TEXT PRIMARY KEY,
  session_id TEXT,
  mtime_ms  REAL NOT NULL,
  size      INTEGER NOT NULL
);
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  cwd           TEXT NOT NULL,
  title         TEXT NOT NULL,
  git_branch    TEXT NOT NULL DEFAULT '',
  first_ts      TEXT NOT NULL DEFAULT '',
  last_ts       TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  file_path     TEXT NOT NULL
);
CREATE INDEX idx_sessions_last_ts ON sessions(last_ts DESC);
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  uuid       TEXT,
  role       TEXT NOT NULL,
  ts         TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text, content='messages', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE chunks (
  id         INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  text       TEXT NOT NULL,
  embedding  BLOB
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

const CHUNK_TEXT =
  'We spent the afternoon recording screencasts with OBS and editing the footage before publishing.';

/** A populated version 1 index: one session, messages, FTS rows, one embedding. */
async function writeV1Database(dbPath: string): Promise<void> {
  const embedder = fakeEmbedder();
  const [vector] = await embedder.embed([CHUNK_TEXT]);
  const db = new Database(dbPath);
  db.exec(V1_SCHEMA_SQL);
  db.prepare('INSERT INTO files(path, session_id, mtime_ms, size) VALUES (?, ?, ?, ?)').run(
    '/tmp/projects/-tmp-video/video.jsonl',
    'video',
    1_700_000_000_000,
    4096,
  );
  db.prepare(
    `INSERT INTO sessions(id, cwd, title, git_branch, first_ts, last_ts, message_count, file_path)
     VALUES ('video', '/tmp/video', 'Recording and editing videos', 'main',
             '2026-09-10T09:00:00.000Z', '2026-09-10T12:00:00.000Z', 2, '/tmp/projects/-tmp-video/video.jsonl')`,
  ).run();
  db.prepare('INSERT INTO messages(id, session_id, uuid, role, ts, text) VALUES (1, ?, ?, ?, ?, ?)').run(
    'video',
    'uuid-1',
    'user',
    '2026-09-10T09:00:00.000Z',
    CHUNK_TEXT,
  );
  db.prepare('INSERT INTO chunks(id, message_id, session_id, text, embedding) VALUES (1, 1, ?, ?, ?)').run(
    'video',
    CHUNK_TEXT,
    toBlob(vector!),
  );
  const meta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
  meta.run('schema_version', '1');
  meta.run('embedding_model', 'fake-bow-v1');
  meta.run('embedding_dims', '64');
  db.close();
}

describe('an index written by schema version 1', () => {
  it('is migrated in place, keeping every row and every embedding', async () => {
    const home = tempDir('ccback-v1-');
    const dbPath = path.join(home, 'index.db');
    await writeV1Database(dbPath);

    const db = openDatabase(dbPath);

    expect(getMeta(db, 'schema_version')).toBe(String(SCHEMA_VERSION));
    // The rows that cost time to produce are all still there.
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get()).toEqual({ n: 1 });
    expect(getMeta(db, 'embedding_model')).toBe('fake-bow-v1');
    expect(getMeta(db, 'embedding_dims')).toBe('64');
    // FTS survived with its content.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'screencasts'`).get()).toEqual(
      { n: 1 },
    );
    // And the new column exists, with a value for the row that predates it.
    expect(db.prepare('SELECT state FROM files').get()).toEqual({ state: 'indexed' });

    // Semantic search still answers from the preserved vectors.
    const hits = await semanticSearch(db, 'editing video footage', fakeEmbedder(), { limit: 5 });
    expect(hits.map((hit) => hit.sessionId)).toContain('video');
    db.close();
  });
});

/** Schema version 2: today's schema without `chunks.text_hash`. */
const V2_SCHEMA_SQL = `
CREATE TABLE files (
  path      TEXT PRIMARY KEY,
  session_id TEXT,
  mtime_ms  REAL NOT NULL,
  size      INTEGER NOT NULL,
  state     TEXT NOT NULL DEFAULT 'indexed'
);
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  cwd           TEXT NOT NULL,
  title         TEXT NOT NULL,
  git_branch    TEXT NOT NULL DEFAULT '',
  first_ts      TEXT NOT NULL DEFAULT '',
  last_ts       TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  file_path     TEXT NOT NULL
);
CREATE INDEX idx_sessions_last_ts ON sessions(last_ts DESC);
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  uuid       TEXT,
  role       TEXT NOT NULL,
  ts         TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text, content='messages', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE chunks (
  id         INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  text       TEXT NOT NULL,
  embedding  BLOB
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

const SECOND_CHUNK_TEXT = 'A second paragraph about colour grading, titles and the thumbnail.';

/** A populated version 2 index: two embedded chunks, no digests. */
async function writeV2Database(dbPath: string): Promise<void> {
  const embedder = fakeEmbedder();
  const vectors = await embedder.embed([CHUNK_TEXT, SECOND_CHUNK_TEXT]);
  const db = new Database(dbPath);
  db.exec(V2_SCHEMA_SQL);
  db.prepare('INSERT INTO files(path, session_id, mtime_ms, size, state) VALUES (?, ?, ?, ?, ?)').run(
    '/tmp/projects/-tmp-video/video.jsonl',
    'video',
    1_700_000_000_000,
    4096,
    'indexed',
  );
  db.prepare(
    `INSERT INTO sessions(id, cwd, title, git_branch, first_ts, last_ts, message_count, file_path)
     VALUES ('video', '/tmp/video', 'Recording and editing videos', 'main',
             '2026-09-10T09:00:00.000Z', '2026-09-10T12:00:00.000Z', 2, '/tmp/projects/-tmp-video/video.jsonl')`,
  ).run();
  const insertMessage = db.prepare(
    'INSERT INTO messages(id, session_id, uuid, role, ts, text) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertMessage.run(1, 'video', 'uuid-1', 'user', '2026-09-10T09:00:00.000Z', CHUNK_TEXT);
  insertMessage.run(2, 'video', 'uuid-2', 'assistant', '2026-09-10T10:00:00.000Z', SECOND_CHUNK_TEXT);
  const insertChunk = db.prepare(
    'INSERT INTO chunks(id, message_id, session_id, text, embedding) VALUES (?, ?, ?, ?, ?)',
  );
  insertChunk.run(1, 1, 'video', CHUNK_TEXT, toBlob(vectors[0]!));
  insertChunk.run(2, 2, 'video', SECOND_CHUNK_TEXT, toBlob(vectors[1]!));
  const meta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
  meta.run('schema_version', '2');
  meta.run('embedding_model', 'fake-bow-v1');
  meta.run('embedding_dims', '64');
  db.close();
}

describe('an index written by schema version 2 (incremental embeddings)', () => {
  it('gains chunk digests in place, and every embedding survives', async () => {
    const home = tempDir('ccback-v2-');
    const dbPath = path.join(home, 'index.db');
    await writeV2Database(dbPath);

    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    let db;
    try {
      db = openDatabase(dbPath);
    } finally {
      spy.mockRestore();
    }

    expect(getMeta(db, 'schema_version')).toBe(String(SCHEMA_VERSION));
    // The whole point: an upgrade that costs nobody a minute of CPU.
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get()).toEqual({ n: 2 });
    expect(written.join('')).not.toContain('embeddings are gone');

    // The digests were computed from the text that was already there, so the
    // rows are immediately reusable by the next re-index.
    const rows = db.prepare('SELECT text, text_hash FROM chunks ORDER BY id').all() as {
      text: string;
      text_hash: string;
    }[];
    expect(rows.map((row) => row.text_hash)).toEqual(rows.map((row) => chunkHash(row.text)));
    expect(rows.every((row) => row.text_hash !== '')).toBe(true);

    const hits = await semanticSearch(db, 'editing video footage', fakeEmbedder(), { limit: 5 });
    expect(hits.map((hit) => hit.sessionId)).toContain('video');
    db.close();
  });

  it('carries those preserved embeddings across the next re-index of the session', async () => {
    const home = tempDir('ccback-v2-carry-');
    const dbPath = path.join(home, 'index.db');
    await writeV2Database(dbPath);

    // A real transcript holding the same two messages, plus one new one: the
    // first sync after an upgrade, with a day of fresh conversation in it.
    const projects = tempDir('ccback-v2-carry-projects-');
    const file = writeSession(projects, '-tmp-video', 'video', [
      userMessage(CHUNK_TEXT, { cwd: '/tmp/video', timestamp: '2026-09-10T09:00:00.000Z' }),
      assistantMessage(SECOND_CHUNK_TEXT, { cwd: '/tmp/video', timestamp: '2026-09-10T10:00:00.000Z' }),
      userMessage('A third message, written after the upgrade, about export presets.', {
        cwd: '/tmp/video',
        timestamp: '2026-09-11T09:00:00.000Z',
      }),
    ]);
    const db = openDatabase(dbPath);
    db.prepare('UPDATE files SET path = ?').run(file);
    db.prepare('UPDATE sessions SET file_path = ?').run(file);

    await syncIndex(db, { projectsDir: projects });

    const pending = db.prepare('SELECT text FROM chunks WHERE embedding IS NULL').all() as { text: string }[];
    expect(pending.map((row) => row.text)).toEqual([
      'A third message, written after the upgrade, about export presets.',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get()).toEqual({ n: 2 });
    db.close();
  });
});

describe('an index nobody can interpret', () => {
  // Must stay the first rebuild in this file: the warning is once per process.
  it('tells the user once what the rebuild cost, then works', async () => {
    const home = tempDir('ccback-v0-');
    const dbPath = path.join(home, 'index.db');
    await writeV1Database(dbPath);
    // Tables, but no version: the shape of a pre-versioning or half-written index.
    const raw = new Database(dbPath);
    raw.prepare(`DELETE FROM meta WHERE key = 'schema_version'`).run();
    raw.close();

    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const db = openDatabase(dbPath);
      expect(getMeta(db, 'schema_version')).toBe(String(SCHEMA_VERSION));
      expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
      // The usable-index proof: the columns of today's schema are all there.
      expect(db.prepare('SELECT id, last_ts, state FROM sessions JOIN files LIMIT 1').all()).toEqual([]);
      db.close();

      // A second rebuild in the same process says nothing more.
      await writeV1Database(path.join(home, 'second.db'));
      const second = new Database(path.join(home, 'second.db'));
      second.prepare(`DELETE FROM meta WHERE key = 'schema_version'`).run();
      second.close();
      openDatabase(path.join(home, 'second.db')).close();
    } finally {
      spy.mockRestore();
    }

    const told = written.filter((line) => line.includes('embeddings are gone'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('rebuilt in the background');
    expect(told[0]!.trim().split('\n')).toHaveLength(1);
  });

  it('recovers a database holding a view named like one of our tables', () => {
    const home = tempDir('ccback-view-');
    const dbPath = path.join(home, 'index.db');
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE junk(a); CREATE VIEW sessions AS SELECT 1 AS id; CREATE VIEW meta AS SELECT 1 AS key;`);
    raw.close();

    const db = openDatabase(dbPath);
    expect(getMeta(db, 'schema_version')).toBe(String(SCHEMA_VERSION));
    expect(db.prepare(`SELECT type FROM sqlite_master WHERE name = 'sessions'`).get()).toEqual({ type: 'table' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE last_ts > ?').get('')).toEqual({ n: 0 });
    db.close();
  });

  it('does not die with `no such column` on a versionless index', () => {
    const home = tempDir('ccback-nocol-');
    const dbPath = path.join(home, 'index.db');
    // Tables of some ancestor shape, no `meta` row to say which: the sessions
    // table has no `last_ts`, which is what every query orders by.
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT);
              CREATE TABLE files (path TEXT PRIMARY KEY, mtime_ms REAL, size INTEGER);`);
    raw.prepare(`INSERT INTO sessions(id, cwd, title) VALUES ('old', '/tmp/old', 'An older index')`).run();
    raw.close();

    const projects = tempDir('ccback-nocol-projects-');
    const result = spawnSync(process.execPath, [cliPath, 'anything', '--projects-dir', projects], {
      encoding: 'utf8',
      env: childEnv({ CCBACK_HOME: home }),
    });
    expect([result.status, result.stderr]).toEqual([0, result.stderr]);
    expect(result.stderr).not.toContain('no such column');
    expect(result.stderr).not.toContain('    at ');
  });

  it('turns any SQLite failure during open into one actionable line, exit 2', () => {
    const home = tempDir('ccback-broken-');
    const dbPath = path.join(home, 'index.db');
    // Version 1, but the table the v1→v2 step has to alter is not there.
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
    raw.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', '1')`).run();
    raw.close();

    const result = spawnSync(process.execPath, [cliPath, 'anything', '--projects-dir', home], {
      encoding: 'utf8',
      env: childEnv({ CCBACK_HOME: home }),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('is unusable');
    expect(result.stderr).toContain(`Delete ${dbPath}`);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).not.toContain('    at ');
  });
});

describe('opening a database that cannot do WAL', () => {
  it('does not spin for the whole busy timeout', () => {
    const started = Date.now();
    const db = openDatabase(':memory:');
    const elapsed = Date.now() - started;
    db.close();
    expect(elapsed).toBeLessThan(500);
  });

  it('still opens a normal file in WAL', () => {
    const home = tempDir('ccback-wal-');
    const db = openDatabase(path.join(home, 'index.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
    expect(fs.existsSync(path.join(home, 'index.db'))).toBe(true);
  });
});
