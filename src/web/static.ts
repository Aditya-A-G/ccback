import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Directory holding index.html / app.js / styles.css. Resolved from this
 * module's own URL so it works from `src/` (tests, tsx) and from `dist/`
 * (the build copies the folder with scripts/copy-static.mjs).
 */
export const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');

/**
 * Session ids as they appear in routes. The *same* validator the indexer uses,
 * so a session that made it into the index always has a routable page: no
 * search result can be a dead link, and no unroutable id can be indexed.
 */
export { isValidSessionId, SESSION_ID_RE } from '../core/session-id.js';
import { isValidSessionId } from '../core/session-id.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * The complete list of servable files. A whitelist rather than a path join,
 * because there is no way to escape a whitelist: `/../etc/passwd`,
 * `/%2e%2e/%2e%2e/etc/passwd` and `//etc/passwd` all simply fail to match.
 */
const ROUTES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/markdown.js': 'markdown.js',
  '/styles.css': 'styles.css',
  '/favicon.svg': 'favicon.svg',
};

export interface StaticFile {
  /** Absolute path inside {@link STATIC_DIR}. */
  filePath: string;
  contentType: string;
}

/**
 * Maps an already-decoded URL pathname to a file, or null when nothing may be
 * served. `/s/<id>` renders the same shell as `/`; the page routes itself.
 */
export function resolveStaticFile(pathname: string): StaticFile | null {
  if (pathname.includes('\0')) return null;

  let name = ROUTES[pathname];
  if (name === undefined && pathname.startsWith('/s/')) {
    const id = pathname.slice('/s/'.length);
    if (isValidSessionId(id)) name = 'index.html';
  }
  if (name === undefined) return null;

  // Defence in depth: even with a fixed whitelist, prove the result stays put.
  const filePath = path.join(STATIC_DIR, name);
  const root = STATIC_DIR.endsWith(path.sep) ? STATIC_DIR : STATIC_DIR + path.sep;
  if (!filePath.startsWith(root)) return null;

  return { filePath, contentType: CONTENT_TYPES[path.extname(name)] ?? 'application/octet-stream' };
}

/** Reads a whitelisted file. Returns null when the build is incomplete. */
export function readStaticFile(file: StaticFile): Buffer | null {
  try {
    return fs.readFileSync(file.filePath);
  } catch {
    return null;
  }
}
