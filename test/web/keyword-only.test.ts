/**
 * The browser UI under keyword-only.
 *
 * `ccfind -w --keyword-only` has to carry the switch all the way into the
 * server, or the background embedding job starts like any other run and the
 * model is downloaded anyway. So the server refuses to embed, forces every
 * search to keyword whatever `/api/search?mode=` asks for, says `disabled` in
 * its status, and the page has nothing to show a setup line about.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db, Embedder, SessionResult } from '../../src/core/index.js';
import { sync } from '../../src/core/index.js';
import { startWebServer, type WebServerHandle } from '../../src/web/index.js';
import {
  aiTitle,
  childEnv,
  cleanupTempDirs,
  fakeEmbedder,
  makeFixture,
  openFixtureDb,
  userMessage,
  type Fixture,
} from '../helpers.js';
import { writeSession } from '../helpers.js';
import { request } from './web-helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');

afterAll(cleanupTempDirs);

/** An embedder that counts, so "nothing embedded" is a number and not a hope. */
function countingEmbedder(): Embedder & { calls: number } {
  const inner = fakeEmbedder();
  const spy = {
    calls: 0,
    id: inner.id,
    dims: inner.dims,
    async embed(texts: string[]): Promise<Float32Array[]> {
      spy.calls += 1;
      return inner.embed(texts);
    },
  };
  return spy;
}

/** A fixture with chunks and no vectors: the normal path would start on it. */
async function indexedFixture(): Promise<{ fixture: Fixture; db: Db }> {
  const fixture = makeFixture();
  writeSession(fixture.projectsDir, '-tmp-alpha', 'alpha', [
    aiTitle('Recording and editing videos'),
    userMessage('how I will be recording the videos and how you will be editing them', {
      cwd: '/tmp/alpha',
      timestamp: '2026-01-01T00:00:00.000Z',
    }),
  ]);
  const db = openFixtureDb(fixture);
  await sync({ db, projectsDir: fixture.projectsDir });
  return { fixture, db };
}

interface Started {
  handle: WebServerHandle;
  db: Db;
  embedder: Embedder & { calls: number };
}

async function serve(keywordOnly: '--keyword-only' | null): Promise<Started> {
  const { fixture, db } = await indexedFixture();
  const embedder = countingEmbedder();
  const handle = await startWebServer({
    port: 0,
    db,
    dbPath: fixture.dbPath,
    appHome: fixture.home,
    projectsDir: fixture.projectsDir,
    embedder,
    announce: false,
    // Deliberately left at its default (on): keyword-only has to be what stops
    // the job, not a caller remembering to pass `autoEmbed: false`.
    ...(keywordOnly === null ? {} : { keywordOnly }),
  });
  return { handle, db, embedder };
}

async function stop(started: Started): Promise<void> {
  await started.handle.close();
  started.db.close();
}

/** The same-origin header the page sends; without it every POST is a 403. */
const origin = (port: number): Record<string, string> => ({ Origin: `http://127.0.0.1:${port}` });

/** Waits for a background embedding job to have had every chance to run. */
async function letItRun(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

describe('a keyword-only server', () => {
  it('never starts the background embedding job', async () => {
    const started = await serve('--keyword-only');
    try {
      await letItRun();
      const status = (await request(started.handle.port, '/api/status')).json() as {
        embedding: { running: boolean; phase: string; done: boolean };
        chunksEmbedded: number;
      };
      expect(started.embedder.calls).toBe(0);
      expect(status.embedding).toMatchObject({ running: false, phase: 'idle', done: false });
      expect(status.chunksEmbedded).toBe(0);
    } finally {
      await stop(started);
    }
  });

  it('reports smart search as disabled, and offers no mode but keyword', async () => {
    const started = await serve('--keyword-only');
    try {
      const body = (await request(started.handle.port, '/api/status')).json() as Record<string, unknown>;
      expect(body['smartSearch']).toBe('disabled');
      expect(body['keywordOnly']).toBe('--keyword-only');
      expect(body['canEmbed']).toBe(false);
      expect(body['embeddingsReady']).toBe(false);
      expect(body['availableModes']).toEqual(['keyword']);
    } finally {
      await stop(started);
    }
  });

  it('answers every search with keyword results, whatever the request asks for', async () => {
    const started = await serve('--keyword-only');
    try {
      for (const mode of ['semantic', 'hybrid', 'auto']) {
        const res = await request(started.handle.port, `/api/search?q=recording%20videos&mode=${mode}`);
        expect(res.status, mode).toBe(200);
        const results = res.json() as SessionResult[];
        expect(results[0]?.sessionId, mode).toBe('alpha');
        expect(results[0]?.modeUsed, mode).toBe('keyword');
      }
      expect(started.embedder.calls).toBe(0);
      // A mode that is not a mode is still a bad request.
      expect((await request(started.handle.port, '/api/search?q=x&mode=bogus')).status).toBe(400);
    } finally {
      await stop(started);
    }
  });

  it('refuses POST /api/embed with 409 and one line saying how to turn it back on', async () => {
    const started = await serve('--keyword-only');
    try {
      const res = await request(started.handle.port, '/api/embed', {
        method: 'POST',
        headers: origin(started.handle.port),
      });
      expect(res.status).toBe(409);
      const body = res.json() as { error: string };
      expect(body.error).toContain('Smart search is disabled');
      expect(body.error).toContain('--keyword-only');
      expect(body.error.includes('\n')).toBe(false);
      await letItRun();
      expect(started.embedder.calls).toBe(0);
    } finally {
      await stop(started);
    }
  });
});

describe('a normal server, for comparison', () => {
  it('starts the job, reports smart search as available and accepts /api/embed', async () => {
    const started = await serve(null);
    try {
      await letItRun();
      const body = (await request(started.handle.port, '/api/status')).json() as Record<string, unknown>;
      expect(started.embedder.calls).toBeGreaterThan(0);
      expect(body['smartSearch']).toBe('available');
      expect(body['keywordOnly']).toBeNull();
      expect(body['canEmbed']).toBe(true);

      const res = await request(started.handle.port, '/api/embed', {
        method: 'POST',
        headers: origin(started.handle.port),
      });
      expect([200, 202]).toContain(res.status);
    } finally {
      await stop(started);
    }
  });
});

/**
 * The flag has to survive the whole way from the command line to the routes,
 * which is the part no in-process test can prove.
 */
describe('ccfind -w --keyword-only, end to end', () => {
  it('serves a keyword-only server and leaves on Ctrl-C', async () => {
    if (!fs.existsSync(cliPath)) throw new Error('dist/cli.js is missing; run "npm run build" first');
    const { fixture } = await indexedFixture();

    const child = spawn(
      process.execPath,
      [cliPath, '-w', '--keyword-only', '--port', '0', '--no-open', '--projects-dir', fixture.projectsDir],
      { env: childEnv({ CCFIND_HOME: fixture.home }), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    try {
      const url = await new Promise<string>((resolve, reject) => {
        let seen = '';
        const timer = setTimeout(() => reject(new Error(`no URL from the server: ${seen}`)), 20_000);
        child.stdout.on('data', (chunk: Buffer) => {
          seen += chunk.toString('utf8');
          const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(seen);
          if (match) {
            clearTimeout(timer);
            resolve(match[0]);
          }
        });
      });
      const port = Number(new URL(url).port);

      const status = (await request(port, '/api/status')).json() as Record<string, unknown>;
      expect(status['smartSearch']).toBe('disabled');
      expect(status['keywordOnly']).toBe('--keyword-only');

      const search = await request(port, '/api/search?q=recording%20videos&mode=semantic');
      expect(search.status).toBe(200);
      expect((search.json() as SessionResult[])[0]?.modeUsed).toBe('keyword');

      const embed = await request(port, '/api/embed', { method: 'POST', headers: origin(port) });
      expect(embed.status).toBe(409);
    } finally {
      child.kill('SIGINT');
    }

    // A shell expects 130 from a Ctrl-C, and the server must really go.
    //
    // Windows has no SIGINT to deliver from another process: `child.kill` there
    // is TerminateProcess, so the handler never runs and 130 is not a code it
    // could produce. What is still true on every platform is that the server
    // really goes, so that is what is asserted there. The handled path is
    // covered on POSIX here and in test/cli-grammar.test.ts.
    const outcome = await exited;
    if (process.platform === 'win32') {
      // Terminated, never a clean 0 that a `&&` chain would walk straight past.
      expect(outcome.code).not.toBe(0);
      expect([outcome.code, outcome.signal]).toEqual([null, 'SIGINT']);
    } else {
      expect(outcome.code).toBe(130);
    }
  }, 30_000);
});
