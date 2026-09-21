/**
 * One browser UI, not five.
 *
 * A running server leaves a marker; the next `--web` and the picker's ^O find
 * it, check it is really ours and really alive, and reuse it. A marker left by
 * a crash must never send anybody to a dead port.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_NAME, sync } from '../../src/core/index.js';
import {
  clearInstanceFile,
  findRunningWeb,
  probe,
  readInstanceFile,
  searchUrl,
  startWebServer,
  transcriptUrl,
  writeInstanceFile,
} from '../../src/web/index.js';
import {
  aiTitle,
  childEnv,
  cleanupTempDirs,
  fakeEmbedder,
  makeFixture,
  openFixtureDb,
  userMessage,
  writeSession,
} from '../helpers.js';
import { request } from './web-helpers.js';

afterAll(cleanupTempDirs);

async function fixtureWithSession(): Promise<ReturnType<typeof makeFixture>> {
  const fixture = makeFixture();
  writeSession(fixture.projectsDir, '-tmp-alpha', 'alpha', [
    aiTitle('Recording and editing videos'),
    userMessage('how I will be recording the videos', { cwd: '/tmp/alpha' }),
  ]);
  const db = openFixtureDb(fixture);
  await sync({ db, projectsDir: fixture.projectsDir });
  db.close();
  return fixture;
}

describe('the web.json marker', () => {
  it('is written on start, readable only by its owner, and removed on clean exit', async () => {
    const fixture = await fixtureWithSession();
    const marker = path.join(fixture.home, 'web.json');

    const handle = await startWebServer({
      port: 0,
      appHome: fixture.home,
      dbPath: fixture.dbPath,
      projectsDir: fixture.projectsDir,
      embedder: fakeEmbedder(),
      autoEmbed: false,
    });

    expect(fs.existsSync(marker)).toBe(true);
    const contents = readInstanceFile({ appHome: fixture.home })!;
    expect(contents.port).toBe(handle.port);
    expect(contents.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(contents.startedAt))).toBe(false);
    // 0600: the port is a key to every transcript on this machine.
    expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
    // No temporary file left next to it.
    expect(fs.readdirSync(fixture.home).filter((name) => name.includes('.tmp'))).toEqual([]);

    await handle.close();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('can be turned off, for a server that is not the machine-wide one', async () => {
    const fixture = await fixtureWithSession();
    const handle = await startWebServer({
      port: 0,
      appHome: fixture.home,
      dbPath: fixture.dbPath,
      embedder: fakeEmbedder(),
      autoEmbed: false,
      announce: false,
    });
    expect(fs.existsSync(path.join(fixture.home, 'web.json'))).toBe(false);
    await handle.close();
  });

  it('overwrites a stale marker left behind by a crash', async () => {
    const fixture = await fixtureWithSession();
    writeInstanceFile(59_999, { appHome: fixture.home });
    expect(readInstanceFile({ appHome: fixture.home })!.port).toBe(59_999);

    const handle = await startWebServer({
      port: 0,
      appHome: fixture.home,
      dbPath: fixture.dbPath,
      embedder: fakeEmbedder(),
      autoEmbed: false,
    });
    expect(readInstanceFile({ appHome: fixture.home })!.port).toBe(handle.port);
    await handle.close();
  });

  it('survives a corrupt or truncated marker without throwing', async () => {
    const fixture = await fixtureWithSession();
    fs.writeFileSync(path.join(fixture.home, 'web.json'), '{"pid": 1, "por');
    expect(readInstanceFile({ appHome: fixture.home })).toBeNull();
    expect(await findRunningWeb({ appHome: fixture.home })).toBeNull();

    fs.writeFileSync(path.join(fixture.home, 'web.json'), '{"pid": 1, "port": 999999}');
    expect(readInstanceFile({ appHome: fixture.home })).toBeNull();
  });
});

describe('findRunningWeb', () => {
  it('returns the running server, and a transcript link into it', async () => {
    const fixture = await fixtureWithSession();
    const handle = await startWebServer({
      port: 0,
      appHome: fixture.home,
      dbPath: fixture.dbPath,
      projectsDir: fixture.projectsDir,
      embedder: fakeEmbedder(),
      autoEmbed: false,
    });

    const found = await findRunningWeb({ appHome: fixture.home });
    expect(found).toEqual({ url: `http://127.0.0.1:${handle.port}`, port: handle.port });
    expect(transcriptUrl(found!, 'alpha', 42)).toBe(`http://127.0.0.1:${handle.port}/s/alpha?m=42`);
    expect(searchUrl(found!.url, 'web project')).toBe(`http://127.0.0.1:${handle.port}/?q=web%20project`);
    expect(searchUrl(found!.url, '  ')).toBe(`http://127.0.0.1:${handle.port}/`);

    await handle.close();
    // Once it is gone, so is the answer.
    expect(await findRunningWeb({ appHome: fixture.home })).toBeNull();
  });

  it('says no when the recorded port belongs to somebody else', async () => {
    const fixture = await fixtureWithSession();
    const stranger = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: 'something-else', ok: true }));
    });
    await new Promise<void>((resolve) => stranger.listen(0, '127.0.0.1', resolve));
    const port = (stranger.address() as { port: number }).port;

    const instance = writeInstanceFile(port, { appHome: fixture.home });
    // Even handed the real token, a stranger cannot answer the challenge.
    expect(await probe(port, { token: instance.token })).toBe(false);
    expect(await findRunningWeb({ appHome: fixture.home })).toBeNull();

    stranger.closeAllConnections();
    await new Promise<void>((resolve) => stranger.close(() => resolve()));
  });

  it('gives up quickly on a port nobody is listening on', async () => {
    const fixture = await fixtureWithSession();
    writeInstanceFile(59_998, { appHome: fixture.home });
    const started = Date.now();
    expect(await findRunningWeb({ appHome: fixture.home })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('GET /api/status identifies the application', () => {
  it('answers with app: ccfind, which is what a probe checks', async () => {
    const fixture = await fixtureWithSession();
    const handle = await startWebServer({
      port: 0,
      appHome: fixture.home,
      dbPath: fixture.dbPath,
      projectsDir: fixture.projectsDir,
      embedder: fakeEmbedder(),
      autoEmbed: false,
    });
    const body = (await request(handle.port, '/api/status')).json() as {
      app: string;
      semantic: { runtimeInstalled: boolean; pendingChunks: number; totalChunks: number };
    };
    expect(body.app).toBe(APP_NAME);
    expect(body.app).toBe('ccfind');
    expect(body.semantic.runtimeInstalled).toBe(true);
    expect(body.semantic.totalChunks).toBeGreaterThan(0);
    await handle.close();
  });
});

describe('a second `ccfind --web`', () => {
  it('reuses the running server, prints its URL and exits 0', async () => {
    const fixture = await fixtureWithSession();
    const handle = await startWebServer({
      port: 0,
      appHome: fixture.home,
      dbPath: fixture.dbPath,
      projectsDir: fixture.projectsDir,
      embedder: fakeEmbedder(),
      autoEmbed: false,
    });

    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    // Spawned asynchronously on purpose: the server it has to find is running
    // in this very process, and a blocking spawn would stop it answering.
    const result = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [path.join(projectRoot, 'dist', 'cli.js'), '--web', '--no-open', 'recording videos'],
        {
          env: childEnv({ CCFIND_HOME: fixture.home }),
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ status: code ?? -1, stdout, stderr });
      });
    });

    expect([result.status, result.stdout, result.stderr]).toEqual([0, result.stdout, result.stderr]);
    expect(result.stdout).toContain(`http://127.0.0.1:${handle.port}`);
    expect(result.stdout).toContain('already running');
    await handle.close();
  });
});

describe('smart search sets itself up while the server runs', () => {
  it('starts embedding on startup and reports it through /api/status', async () => {
    const fixture = await fixtureWithSession();
    const handle = await startWebServer({
      port: 0,
      appHome: fixture.home,
      dbPath: fixture.dbPath,
      projectsDir: fixture.projectsDir,
      embedder: fakeEmbedder(),
      announce: false,
    });

    let body: { semantic: { pendingChunks: number; enabled: boolean }; embedding: { running: boolean } };
    for (let i = 0; i < 200; i += 1) {
      body = (await request(handle.port, '/api/status')).json() as typeof body;
      if (!body.embedding.running && body.semantic.pendingChunks === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(body!.semantic.pendingChunks).toBe(0);
    expect(body!.semantic.enabled).toBe(true);
    await handle.close();
  });
});

describe('closing one server never unrecords another', () => {
  it('leaves the marker of the server that replaced it', async () => {
    const fixture = await fixtureWithSession();
    const marker = path.join(fixture.home, 'web.json');

    const first = await startWebServer({
      port: 0,
      appHome: fixture.home,
      dbPath: fixture.dbPath,
      projectsDir: fixture.projectsDir,
      embedder: fakeEmbedder(),
      autoEmbed: false,
    });
    // A second one in this same process — the picker's ^O server alongside
    // `--web` — takes the marker over, as the last one up should.
    const second = await startWebServer({
      port: 0,
      appHome: fixture.home,
      dbPath: fixture.dbPath,
      projectsDir: fixture.projectsDir,
      embedder: fakeEmbedder(),
      autoEmbed: false,
    });
    expect(readInstanceFile({ appHome: fixture.home })?.port).toBe(second.port);

    await first.close();

    // The marker still points at the one that is still up.
    const after = readInstanceFile({ appHome: fixture.home });
    expect([fs.existsSync(marker), after?.port]).toEqual([true, second.port]);
    // And it is still findable, which is the point of the marker.
    expect((await findRunningWeb({ appHome: fixture.home }))?.port).toBe(second.port);

    await second.close();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('clearInstanceFile removes nothing unless pid, port and token all match', async () => {
    const fixture = await fixtureWithSession();
    const marker = path.join(fixture.home, 'web.json');
    const instance = writeInstanceFile(4778, { appHome: fixture.home });

    for (const wrong of [
      { port: 4779, token: instance.token },
      { port: instance.port, token: 'f'.repeat(32) },
    ]) {
      clearInstanceFile({ appHome: fixture.home, ...wrong });
      expect(fs.existsSync(marker), JSON.stringify(wrong)).toBe(true);
    }

    clearInstanceFile({ appHome: fixture.home, port: instance.port, token: instance.token });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
