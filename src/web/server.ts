import http from 'node:http';
import { handleApi, HttpError, type JsonResponse, toErrorResponse } from './api.js';
import type { ServerContext } from './context.js';
import { readStaticFile, resolveStaticFile } from './static.js';

/** The loopback address the server is allowed to bind. */
export const BIND_HOST = '127.0.0.1';

/**
 * Sent on every response, including errors.
 *
 * `default-src 'self'` with no `unsafe-inline` is what makes an XSS in a
 * transcript useless: even if text somehow reached the DOM as markup, no inline
 * script or style would run and nothing could be exfiltrated to another origin.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/**
 * Accepts only the loopback names, as a DNS-rebinding guard.
 *
 * On port 80 a browser leaves the port out of `Host` entirely, so the bare
 * names are accepted there and only there.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  if (host === `${BIND_HOST}:${port}` || host === `localhost:${port}`) return true;
  return port === 80 && (host === BIND_HOST || host === 'localhost');
}

/** Same-origin check for the one state-changing endpoint. */
export function isSameOrigin(origin: string | undefined, host: string, port: number): boolean {
  if (origin === undefined || origin === '') return false;
  return origin === `http://${host}` && isAllowedHost(host, port);
}

function send(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  body: Buffer | string,
  extraHeaders: Record<string, string> = {},
  headOnly = false,
): void {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': String(payload.byteLength),
    ...extraHeaders,
  });
  if (headOnly) res.end();
  else res.end(payload);
}

function sendJson(res: http.ServerResponse, response: JsonResponse, headOnly = false, extra = {}): void {
  send(res, response.status, 'application/json; charset=utf-8', JSON.stringify(response.body), extra, headOnly);
}

/** Builds the request listener for one server instance. */
export function createRequestListener(ctx: ServerContext): http.RequestListener {
  return (req, res) => {
    void handleRequest(ctx, req, res).catch((err: unknown) => {
      process.stderr.write(`web: ${(err as Error).stack ?? String(err)}\n`);
      if (!res.headersSent) sendJson(res, { status: 500, body: { error: 'Internal error' } });
      else res.end();
    });
  };
}

async function handleRequest(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const headOnly = method === 'HEAD';
  const rawUrl = req.url ?? '/';

  // 1. Parse the URL. Anything malformed is a 400 with no stack trace.
  let url: URL;
  let pathname: string;
  try {
    if (rawUrl.includes('\0')) throw new HttpError(400, 'Bad request');
    url = new URL(rawUrl, `http://${BIND_HOST}:${ctx.port}`);
    pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('\0')) throw new HttpError(400, 'Bad request');
  } catch {
    sendJson(res, { status: 400, body: { error: 'Bad request' } }, headOnly);
    return;
  }

  // 2. DNS-rebinding guard: only the loopback names this server bound to.
  const host = req.headers.host;
  if (!isAllowedHost(host, ctx.port)) {
    sendJson(res, { status: 403, body: { error: 'Forbidden host' } }, headOnly);
    return;
  }

  // 3. Methods. The single POST is the only non-idempotent route.
  const isEmbed = pathname === '/api/embed';
  if (method !== 'GET' && method !== 'HEAD' && !(method === 'POST' && isEmbed)) {
    sendJson(res, { status: 405, body: { error: 'Method not allowed' } }, headOnly, {
      Allow: isEmbed ? 'POST' : 'GET, HEAD',
    });
    return;
  }

  // 4. Same-origin requirement for the state-changing route (no CORS anywhere).
  if (method === 'POST' && !isSameOrigin(req.headers.origin, host as string, ctx.port)) {
    sendJson(res, { status: 403, body: { error: 'Cross-origin request rejected' } });
    return;
  }

  if (pathname.startsWith('/api/')) {
    req.resume();
    try {
      sendJson(res, await handleApi(ctx, method, pathname, url.searchParams), headOnly);
    } catch (err) {
      if (!(err instanceof HttpError) && !isKnownUserError(err)) {
        process.stderr.write(`web: ${(err as Error).stack ?? String(err)}\n`);
      }
      const response = toErrorResponse(err);
      sendJson(res, response, headOnly, response.status === 405 ? { Allow: isEmbed ? 'POST' : 'GET, HEAD' } : {});
    }
    return;
  }

  const file = resolveStaticFile(pathname);
  if (file === null) {
    sendJson(res, { status: 404, body: { error: 'Not found' } }, headOnly);
    return;
  }
  const contents = readStaticFile(file);
  if (contents === null) {
    sendJson(res, { status: 404, body: { error: 'Not found' } }, headOnly);
    return;
  }
  send(res, 200, file.contentType, contents, {}, headOnly);
}

function isKnownUserError(err: unknown): boolean {
  return err instanceof Error && err.name === 'UserError';
}

/**
 * Binds `127.0.0.1:<port>`, walking up to `attempts` further ports when the
 * requested one is busy. Port 0 asks the OS for an ephemeral port.
 */
export function listenWithFallback(
  server: http.Server,
  port: number,
  attempts = 10,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let current = port;
    let tried = 0;

    const onError = (err: NodeJS.ErrnoException): void => {
      if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && port !== 0 && tried < attempts) {
        tried += 1;
        current = port + tried;
        server.listen(current, BIND_HOST);
        return;
      }
      cleanup();
      reject(err);
    };
    const onListening = (): void => {
      const address = server.address();
      cleanup();
      resolve(typeof address === 'object' && address !== null ? address.port : current);
    };
    const cleanup = (): void => {
      server.off('error', onError);
      server.off('listening', onListening);
    };

    server.on('error', onError);
    server.on('listening', onListening);
    server.listen(current, BIND_HOST);
  });
}
