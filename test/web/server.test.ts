import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, makeFixture, openFixtureDb } from '../helpers.js';
import { isAllowedHost, isSameOrigin } from '../../src/web/server.js';
import { resolveStaticFile, STATIC_DIR } from '../../src/web/static.js';
import { startWebServer, transcriptUrl } from '../../src/web/index.js';
import { request } from './web-helpers.js';

afterAll(cleanupTempDirs);

const STATIC_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'static');

function readAsset(name: string): string {
  return fs.readFileSync(path.join(STATIC_SRC, name), 'utf8');
}

describe('startWebServer', () => {
  it('falls back to the next free port when the requested one is busy', async () => {
    const blocker = net.createServer();
    const busyPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        resolve((blocker.address() as net.AddressInfo).port);
      });
    });

    const fixture = makeFixture();
    const db = openFixtureDb(fixture);
    const handle = await startWebServer({ port: busyPort, db, dbPath: fixture.dbPath, appHome: fixture.home });
    try {
      expect(handle.port).toBeGreaterThan(busyPort);
      expect(handle.port).toBeLessThanOrEqual(busyPort + 10);
      expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);
      expect((await request(handle.port, '/api/status')).status).toBe(200);
    } finally {
      await handle.close();
      db.close();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('close() frees the port', async () => {
    const fixture = makeFixture();
    const db = openFixtureDb(fixture);
    const handle = await startWebServer({ port: 0, db, dbPath: fixture.dbPath, appHome: fixture.home });
    const port = handle.port;
    await handle.close();
    db.close();

    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    expect(reachable).toBe(false);
  });

  it('transcriptUrl() builds reader links', () => {
    const handle = { url: 'http://127.0.0.1:4777', port: 4777, close: async () => undefined };
    expect(transcriptUrl(handle, 'abc')).toBe('http://127.0.0.1:4777/s/abc');
    expect(transcriptUrl(handle, 'abc', 42)).toBe('http://127.0.0.1:4777/s/abc?m=42');
  });
});

describe('host and origin helpers', () => {
  it('allows only the loopback names on the bound port', () => {
    expect(isAllowedHost('127.0.0.1:4777', 4777)).toBe(true);
    expect(isAllowedHost('localhost:4777', 4777)).toBe(true);
    expect(isAllowedHost('127.0.0.1:4778', 4777)).toBe(false);
    expect(isAllowedHost('evil.com:4777', 4777)).toBe(false);
    expect(isAllowedHost('127.0.0.1', 4777)).toBe(false);
    expect(isAllowedHost(undefined, 4777)).toBe(false);
  });

  it('requires an exact same-origin match', () => {
    expect(isSameOrigin('http://127.0.0.1:4777', '127.0.0.1:4777', 4777)).toBe(true);
    expect(isSameOrigin('https://127.0.0.1:4777', '127.0.0.1:4777', 4777)).toBe(false);
    expect(isSameOrigin('http://localhost:4777', '127.0.0.1:4777', 4777)).toBe(false);
    expect(isSameOrigin(undefined, '127.0.0.1:4777', 4777)).toBe(false);
  });
});

describe('static file resolution', () => {
  it('resolves the whitelist only', () => {
    expect(resolveStaticFile('/')?.filePath).toBe(path.join(STATIC_DIR, 'index.html'));
    expect(resolveStaticFile('/app.js')?.contentType).toBe('text/javascript; charset=utf-8');
    expect(resolveStaticFile('/s/alpha')?.filePath).toBe(path.join(STATIC_DIR, 'index.html'));
  });

  it('refuses anything else, including traversal and null bytes', () => {
    for (const p of [
      '/../package.json',
      '/..%2fpackage.json',
      '/app.js\0.png',
      '/s/../secret',
      '/s/a\0b',
      '/etc/passwd',
      '/static/app.js',
      '',
      '/s/',
    ]) {
      expect([p, resolveStaticFile(p)]).toEqual([p, null]);
    }
  });

  it('resolves the static dir relative to the module, so dist and src both work', () => {
    expect(fs.existsSync(path.join(STATIC_DIR, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), 'dist', 'web', 'static', 'index.html'))).toBe(true);
  });
});

describe('the page itself', () => {
  it('app.js never injects HTML and never evaluates strings', () => {
    const source = readAsset('app.js');
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) {
      // The banner comment names these on purpose; strip comments before checking.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect([forbidden, code.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  it('app.js builds highlights from ranges with textContent', () => {
    const source = readAsset('app.js');
    expect(source).toContain('function appendHighlighted');
    expect(source).toContain('createTextNode');
  });

  it('index.html has no inline script, style or event handler', () => {
    const html = readAsset('index.html');
    expect(/<script(?![^>]*\ssrc=)/i.test(html)).toBe(false);
    expect(/<style/i.test(html)).toBe(false);
    expect(/\sstyle=/i.test(html)).toBe(false);
    expect(/\son[a-z]+\s*=/i.test(html)).toBe(false);
    expect(html).toContain('<link rel="stylesheet" href="/styles.css" />');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('styles.css defines four colour roles, six spacing tokens and a dark scheme', () => {
    const css = readAsset('styles.css');
    for (const token of ['--base:', '--base-content:', '--base-content-secondary:', '--primary:']) {
      expect(css).toContain(token);
    }
    const spacing = css.match(/--s\d:/g) ?? [];
    expect(new Set(spacing).size).toBe(6);
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('--measure: 680px');
    // No pure black or pure white as a colour role.
    expect(/#000\b|#000000\b/.test(css)).toBe(false);
  });
});

/* ------------------------------------------------- adversarial review fixes */

describe('loopback host check on port 80 (should-fix 12)', () => {
  it('accepts the bare loopback names only when the server is on port 80', () => {
    expect(isAllowedHost('127.0.0.1', 80)).toBe(true);
    expect(isAllowedHost('localhost', 80)).toBe(true);
    expect(isAllowedHost('127.0.0.1:80', 80)).toBe(true);
    expect(isAllowedHost('localhost:80', 80)).toBe(true);

    // Everything else is still refused, on 80 and elsewhere.
    expect(isAllowedHost('evil.com', 80)).toBe(false);
    expect(isAllowedHost('127.0.0.1:4777', 80)).toBe(false);
    expect(isAllowedHost('127.0.0.1', 4777)).toBe(false);
    expect(isAllowedHost('localhost', 4777)).toBe(false);
    expect(isAllowedHost(undefined, 80)).toBe(false);
  });

  it('accepts the matching origin on port 80 for the one POST route', () => {
    expect(isSameOrigin('http://127.0.0.1', '127.0.0.1', 80)).toBe(true);
    expect(isSameOrigin('http://localhost', 'localhost', 80)).toBe(true);
    expect(isSameOrigin('http://evil.com', '127.0.0.1', 80)).toBe(false);
    expect(isSameOrigin('https://127.0.0.1', '127.0.0.1', 80)).toBe(false);
  });
});

describe('the markdown reader is still injection-proof (feature 13)', () => {
  it('bans HTML injection in every static script, not just app.js', () => {
    const scripts = fs.readdirSync(STATIC_SRC).filter((name) => name.endsWith('.js'));
    expect(scripts.sort()).toEqual(['app.js', 'markdown.js']);
    for (const name of scripts) {
      const code = readAsset(name)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) {
        expect([name, forbidden, code.includes(forbidden)]).toEqual([name, forbidden, false]);
      }
    }
  });

  it('parses markdown outside the DOM and renders it with createElement only', () => {
    const markdown = readAsset('markdown.js');
    expect(markdown).not.toContain('document');
    expect(markdown).toContain('export function parseMarkdown');

    const app = readAsset('app.js');
    expect(app).toContain("import { parseMarkdown } from './markdown.js'");
    expect(app).toContain('function renderMarkdown');
    // The reader renders markdown; result snippets keep their raw text because
    // the highlight ranges index into it.
    expect(app).toMatch(/renderMarkdown\(body, message\.text\)/);
    expect(app).toContain('appendHighlighted(snippet, result.snippet.text, result.snippet.highlights)');
  });

  it('serves markdown.js and nothing else new', () => {
    expect(resolveStaticFile('/markdown.js')).toEqual({
      filePath: path.join(STATIC_DIR, 'markdown.js'),
      contentType: 'text/javascript; charset=utf-8',
    });
    expect(resolveStaticFile('/markdown.d.ts')).toBeNull();
    expect(readAsset('index.html')).toContain('<script src="/markdown.js" type="module" defer></script>');
  });

  it('shows no match count on a browse card (ux 7)', () => {
    const app = readAsset('app.js');
    expect(app).toContain('if (state.q && result.matchCount > 0) bits.push(matchCountLabel(result.matchCount));');
    expect(app).toContain("return count === 1 ? '1 message mentions this' : count + ' messages mention this';");
    expect(app).not.toContain("' matches'");
  });
});
