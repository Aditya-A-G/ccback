import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from '../src/core/db.js';
import { closeSharedDatabases, openDatabase } from '../src/core/db.js';
import type { Embedder } from '../src/core/embedder.js';

const created: string[] = [];

/**
 * Variables that decide where the tool reads and writes, which a spawned child
 * must never inherit from whoever started the test run.
 */
export const SCRUBBED_ENV = [
  'CCFIND_HOME',
  'CCFIND_DEBUG',
  'CLAUDE_CONFIG_DIR',
  'NO_COLOR',
  'SHELL',
  // Both move a shell's startup file. A developer who exports either of them
  // would otherwise see every alias test take the print-the-line path.
  'ZDOTDIR',
  'XDG_CONFIG_HOME',
  // Keyword-only is a whole-tool switch: a developer with it exported must not
  // change what the suite exercises.
  'CCFIND_KEYWORD_ONLY',
] as const;

/** A `CLAUDE_CONFIG_DIR` that cannot exist, so a fall-through finds nothing. */
export const NO_CLAUDE_CONFIG_DIR = '/nonexistent-claude-config-dir-for-tests';

/**
 * The environment for a child process of a test.
 *
 * Every variable that could point the child at a real index is removed first
 * and then set explicitly: a developer with `CCFIND_HOME` exported in their own
 * shell must not be able to make the suite index their real transcripts. Pass
 * the app home the child is allowed to use — there is no default, on purpose.
 */
export function childEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  env['CLAUDE_CONFIG_DIR'] = NO_CLAUDE_CONFIG_DIR;
  env['CCFIND_NO_MODEL'] = '1';
  env['NO_COLOR'] = '1';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Fresh temp directory, removed by `cleanupTempDirs()`. */
export function tempDir(prefix = 'ccfind-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * Every index handle this file opened, so cleanup can close the ones a failing
 * assertion jumped over.
 *
 * Windows cannot unlink an open file: one `db.close()` skipped by a thrown
 * expectation turns the temp-directory cleanup into `EBUSY` and takes the whole
 * suite down with it.
 */
const opened: Db[] = [];

/** Closes every index this file opened, plus the process-wide shared ones. */
export function closeTestDatabases(): void {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed by the test itself */
    }
  }
  closeSharedDatabases();
}

export function cleanupTempDirs(): void {
  closeTestDatabases();
  for (const dir of created.splice(0)) {
    // Windows holds a file open a moment after the last handle goes (the
    // indexer's own child processes, and the virus scanner behind them), so a
    // single attempt is not enough there.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export interface Fixture {
  root: string;
  projectsDir: string;
  home: string;
  dbPath: string;
}

/** Temp `projects/` + `home/` pair. Nothing here touches the real ~/.claude. */
export function makeFixture(): Fixture {
  const root = tempDir();
  const projectsDir = path.join(root, 'projects');
  const home = path.join(root, 'home');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, projectsDir, home, dbPath: path.join(home, 'index.db') };
}

export function openFixtureDb(fixture: Fixture): Db {
  const db = openDatabase(fixture.dbPath);
  opened.push(db);
  return db;
}

/** Same, for a test that opens an index somewhere other than a fixture. */
export function openTrackedDb(dbPath: string): Db {
  const db = openDatabase(dbPath);
  opened.push(db);
  return db;
}

export interface RecordOptions {
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  uuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
}

let uuidCounter = 0;

function baseRecord(type: 'user' | 'assistant', content: unknown, options: RecordOptions): object {
  uuidCounter += 1;
  return {
    type,
    uuid: options.uuid ?? `uuid-${uuidCounter}`,
    timestamp: options.timestamp ?? '2026-09-10T12:00:00.000Z',
    cwd: options.cwd ?? '/tmp/project',
    gitBranch: options.gitBranch ?? 'main',
    isSidechain: options.isSidechain ?? false,
    ...(options.isMeta === undefined ? {} : { isMeta: options.isMeta }),
    message: { role: type, content },
  };
}

export const userMessage = (content: unknown, options: RecordOptions = {}): object =>
  baseRecord('user', content, options);

export const assistantMessage = (content: unknown, options: RecordOptions = {}): object =>
  baseRecord('assistant', content, options);

export const aiTitle = (title: string): object => ({ type: 'ai-title', aiTitle: title });

/**
 * Writes `<projectsDir>/<encodedDir>/<sessionId>.jsonl`. `raw` lines are
 * appended verbatim, for truncated or garbage-line fixtures.
 */
export function writeSession(
  projectsDir: string,
  encodedDir: string,
  sessionId: string,
  records: unknown[],
  raw: string[] = [],
): string {
  const dir = path.join(projectsDir, encodedDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, records.length > 0 ? `${body}\n` : '');
  if (raw.length > 0) fs.appendFileSync(filePath, `${raw.join('\n')}`);
  return filePath;
}

/** Appends more records to an existing session file. */
export function appendSession(filePath: string, records: unknown[]): void {
  fs.appendFileSync(filePath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

/**
 * Deterministic hashed bag-of-words embedder. No model, no network, stable
 * across runs, and similar texts genuinely land near each other.
 */
export function fakeEmbedder(id = 'fake-bow-v1', dims = 64): Embedder {
  return {
    id,
    dims,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => {
        const vec = new Float32Array(dims);
        const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        for (const word of words) {
          vec[hash(word) % dims] += 1;
        }
        let sum = 0;
        for (let i = 0; i < dims; i += 1) sum += vec[i] * vec[i];
        const norm = Math.sqrt(sum) || 1;
        for (let i = 0; i < dims; i += 1) vec[i] /= norm;
        return vec;
      });
    },
  };
}

function hash(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i += 1) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Snapshot of every file under `dir`, for proving we never write there. */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        out[`${full}/`] = 'dir';
        walk(full);
      } else {
        const stat = fs.statSync(full);
        out[full] = `${stat.size}:${stat.mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}
