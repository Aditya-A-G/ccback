/**
 * Local web UI: `ccfind --web`.
 *
 * A `node:http` server on 127.0.0.1 serving a read-only JSON API plus three
 * static files. It reads the index through the core public API and never
 * writes to the Claude directory.
 *
 * ```ts
 * const handle = await startWebServer({ port: 4777 });
 * console.log(handle.url);                    // http://127.0.0.1:4777
 * await handle.close();
 * ```
 */
import http from 'node:http';
import type { WebOptions } from '../cli.js';
import {
  type Db,
  type Embedder,
  getSharedDatabase,
  type KeywordOnlySource,
  missingProjectsDirMessage,
  NO_SESSIONS_YET,
  projectsDirExists,
  projectsDirMismatch,
  recentSessions,
  resolveIndexPath,
  resolveProjectsDir,
  SIGINT_EXIT_CODE,
  sync,
} from '../core/index.js';
import type { ServerContext } from './context.js';
import { EmbedJob } from './embed-job.js';
import { clearInstanceFile, findRunningWeb, searchUrl, writeInstanceFile } from './instance.js';
import { openInBrowser } from './open.js';

export { openInBrowser };
import { BIND_HOST, createRequestListener, listenWithFallback } from './server.js';

export type { EmbedJobState } from './embed-job.js';
export type { ClearInstanceOptions, InstanceFileOptions, ProbeOptions, RunningWeb, WebInstance } from './instance.js';
export {
  clearInstanceFile,
  findRunningWeb,
  isProcessAlive,
  newToken,
  NONCE_RE,
  probe,
  PROBE_MAX_BYTES,
  PROBE_TIMEOUT_MS,
  proofFor,
  readInstanceFile,
  searchUrl,
  TOKEN_RE,
  writeInstanceFile,
} from './instance.js';
export { SECURITY_HEADERS } from './server.js';

/** A running server. `close()` stops it; the index handle stays open. */
export interface WebServerHandle {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface StartWebServerOptions {
  /** Requested port. Busy ports are skipped, up to ten further ports. 0 = ephemeral. */
  port: number;
  /** Transcript directory, only used to report status. */
  projectsDir?: string | undefined;
  /** Overrides `CCFIND_HOME`. */
  appHome?: string | undefined;
  /** Explicit path to `index.db`. */
  dbPath?: string | undefined;
  /** Already-open index handle. */
  db?: Db | undefined;
  /** Injected embedder, so tests never download a model. */
  embedder?: Embedder | undefined;
  /**
   * Record this server in `<app home>/web.json` so a second `--web` and the
   * picker's ^O reuse it. Default true.
   */
  announce?: boolean | undefined;
  /**
   * Start building missing embeddings in the background as soon as the server
   * is up. Default true: smart search is on by default and sets itself up
   * while the user is already searching. Tests turn it off.
   */
  autoEmbed?: boolean | undefined;
  /**
   * One advisory sentence for the page, reported by `/api/status` as `notice`.
   * Used for the `--no-sync` + mismatched `--projects-dir` warning.
   */
  notice?: string | undefined;
  /**
   * The switch that turned smart search off, or null. Overrides `autoEmbed`:
   * a keyword-only server never starts an embedding job, whatever it was asked
   * for, so the promise does not depend on one caller remembering.
   */
  keywordOnly?: KeywordOnlySource | null | undefined;
}

/** How many further ports to try when the requested one is busy. */
export const PORT_FALLBACK_ATTEMPTS = 10;

/** Starts the server on 127.0.0.1 and resolves once it is accepting requests. */
export async function startWebServer(opts: StartWebServerOptions): Promise<WebServerHandle> {
  const dbPath = opts.dbPath ?? resolveIndexPath(opts.appHome);
  const ctx: ServerContext = {
    db: opts.db ?? getSharedDatabase(dbPath),
    port: opts.port,
    projectsDir: opts.projectsDir,
    appHome: opts.appHome,
    dbPath,
    embedder: opts.embedder,
    job: new EmbedJob(),
    notice: opts.notice,
    keywordOnly: opts.keywordOnly ?? null,
  };

  const server = http.createServer(createRequestListener(ctx));
  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  const port = await listenWithFallback(server, opts.port, PORT_FALLBACK_ATTEMPTS);
  ctx.port = port;

  const announce = opts.announce !== false;
  // Written to the marker and proved through `/api/status`; a server that does
  // not announce itself has nothing to prove and no token.
  // Leaving a marker behind would send the next run to a dead port, so it is
  // also cleared on plain process exit: Windows never delivers SIGTERM, and a
  // crash does not run the SIGINT path either.
  let marker: { port: number; token: string } | undefined;
  const onExit = (): void => {
    // Only ever this server's own marker: another one may have replaced it.
    if (marker !== undefined) clearInstanceFile({ appHome: opts.appHome, ...marker });
  };
  if (announce) {
    const instance = writeInstanceFile(port, { appHome: opts.appHome });
    ctx.token = instance.token;
    marker = { port: instance.port, token: instance.token };
    process.on('exit', onExit);
  }

  if (opts.autoEmbed !== false && ctx.keywordOnly === null) {
    // Smart search sets itself up while the user is already searching: keyword
    // results are there from the first keystroke and quietly get better.
    ctx.job.startIfPending({ db: ctx.db, embedder: ctx.embedder, appHome: ctx.appHome });
  }

  return {
    url: `http://${BIND_HOST}:${port}`,
    port,
    async close(): Promise<void> {
      process.off('exit', onExit);
      if (marker !== undefined) clearInstanceFile({ appHome: opts.appHome, ...marker });
      await ctx.job.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Link to the transcript reader, optionally scrolled to one message. Takes
 * anything with a base URL, so it works for a server this process started and
 * for one it found already running.
 */
export function transcriptUrl(handle: { url: string }, sessionId: string, messageId?: number): string {
  const base = `${handle.url}/s/${encodeURIComponent(sessionId)}`;
  return messageId === undefined ? base : `${base}?m=${encodeURIComponent(String(messageId))}`;
}

/**
 * `ccfind --web`: sync, serve, print the URL, open a browser, and stay up
 * until Ctrl-C.
 */
export async function runWeb(opts: WebOptions): Promise<number> {
  // Ctrl+C is how this command ends, and a shell expects 130 from it — a `&&`
  // chain after `ccfind -w` must not carry on as though the user was done.
  //
  // The handlers go on before any other work, not after the URL is printed:
  // until a listener exists Node's default disposition for SIGINT is to kill
  // the process outright, so a Ctrl+C during the startup sync ended the run
  // with no exit code at all. Nothing has been created yet at that point, so
  // an early stop also removes nothing.
  let received: NodeJS.Signals | null = null;
  let announce: (signal: NodeJS.Signals) => void = () => {};
  const stopped = new Promise<NodeJS.Signals>((resolve) => {
    announce = resolve;
  });
  const onSignal =
    (signal: NodeJS.Signals) =>
    (): void => {
      if (received !== null) return;
      received = signal;
      announce(signal);
    };
  const onInt = onSignal('SIGINT');
  const onTerm = onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    return await serveUntilStopped(opts, stopped, () => received);
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}

/** What a shell reports for a process killed by this signal. */
function exitCodeFor(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? SIGINT_EXIT_CODE : SIGTERM_EXIT_CODE;
}

/**
 * The body of {@link runWeb}, with the signal handlers already installed.
 *
 * `alreadyStopped()` is checked after every await: a Ctrl+C that lands while
 * the index is syncing should not go on to open a browser tab.
 */
async function serveUntilStopped(
  opts: WebOptions,
  stopped: Promise<NodeJS.Signals>,
  alreadyStopped: () => NodeJS.Signals | null,
): Promise<number> {
  // A second `--web` is somebody asking to look at this, not asking for a
  // second server on a second port with a second copy of the index open.
  const running = await findRunningWeb();
  {
    const early = alreadyStopped();
    if (early !== null) return exitCodeFor(early);
  }
  if (running !== null) {
    const url = searchUrl(running.url, opts.query);
    process.stdout.write(`${running.url} (already running)\n`);
    if (opts.open) openInBrowser(url);
    return 0;
  }

  const projectsDir = resolveProjectsDir(opts.projectsDir);
  // A missing transcript directory is an empty state the page explains, not a
  // reason to refuse to start the server. A broken index still is.
  let setupHint = projectsDirExists(projectsDir) ? '' : missingProjectsDirMessage(projectsDir);

  if (!opts.noSync && setupHint === '') {
    const result = await sync({ projectsDir: opts.projectsDir });
    if (result.indexedFiles > 0 || result.removedFiles > 0) {
      process.stderr.write(
        `Indexed ${result.indexedFiles} session${result.indexedFiles === 1 ? '' : 's'}` +
          `${result.removedFiles > 0 ? `, removed ${result.removedFiles}` : ''}` +
          ` in ${(result.durationMs / 1000).toFixed(1)}s\n`,
      );
    }
    if (result.failedFiles > 0) {
      const one = result.failedFiles === 1;
      process.stderr.write(
        `Could not read ${result.failedFiles} transcript file${one ? '' : 's'}; ` +
          `${one ? 'it was' : 'they were'} left out and will be retried on the next run.\n`,
      );
    }
  }
  {
    const early = alreadyStopped();
    if (early !== null) return exitCodeFor(early);
  }

  // `--no-sync` with a `--projects-dir` the index was not built from. Said once
  // on stderr at startup, and carried to the page through `/api/status` so the
  // tab that stays open all afternoon still knows where its results came from.
  const notice = opts.noSync ? projectsDirMismatch(opts.projectsDir) : null;
  if (notice !== null) process.stderr.write(`${notice}\n`);

  const handle = await startWebServer({
    port: opts.port,
    projectsDir,
    ...(notice === null ? {} : { notice }),
    // `--keyword-only` (or CCFIND_KEYWORD_ONLY): no background embedding job,
    // and every route answers as though smart search were not there.
    ...(opts.keywordOnly === null ? {} : { keywordOnly: opts.keywordOnly, autoEmbed: false }),
  });

  // A signal that arrived while the server was coming up: it is listening now,
  // so it is closed the same way a Ctrl+C at the prompt would close it, and the
  // marker it just wrote is removed by the same `close()`.
  {
    const early = alreadyStopped();
    if (early !== null) {
      await handle.close();
      return exitCodeFor(early);
    }
  }

  const sessions = recentSessions({ limit: 1 }).length;
  if (setupHint === '' && sessions === 0) setupHint = `${NO_SESSIONS_YET}. Start a Claude Code session and come back.`;
  process.stdout.write(`${handle.url}\n` + (setupHint === '' ? '' : `${setupHint}\n`) + 'Press Ctrl-C to stop.\n');
  if (opts.open) openInBrowser(searchUrl(handle.url, opts.query));

  const signal = await stopped;

  process.stderr.write('\n');
  await handle.close();
  return exitCodeFor(signal);
}

/** What a shell reports for a process killed by SIGTERM. */
export const SIGTERM_EXIT_CODE = 143;
