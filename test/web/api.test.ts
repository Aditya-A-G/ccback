import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionResult } from '../../src/core/index.js';
import { startWebServer } from '../../src/web/index.js';
import { cleanupTempDirs } from '../helpers.js';
import {
  LONG_MESSAGE_COUNT,
  request,
  startFixtureServer,
  stopFixtureServer,
  XSS_TEXT,
  ESCAPE_TEXT,
  type WebFixture,
} from './web-helpers.js';

let web: WebFixture;

beforeAll(async () => {
  web = await startFixtureServer();
});

afterAll(async () => {
  await stopFixtureServer(web);
  cleanupTempDirs();
});

const get = (path: string): ReturnType<typeof request> => request(web.port, path);

describe('GET /api/search', () => {
  it('finds a session by what was said', async () => {
    const res = await get('/api/search?q=recording%20videos');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    const results = res.json() as SessionResult[];
    expect(results[0]?.sessionId).toBe('alpha');
    expect(results[0]?.title).toBe('Recording and editing videos');
    expect(results[0]?.resumeCommand).toBe("cd '/tmp/alpha' && claude --resume 'alpha'");
    expect(results[0]?.snippet.highlights.length).toBeGreaterThan(0);
  });

  it('empty q returns the most recent sessions', async () => {
    const results = (await get('/api/search?q=&limit=4')).json() as SessionResult[];
    expect(results.map((r) => r.sessionId)).toEqual(['longsess', 'esc', 'xss', 'beta']);
  });

  it('missing q behaves like an empty q', async () => {
    const results = (await get('/api/search?limit=1')).json() as SessionResult[];
    expect(results.map((r) => r.sessionId)).toEqual(['longsess']);
  });

  it('applies the cwd filter', async () => {
    const results = (await get('/api/search?q=&cwd=%2Ftmp%2Fbeta')).json() as SessionResult[];
    expect(results.map((r) => r.sessionId)).toEqual(['beta']);
  });

  it('applies date and role filters', async () => {
    const since = (await get('/api/search?q=invoices&since=2026-01-15')).json() as SessionResult[];
    expect(since.map((r) => r.sessionId)).toEqual(['beta']);

    const until = (await get('/api/search?q=invoices&until=2026-01-15')).json() as SessionResult[];
    expect(until).toEqual([]);

    const assistant = (await get('/api/search?q=recording&role=assistant')).json() as SessionResult[];
    expect(assistant.every((r) => r.snippet.role === 'assistant')).toBe(true);
  });

  it('honours limit', async () => {
    const results = (await get('/api/search?q=&limit=2')).json() as SessionResult[];
    expect(results).toHaveLength(2);
  });

  it('returns transcript markup as inert JSON, never as HTML', async () => {
    const res = await get('/api/search?q=recording');
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const results = res.json() as SessionResult[];
    const hit = results.find((r) => r.sessionId === 'xss');
    expect(hit).toBeDefined();
    expect(hit?.title).toBe(XSS_TEXT);
    // The bytes are present, but only as a JSON string value in a JSON response.
    expect(res.body).toContain(JSON.stringify(XSS_TEXT).slice(1, -1));
    expect(res.body.startsWith('[')).toBe(true);
  });

  it('serves the HTML shell without any transcript text in it', async () => {
    const page = await get('/');
    expect(page.status).toBe(200);
    expect(page.body).not.toContain('onerror');
    expect(page.body).not.toContain('alert(1)');
  });
});

describe('GET /api/sessions/:id', () => {
  it('returns meta and the first page of messages', async () => {
    const res = await get('/api/sessions/alpha');
    expect(res.status).toBe(200);
    const body = res.json() as { session: { cwd: string; cwdExists: boolean }; messages: unknown[]; total: number };
    expect(body.session.cwd).toBe('/tmp/alpha');
    expect(body.session.cwdExists).toBe(false);
    expect(body.total).toBe(2);
    expect(body.messages).toHaveLength(2);
  });

  it('paginates a session with hundreds of messages', async () => {
    const first = (await get('/api/sessions/longsess')).json() as {
      total: number;
      messages: { id: number; text: string }[];
      limit: number;
    };
    expect(first.total).toBe(LONG_MESSAGE_COUNT);
    expect(first.limit).toBe(200);
    expect(first.messages).toHaveLength(200);
    expect(first.messages[0]?.text).toContain('number 0 ');

    const second = (await get('/api/sessions/longsess?offset=200&limit=200')).json() as {
      messages: { id: number; text: string }[];
    };
    expect(second.messages).toHaveLength(200);
    expect(second.messages[0]?.text).toContain('number 200 ');
    expect(second.messages[0]?.id).toBe((first.messages[199]?.id ?? 0) + 1);

    const last = (await get('/api/sessions/longsess?offset=400&limit=200')).json() as {
      messages: unknown[];
    };
    expect(last.messages).toHaveLength(LONG_MESSAGE_COUNT - 400);

    const past = (await get('/api/sessions/longsess?offset=1000')).json() as { messages: unknown[] };
    expect(past.messages).toEqual([]);
  });

  it('404s an unknown session', async () => {
    const res = await get('/api/sessions/nope');
    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: 'Session not found' });
  });
});

describe('GET /api/folders', () => {
  it('lists distinct folders with counts', async () => {
    const res = await get('/api/folders');
    expect(res.status).toBe(200);
    const folders = res.json() as { cwd: string; sessionCount: number; exists: boolean }[];
    expect(folders.map((f) => f.cwd).sort()).toEqual(['/tmp/alpha', '/tmp/beta', '/tmp/esc', '/tmp/long', '/tmp/xss']);
    expect(folders.every((f) => f.exists === false)).toBe(true);
  });
});

describe('GET /api/status', () => {
  it('reports counts, modes and embedding progress', async () => {
    const res = await get('/api/status');
    expect(res.status).toBe(200);
    const body = res.json() as {
      sessions: number;
      messages: number;
      projectsDir: string;
      availableModes: string[];
      embedding: { running: boolean; embedded: number };
      canEmbed: boolean;
    };
    expect(body.sessions).toBe(5);
    expect(body.messages).toBe(LONG_MESSAGE_COUNT + 5);
    expect(body.projectsDir).toBe(web.fixture.projectsDir);
    expect(body.availableModes).toEqual(['auto', 'keyword']);
    expect(body.canEmbed).toBe(true);
    expect(body.embedding.running).toBe(false);
  });

  it('reports no notice for a server that was not given one', async () => {
    expect((await get('/api/status')).json()).toMatchObject({ notice: null });
  });

  it('reports the startup notice so the page can show it', async () => {
    // `ccfind -w --no-sync --projects-dir <elsewhere>` hands the sentence to
    // the server, which is the only way the page can ever learn about it.
    const notice = '--no-sync: this index was built from /tmp/recorded, not /tmp/asked.';
    const handle = await startWebServer({
      port: 0,
      db: web.db,
      dbPath: web.fixture.dbPath,
      appHome: web.fixture.home,
      projectsDir: web.fixture.projectsDir,
      autoEmbed: false,
      announce: false,
      notice,
    });
    try {
      expect((await request(handle.port, '/api/status')).json()).toMatchObject({ notice });
    } finally {
      await handle.close();
    }
  });
});

describe('POST /api/embed', () => {
  const origin = (): Record<string, string> => ({ Origin: `http://127.0.0.1:${web.port}` });

  it('starts embedding, reports progress and unlocks semantic modes', async () => {
    const started = await request(web.port, '/api/embed', { method: 'POST', headers: origin() });
    expect(started.status).toBe(202);
    expect((started.json() as { started: boolean }).started).toBe(true);

    let body: { embedding: { running: boolean }; chunksEmbedded: number; chunks: number; availableModes: string[] };
    for (let i = 0; i < 200; i += 1) {
      body = (await get('/api/status')).json() as typeof body;
      if (!body.embedding.running) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(body!.embedding.running).toBe(false);
    expect(body!.chunksEmbedded).toBe(body!.chunks);
    expect(body!.chunks).toBeGreaterThan(0);
    expect(body!.availableModes).toEqual(['auto', 'keyword', 'semantic', 'hybrid']);

    const hybrid = (await get('/api/search?q=recording%20videos&mode=hybrid')).json() as SessionResult[];
    expect(hybrid.length).toBeGreaterThan(0);
    expect(hybrid.some((r) => r.sources.includes('semantic'))).toBe(true);

    const semantic = (await get('/api/search?q=recording%20videos&mode=semantic')).json() as SessionResult[];
    expect(semantic.length).toBeGreaterThan(0);
  });
});

describe('parameter validation', () => {
  const cases: [string, string][] = [
    ['/api/search?q=x&mode=evil', 'mode must be auto, keyword, semantic or hybrid'],
    ['/api/search?q=x&role=root', 'role must be user or assistant'],
    ['/api/search?q=x&limit=abc', 'limit must be an integer'],
    ['/api/search?q=x&limit=0', 'limit must be between 1 and 100'],
    ['/api/search?q=x&limit=10000', 'limit must be between 1 and 100'],
    ['/api/search?q=x&since=not-a-date', 'since is not a valid date'],
    ['/api/search?q=x&until=13-13-2026', 'until is not a valid date'],
    ['/api/sessions/alpha?offset=-1', 'offset must be between 0'],
    ['/api/sessions/alpha?limit=0', 'limit must be between 1 and 500'],
    ['/api/sessions/not%20a%20valid%20id!', 'Invalid session id'],
  ];

  it.each(cases)('400s %s without a stack trace', async (path, message) => {
    const res = await get(path);
    expect(res.status).toBe(400);
    const body = res.json() as { error: string };
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toContain(message);
    expect(res.body).not.toContain('at ');
    expect(res.body.toLowerCase()).not.toContain('node:internal');
  });

  it('404s an unknown api route', async () => {
    const res = await get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found' });
  });
});

/* ------------------------------------------------- adversarial review fixes */

describe('hostile transcript text over the API', () => {
  it('never returns an ESC or BEL byte in any string (must-fix 2)', async () => {
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk((await get('/api/search?q=recording%20videos')).json());
    walk((await get('/api/sessions/esc')).json());
    walk((await get('/api/folders')).json());

    expect(strings.some((s) => s.includes('titled'))).toBe(true);
    expect(strings.filter((s) => /[\u001b\u0007]/.test(s))).toEqual([]);
    expect(ESCAPE_TEXT).toMatch(/\u001b/);
  });

  it('every session it returns has a routable id and an absolute folder (must-fix 1 and 3)', async () => {
    const results = (await get('/api/search?q=')).json() as SessionResult[];
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.sessionId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
      expect(result.cwd.startsWith('/')).toBe(true);
      // The id the search returned really does resolve in the reader.
      expect((await request(web.port, `/api/sessions/${result.sessionId}`)).status).toBe(200);
    }
  });
});

describe('GET /api/status tells the page which emptiness it is (ux 6)', () => {
  it('reports that the transcripts directory exists', async () => {
    const body = (await get('/api/status')).json() as {
      projectsDirExists: boolean;
      projectsDirHint: string | null;
    };
    expect(body.projectsDirExists).toBe(true);
    expect(body.projectsDirHint).toBeNull();
  });
});
