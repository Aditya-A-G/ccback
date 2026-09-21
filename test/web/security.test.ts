import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../helpers.js';
import { request, startFixtureServer, stopFixtureServer, type WebFixture } from './web-helpers.js';

let web: WebFixture;

beforeAll(async () => {
  web = await startFixtureServer();
});

afterAll(async () => {
  await stopFixtureServer(web);
  cleanupTempDirs();
});

const hostHeader = (): Record<string, string> => ({ Host: `127.0.0.1:${web.port}` });

describe('binding', () => {
  it('serves on 127.0.0.1 only', async () => {
    expect(web.handle.url).toBe(`http://127.0.0.1:${web.port}`);
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '::1', port: web.port });
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(1500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    expect(reachable).toBe(false);
  });
});

describe('Host header guard', () => {
  it('accepts 127.0.0.1 and localhost on the bound port', async () => {
    expect((await request(web.port, '/api/status', { headers: hostHeader() })).status).toBe(200);
    expect(
      (await request(web.port, '/api/status', { headers: { Host: `localhost:${web.port}` } })).status,
    ).toBe(200);
  });

  it('rejects any other Host with 403', async () => {
    for (const host of ['evil.com', `evil.com:${web.port}`, '127.0.0.1', `127.0.0.1:${web.port + 1}`, 'localhost']) {
      const res = await request(web.port, '/api/status', { headers: { Host: host } });
      expect([host, res.status]).toEqual([host, 403]);
      expect(res.json()).toEqual({ error: 'Forbidden host' });
    }
  });

  it('rejects a request with no Host header', async () => {
    // Node's own HTTP/1.1 parser answers 400 before the handler runs; either way
    // the request is refused and nothing is served.
    const res = await request(web.port, '/api/status', { setHost: false });
    expect([400, 403]).toContain(res.status);
    expect(res.body).not.toContain('projectsDir');
  });

  it('guards the page and static files too', async () => {
    for (const path of ['/', '/app.js', '/styles.css', '/s/alpha']) {
      expect((await request(web.port, path, { headers: { Host: 'evil.com' } })).status).toBe(403);
    }
  });
});

describe('response headers', () => {
  it('sets CSP, nosniff and no-referrer on every response', async () => {
    for (const path of ['/', '/app.js', '/api/status', '/api/nope', '/api/search?q=x&mode=evil']) {
      const res = await request(web.port, path);
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('sets no CORS headers at all', async () => {
    for (const path of ['/', '/api/status', '/api/search?q=recording']) {
      for (const method of ['GET', 'OPTIONS']) {
        const res = await request(web.port, path, {
          method,
          headers: { Origin: 'http://evil.com' },
        });
        const cors = Object.keys(res.headers).filter((k) => k.toLowerCase().startsWith('access-control-'));
        expect(cors).toEqual([]);
      }
    }
  });
});

describe('methods', () => {
  it('405s every non-GET/HEAD method except POST /api/embed', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const res = await request(web.port, '/api/status', { method });
      expect([method, res.status]).toEqual([method, 405]);
      expect(res.headers['allow']).toBe('GET, HEAD');
    }
    const post = await request(web.port, '/api/search?q=x', { method: 'POST' });
    expect(post.status).toBe(405);

    const postPage = await request(web.port, '/', { method: 'POST' });
    expect(postPage.status).toBe(405);

    const wrongOnEmbed = await request(web.port, '/api/embed', { method: 'GET' });
    expect(wrongOnEmbed.status).toBe(405);
    expect(wrongOnEmbed.headers['allow']).toBe('POST');
  });

  it('answers HEAD with headers and no body', async () => {
    const res = await request(web.port, '/', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-security-policy']).toBeDefined();
  });
});

describe('POST /api/embed origin check', () => {
  it('rejects a missing Origin', async () => {
    const res = await request(web.port, '/api/embed', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(res.json()).toEqual({ error: 'Cross-origin request rejected' });
  });

  it('rejects a foreign or mismatched Origin', async () => {
    for (const origin of [
      'http://evil.com',
      'null',
      `https://127.0.0.1:${web.port}`,
      `http://127.0.0.1:${web.port + 1}`,
      `http://localhost:${web.port}`,
    ]) {
      const res = await request(web.port, '/api/embed', {
        method: 'POST',
        headers: { Origin: origin, Host: `127.0.0.1:${web.port}` },
      });
      expect([origin, res.status]).toEqual([origin, 403]);
    }
  });

  it('accepts the server s own origin', async () => {
    const res = await request(web.port, '/api/embed', {
      method: 'POST',
      headers: { Host: `localhost:${web.port}`, Origin: `http://localhost:${web.port}` },
    });
    expect([200, 202]).toContain(res.status);
  });
});

describe('static file serving', () => {
  it('serves exactly three files plus the page shell', async () => {
    expect((await request(web.port, '/')).status).toBe(200);
    expect((await request(web.port, '/index.html')).status).toBe(200);
    expect((await request(web.port, '/app.js')).headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect((await request(web.port, '/styles.css')).headers['content-type']).toBe('text/css; charset=utf-8');
    expect((await request(web.port, '/s/alpha')).headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('cannot be walked out of the static directory', async () => {
    const attacks = [
      '/../package.json',
      '/../../etc/passwd',
      '/%2e%2e/package.json',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/static/../../package.json',
      '//etc/passwd',
      '/app.js%00.png',
      '/%00',
      '/.env',
      '/dist/cli.js',
      '/s/../../package.json',
      '/s/alpha/../../../package.json',
    ];
    for (const path of attacks) {
      const res = await request(web.port, path);
      expect([path, res.status === 404 || res.status === 400]).toEqual([path, true]);
      expect(res.body).not.toContain('session-finder —');
      expect(res.body).not.toContain('"better-sqlite3"');
      expect(res.body).not.toContain('root:');
    }
  });

  it('rejects an invalid session id in the page route', async () => {
    expect((await request(web.port, '/s/has%20a%20space')).status).toBe(404);
    expect((await request(web.port, '/s/')).status).toBe(404);
  });
});
