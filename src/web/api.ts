import {
  APP_NAME,
  getSession,
  INSTALL_HINT,
  isTransformersAvailable,
  isUserError,
  listFolders,
  NO_EMBEDDINGS_HINT,
  normalizeBound,
  recentSessions,
  type SearchMode,
  search,
  semanticStatus,
  type SortOrder,
  status,
} from '../core/index.js';
import type { ServerContext } from './context.js';
import { NONCE_RE, proofFor } from './instance.js';
import { isValidSessionId } from './static.js';

/** An error that maps straight onto a status code and a `{ error }` body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

const MAX_PARAM_LENGTH = 4096;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 500;

function requireShort(name: string, value: string): string {
  if (value.length > MAX_PARAM_LENGTH) throw new HttpError(400, `${name} is too long`);
  if (value.includes('\0')) throw new HttpError(400, `${name} contains an invalid character`);
  return value;
}

function optionalString(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name);
  if (raw === null || raw === '') return undefined;
  return requireShort(name, raw);
}

function parseInteger(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  requireShort(name, raw);
  if (!/^-?\d+$/.test(raw)) throw new HttpError(400, `${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  }
  return value;
}

/**
 * The page never sends a mode: there is no mode control any more. The
 * parameter is still honoured for anybody driving the API by hand.
 */
function parseMode(params: URLSearchParams): SearchMode {
  const raw = params.get('mode');
  if (raw === null || raw === '') return 'auto';
  if (raw === 'auto' || raw === 'keyword' || raw === 'semantic' || raw === 'hybrid') return raw;
  throw new HttpError(400, 'mode must be auto, keyword, semantic or hybrid');
}

function parseSort(params: URLSearchParams): SortOrder {
  const raw = params.get('sort');
  if (raw === null || raw === '') return 'relevance';
  if (raw === 'relevance' || raw === 'recent') return raw;
  throw new HttpError(400, 'sort must be relevance or recent');
}

function parseRole(params: URLSearchParams): 'user' | 'assistant' | undefined {
  const raw = params.get('role');
  if (raw === null || raw === '') return undefined;
  if (raw === 'user' || raw === 'assistant') return raw;
  throw new HttpError(400, 'role must be user or assistant');
}

function parseDate(params: URLSearchParams, name: string, edge: 'start' | 'end'): string | undefined {
  const raw = optionalString(params, name);
  if (raw === undefined) return undefined;
  try {
    normalizeBound(raw, edge);
  } catch {
    throw new HttpError(400, `${name} is not a valid date`);
  }
  return raw;
}

/** `GET /api/search` — validated query parameters. */
export async function searchRoute(ctx: ServerContext, params: URLSearchParams): Promise<JsonResponse> {
  const query = optionalString(params, 'q') ?? '';
  const mode = parseMode(params);
  const sort = parseSort(params);
  const limit = parseInteger(params, 'limit', DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  const cwdPrefix = optionalString(params, 'cwd');
  const since = parseDate(params, 'since', 'start');
  const until = parseDate(params, 'until', 'end');
  const role = parseRole(params);

  if (query.trim() === '') {
    // Recent sessions are already in "most recent" order; the sort control
    // only has something to change once there is a ranking.
    return { status: 200, body: recentSessions({ db: ctx.db, limit, cwdPrefix, since, until, role }) };
  }
  const results = await search({
    db: ctx.db,
    appHome: ctx.appHome,
    query,
    mode,
    sort,
    limit,
    cwdPrefix,
    since,
    until,
    role,
    embedder: ctx.embedder,
  });
  return { status: 200, body: results };
}

/** `GET /api/sessions/:id` — session meta plus one page of messages. */
export function sessionRoute(ctx: ServerContext, sessionId: string, params: URLSearchParams): JsonResponse {
  if (!isValidSessionId(sessionId)) throw new HttpError(400, 'Invalid session id');
  const offset = parseInteger(params, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = parseInteger(params, 'limit', DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT);
  const transcript = getSession(sessionId, { db: ctx.db, offset, limit });
  if (transcript === null) throw new HttpError(404, 'Session not found');
  return { status: 200, body: transcript };
}

/** `GET /api/folders` — distinct folders with session counts. */
export function foldersRoute(ctx: ServerContext): JsonResponse {
  return { status: 200, body: listFolders({ db: ctx.db }) };
}

/**
 * `GET /api/status` — counts, capabilities and embedding progress.
 *
 * With `?nonce=…` it also answers `sha256(token + nonce)`, which is how a
 * second ccfind tells this server from any other local process that might be
 * squatting the recorded port. The token itself is never in the response, so
 * the page — and anything that somehow read the page — learns nothing reusable.
 */
export function statusRoute(ctx: ServerContext, params?: URLSearchParams): JsonResponse {
  const nonce = params?.get('nonce') ?? '';
  const auth =
    ctx.token !== undefined && NONCE_RE.test(nonce) ? { auth: proofFor(ctx.token, nonce) } : {};
  const base = status({
    db: ctx.db,
    dbPath: ctx.dbPath,
    appHome: ctx.appHome,
    projectsDir: ctx.projectsDir,
  });
  const semantic = semanticStatus({ db: ctx.db, embedder: ctx.embedder });
  const embeddingsReady = base.chunksEmbedded > 0;
  const semanticUsable = embeddingsReady && semantic.runtimeInstalled;
  return {
    status: 200,
    body: {
      ...base,
      // How a probe tells our server from whatever else is on that port.
      app: APP_NAME,
      ...auth,
      semantic,
      availableModes: semanticUsable ? ['auto', 'keyword', 'semantic', 'hybrid'] : ['auto', 'keyword'],
      embeddingsReady,
      canEmbed: semantic.runtimeInstalled,
      installHint: INSTALL_HINT,
      noEmbeddingsHint: NO_EMBEDDINGS_HINT,
      embedding: ctx.job.snapshot(),
    },
  };
}

/** `POST /api/embed` — starts or continues semantic indexing in the background. */
export function embedRoute(ctx: ServerContext): JsonResponse {
  if (ctx.embedder === undefined && !isTransformersAvailable()) {
    throw new HttpError(409, INSTALL_HINT);
  }
  const started = ctx.job.start({ db: ctx.db, embedder: ctx.embedder, appHome: ctx.appHome });
  return { status: started ? 202 : 200, body: { started, embedding: ctx.job.snapshot() } };
}

/** Routes one `/api/...` request. Throws {@link HttpError} for anything invalid. */
export async function handleApi(
  ctx: ServerContext,
  method: string,
  pathname: string,
  params: URLSearchParams,
): Promise<JsonResponse> {
  if (pathname === '/api/embed') {
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    return embedRoute(ctx);
  }
  if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

  if (pathname === '/api/search') return searchRoute(ctx, params);
  if (pathname === '/api/folders') return foldersRoute(ctx);
  if (pathname === '/api/status') return statusRoute(ctx, params);
  if (pathname.startsWith('/api/sessions/')) {
    return sessionRoute(ctx, pathname.slice('/api/sessions/'.length), params);
  }
  throw new HttpError(404, 'Not found');
}

/** Turns any thrown value into a status plus a safe message. Never leaks a stack. */
export function toErrorResponse(err: unknown): JsonResponse {
  if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
  if (isUserError(err)) {
    const setup = err.message === NO_EMBEDDINGS_HINT || err.message === INSTALL_HINT;
    return { status: setup ? 409 : 400, body: { error: err.message } };
  }
  return { status: 500, body: { error: 'Internal error' } };
}
