import http from 'node:http';
import type { Db } from '../../src/core/index.js';
import { sync } from '../../src/core/index.js';
import { startWebServer, type WebServerHandle } from '../../src/web/index.js';
import {
  aiTitle,
  assistantMessage,
  fakeEmbedder,
  makeFixture,
  openFixtureDb,
  userMessage,
  writeSession,
  type Fixture,
} from '../helpers.js';

/** Transcript text that would be an XSS if any front end ever injected HTML. */
export const ESCAPE_TEXT = '\u001b]0;PWNED\u0007\u001b[31mRED\u001b[0m';

export const XSS_TEXT =
  '<img src=x onerror=alert(1)> and </script><script>alert(1)</script> about recording videos';

export interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => any;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** false sends no Host header at all. */
  setHost?: boolean;
}

/** Raw `http.request` so Host and Origin can be forged the way an attacker would. */
export function request(port: number, path: string, options: RequestOptions = {}): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        setHost: options.setHost ?? true,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body) as unknown,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export interface WebFixture {
  fixture: Fixture;
  db: Db;
  handle: WebServerHandle;
  port: number;
  /** How many messages the paginated fixture session has. */
  longMessageCount: number;
}

export const LONG_MESSAGE_COUNT = 450;

/**
 * A temp projects dir + temp CCBACK_HOME, indexed, with a server on an
 * ephemeral port. Nothing here reads the real ~/.claude.
 */
export async function startFixtureServer(): Promise<WebFixture> {
  const fixture = makeFixture();

  writeSession(fixture.projectsDir, '-tmp-alpha', 'alpha', [
    aiTitle('Recording and editing videos'),
    userMessage('how I will be recording the videos and how you will be editing them', {
      cwd: '/tmp/alpha',
      timestamp: '2026-01-01T00:00:00.000Z',
    }),
    assistantMessage('You can record with OBS and I will edit the video afterwards', {
      cwd: '/tmp/alpha',
      timestamp: '2026-01-01T00:05:00.000Z',
    }),
  ]);

  writeSession(fixture.projectsDir, '-tmp-beta', 'beta', [
    aiTitle('Invoices'),
    userMessage('a later conversation about invoices and billing', {
      cwd: '/tmp/beta',
      timestamp: '2026-02-01T00:00:00.000Z',
    }),
  ]);

  writeSession(fixture.projectsDir, '-tmp-xss', 'xss', [
    aiTitle(XSS_TEXT),
    userMessage(XSS_TEXT, { cwd: '/tmp/xss', timestamp: '2026-03-01T00:00:00.000Z' }),
  ]);

  // Escape sequences a transcript can carry: OSC (which can drive the
  // clipboard), BEL and SGR colour.
  writeSession(fixture.projectsDir, '-tmp-esc', 'esc', [
    aiTitle(`${ESCAPE_TEXT} titled`),
    userMessage(`recording videos ${ESCAPE_TEXT} in the body`, {
      cwd: '/tmp/esc',
      timestamp: '2026-03-02T00:00:00.000Z',
    }),
  ]);

  const longRecords: unknown[] = [aiTitle('A very long session')];
  for (let i = 0; i < LONG_MESSAGE_COUNT; i += 1) {
    const stamp = new Date(Date.UTC(2026, 3, 1) + i * 60_000).toISOString();
    longRecords.push(
      (i % 2 === 0 ? userMessage : assistantMessage)(`long session message number ${i} about pagination`, {
        cwd: '/tmp/long',
        timestamp: stamp,
      }),
    );
  }
  writeSession(fixture.projectsDir, '-tmp-long', 'longsess', longRecords);

  const db = openFixtureDb(fixture);
  await sync({ db, projectsDir: fixture.projectsDir });

  const handle = await startWebServer({
    port: 0,
    db,
    dbPath: fixture.dbPath,
    appHome: fixture.home,
    projectsDir: fixture.projectsDir,
    embedder: fakeEmbedder(),
    // This fixture is about the API surface, so embedding stays something a
    // test asks for explicitly (see instance.test.ts for the automatic run),
    // and nothing here claims to be the machine's one running server.
    autoEmbed: false,
    announce: false,
  });

  return { fixture, db, handle, port: handle.port, longMessageCount: LONG_MESSAGE_COUNT };
}

export async function stopFixtureServer(web: WebFixture): Promise<void> {
  await web.handle.close();
  web.db.close();
}
