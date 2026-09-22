/**
 * Two terminals is a normal day: the TUI in one, `web` in another, both
 * opening and indexing the same SQLite file. None of them may fail with
 * `database is locked` or `table files already exists`.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/core/db.js';
import { aiTitle, childEnv, cleanupTempDirs, makeFixture, userMessage, writeSession, type Fixture } from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');

const SESSION_COUNT = 12;

let fixture: Fixture;

beforeAll(() => {
  fixture = makeFixture();
  for (let i = 0; i < SESSION_COUNT; i += 1) {
    writeSession(fixture.projectsDir, `-tmp-p${i}`, `sess-${i}`, [
      aiTitle(`Session number ${i}`),
      userMessage(`conversation ${i} about recording and editing videos`, { cwd: `/tmp/p${i}` }),
    ]);
  }
});

afterAll(cleanupTempDirs);

interface Finished {
  status: number;
  stderr: string;
}

function runIndex(home: string): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--reindex', '--projects-dir', fixture.projectsDir], {
      env: childEnv({ CCBACK_HOME: home }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: status ?? -1, stderr }));
  });
}

describe('concurrent first runs', () => {
  it('four processes indexing one fresh index all succeed', async () => {
    const home = path.join(fixture.root, 'concurrent-home');
    const results = await Promise.all([runIndex(home), runIndex(home), runIndex(home), runIndex(home)]);

    for (const result of results) {
      expect([result.status, result.stderr]).toEqual([0, result.stderr]);
      expect(result.stderr).not.toContain('database is locked');
      expect(result.stderr).not.toContain('already exists');
      expect(result.stderr).not.toContain('    at ');
    }

    // And the index is complete, not half-written.
    const db = openDatabase(path.join(home, 'index.db'));
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
                (SELECT COUNT(*) FROM files)    AS files,
                (SELECT COUNT(*) FROM messages) AS messages`,
      )
      .get() as { sessions: number; files: number; messages: number };
    expect(counts.sessions).toBe(SESSION_COUNT);
    expect(counts.files).toBe(SESSION_COUNT);
    expect(counts.messages).toBe(SESSION_COUNT);
    db.close();

    // A search against the shared index still works afterwards.
    const search = spawnSync(
      process.execPath,
      [cliPath, 'recording videos', '--json', '--projects-dir', fixture.projectsDir],
      {
        encoding: 'utf8',
        env: childEnv({ CCBACK_HOME: home }),
      },
    );
    expect(search.status).toBe(0);
    expect((JSON.parse(search.stdout ?? '[]') as unknown[]).length).toBeGreaterThan(0);
  }, 60_000);

  it('a full rebuild is atomic: a concurrent reader never sees a half-dropped schema', async () => {
    const home = path.join(fixture.root, 'rebuild-home');
    await runIndex(home);

    const rebuild = new Promise<Finished>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cliPath, '--reindex', '--full', '--projects-dir', fixture.projectsDir],
        {
          env: childEnv({ CCBACK_HOME: home }),
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status: status ?? -1, stderr }));
    });
    const readers = Array.from({ length: 3 }, () => runIndex(home));

    const results = await Promise.all([rebuild, ...readers]);
    for (const result of results) {
      expect([result.status, result.stderr]).toEqual([0, result.stderr]);
      expect(result.stderr).not.toContain('no such table');
    }
    const db = openDatabase(path.join(home, 'index.db'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: SESSION_COUNT });
    db.close();
  }, 60_000);

  it('a reader is not blocked into failing while another process writes', async () => {
    const home = path.join(fixture.root, 'mixed-home');
    fs.mkdirSync(home, { recursive: true });
    const writer = runIndex(home);
    const reader = new Promise<Finished>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cliPath, 'recording', '--json', '--projects-dir', fixture.projectsDir],
        {
          env: childEnv({ CCBACK_HOME: home }),
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status: status ?? -1, stderr }));
    });

    const [writerResult, readerResult] = await Promise.all([writer, reader]);
    expect(writerResult.status).toBe(0);
    expect(readerResult.status).toBe(0);
    expect(readerResult.stderr).not.toContain('database is locked');
  }, 60_000);
});
