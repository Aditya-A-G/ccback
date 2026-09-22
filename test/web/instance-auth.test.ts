/**
 * Proving a server is *ours* before handing it the user's query.
 *
 * `web.json` records a port, and a port is not an identity: with a stale marker
 * and a squatted port, any local process answering `{"app":"ccback"}` would get
 * the browser opened on it, with the search terms in the URL. So the marker
 * carries a secret only its writer knows, and the server proves it knows it
 * without the secret ever crossing the wire.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sync } from '../../src/core/index.js';
import {
  findRunningWeb,
  probe,
  readInstanceFile,
  startWebServer,
  writeInstanceFile,
} from '../../src/web/index.js';
import { cleanupTempDirs, fakeEmbedder, makeFixture, openFixtureDb, userMessage, writeSession } from '../helpers.js';
import { request } from './web-helpers.js';

afterAll(cleanupTempDirs);

async function fixtureWithSession(): Promise<ReturnType<typeof makeFixture>> {
  const fixture = makeFixture();
  writeSession(fixture.projectsDir, '-tmp-alpha', 'alpha', [
    userMessage('how I will be recording the videos', { cwd: '/tmp/alpha' }),
  ]);
  const db = openFixtureDb(fixture);
  await sync({ db, projectsDir: fixture.projectsDir });
  db.close();
  return fixture;
}

/** A local server that claims to be ccback. It cannot know the marker's token. */
async function impostor(body: unknown): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as { port: number }).port,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('the marker carries a secret', () => {
  it('writes a 128-bit token, readable only by its owner', async () => {
    const fixture = await fixtureWithSession();
    writeInstanceFile(4777, { appHome: fixture.home });
    const marker = path.join(fixture.home, 'web.json');
    // NTFS has no POSIX mode bits, so 0600 is only checked where it exists;
    // on Windows the marker is protected by the ACL it inherits from
    // `%USERPROFILE%`. See the note in test/web/instance.test.ts.
    if (process.platform !== 'win32') expect(fs.statSync(marker).mode & 0o777).toBe(0o600);

    const instance = readInstanceFile({ appHome: fixture.home })!;
    expect(instance.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('treats a marker from an older version, with no token, as stale', async () => {
    const fixture = await fixtureWithSession();
    fs.writeFileSync(
      path.join(fixture.home, 'web.json'),
      JSON.stringify({ pid: process.pid, port: 4777, startedAt: new Date().toISOString() }),
    );
    expect(readInstanceFile({ appHome: fixture.home })).toBeNull();
    expect(await findRunningWeb({ appHome: fixture.home })).toBeNull();
  });
});

describe('a port squatter', () => {
  it('is not reused just because it says it is ccback', async () => {
    const fixture = await fixtureWithSession();
    const fake = await impostor({ app: 'ccback', ok: true });
    writeInstanceFile(fake.port, { appHome: fixture.home });

    expect(await findRunningWeb({ appHome: fixture.home })).toBeNull();

    await fake.stop();
  });

  it('cannot fake the proof either, because it does not have the token', async () => {
    const fixture = await fixtureWithSession();
    const fake = await impostor({ app: 'ccback', auth: 'f'.repeat(64) });
    writeInstanceFile(fake.port, { appHome: fixture.home });
    expect(await findRunningWeb({ appHome: fixture.home })).toBeNull();
    await fake.stop();
  });

  it('cannot hold the probe open with an endless body', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const timer = setInterval(() => res.write('x'.repeat(8192)), 5);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const started = Date.now();
    expect(await probe(port, { token: 'a'.repeat(32) })).toBe(false);
    expect(Date.now() - started).toBeLessThan(2500);

    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('a dead process', () => {
  it('is not probed at all when its pid is gone', async () => {
    const fixture = await fixtureWithSession();
    const fake = await impostor({ app: 'ccback' });
    // A pid that cannot exist, on the port something else now answers on.
    fs.writeFileSync(
      path.join(fixture.home, 'web.json'),
      JSON.stringify({
        pid: 0x7fffffff,
        port: fake.port,
        startedAt: new Date().toISOString(),
        token: 'a'.repeat(32),
      }),
    );
    expect(await findRunningWeb({ appHome: fixture.home })).toBeNull();
    await fake.stop();
  });
});

describe('the real server', () => {
  it('proves itself and is reused', async () => {
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

    await handle.close();
  });

  it('never puts the token in a response, and answers a nonce with a hash of it', async () => {
    const fixture = await fixtureWithSession();
    const handle = await startWebServer({
      port: 0,
      appHome: fixture.home,
      dbPath: fixture.dbPath,
      projectsDir: fixture.projectsDir,
      embedder: fakeEmbedder(),
      autoEmbed: false,
    });
    const token = readInstanceFile({ appHome: fixture.home })!.token;

    const plain = (await request(handle.port, '/api/status')).body;
    expect(plain).not.toContain(token);
    expect(JSON.parse(plain)).not.toHaveProperty('token');
    expect(JSON.parse(plain)).not.toHaveProperty('auth');

    const nonce = 'abc123def456';
    const proved = (await request(handle.port, `/api/status?nonce=${nonce}`)).json() as { auth: string };
    expect(proved.auth).toBe(crypto.createHash('sha256').update(`${token}${nonce}`).digest('hex'));

    // A different nonce is a different answer: a replayed one proves nothing.
    const other = (await request(handle.port, '/api/status?nonce=0f0f0f0f')).json() as { auth: string };
    expect(other.auth).not.toBe(proved.auth);

    // Nonsense in, nothing out.
    const bad = (await request(handle.port, '/api/status?nonce=not%20hex!')).json() as { auth?: string };
    expect(bad.auth).toBeUndefined();

    await handle.close();
  });
});
