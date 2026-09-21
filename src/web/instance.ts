/**
 * One browser UI per machine.
 *
 * A running server writes `<app home>/web.json`; anything that wants the
 * browser UI — a second `ccfind --web`, the picker's ^O — reads it, checks the
 * server is really ours and really alive, and reuses it instead of starting a
 * second copy on a second port. A file left behind by a crash is simply
 * overwritten.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { APP_NAME, resolveWebInstancePath } from '../core/index.js';

/** What `web.json` holds. */
export interface WebInstance {
  pid: number;
  port: number;
  /** ISO timestamp, for anybody debugging a stale file. */
  startedAt: string;
  /**
   * 128 bits of randomness, readable only by the user who owns the file.
   *
   * Being on the recorded port is not proof of anything: a stale marker plus
   * any local process that answers `{"app":"ccfind"}` was enough to get the
   * browser opened on somebody else's port, carrying the user's search terms.
   * Knowing this token is the proof — and it never leaves the file, because
   * `/api/status` only ever returns a hash of it and a caller-chosen nonce.
   */
  token: string;
}

/** Shape of a token: 32 lowercase hex characters. */
export const TOKEN_RE = /^[0-9a-f]{32}$/;

/** What a caller-supplied nonce may look like. */
export const NONCE_RE = /^[0-9a-zA-Z]{4,64}$/;

/** The proof a server returns for a nonce: it needs the token to compute this. */
export function proofFor(token: string, nonce: string): string {
  return crypto.createHash('sha256').update(`${token}${nonce}`).digest('hex');
}

/** A fresh secret for one server's lifetime. */
export function newToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * True when a process with this pid exists. `EPERM` means it exists and belongs
 * to somebody else; only `ESRCH` means gone.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A server that answered a probe. */
export interface RunningWeb {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  url: string;
  port: number;
}

/** How long a probe waits before deciding the recorded server is gone. */
export const PROBE_TIMEOUT_MS = 1000;

/** Most of an answer a probe will read. Anything larger is not our status page. */
export const PROBE_MAX_BYTES = 64 * 1024;

export interface InstanceFileOptions {
  /** Overrides `CCFIND_HOME`. */
  appHome?: string | undefined;
  /** The secret to write. Generated when absent. */
  token?: string | undefined;
}

export interface ClearInstanceOptions extends InstanceFileOptions {
  /** The port this server is listening on. Required: it is half of the identity. */
  port: number;
  /** The secret this server wrote. Required: it is the other half. */
  token: string;
}

/**
 * Records this process as the running server.
 *
 * Written to a temporary name and renamed, so a reader never sees half a file,
 * and created 0600: the port is a capability to read every transcript on this
 * machine.
 */
export function writeInstanceFile(port: number, options: InstanceFileOptions = {}): WebInstance {
  const target = resolveWebInstancePath(options.appHome);
  const instance: WebInstance = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    token: options.token ?? newToken(),
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(instance)}\n`, { mode: 0o600 });
  // A rename keeps the mode of the file that was written, not of the one it
  // replaces, so the secret is never briefly world-readable.
  fs.renameSync(temp, target);
  return instance;
}

/**
 * Reads the marker, or null when there is none, when it is nonsense, and when
 * it predates the token — a marker nobody can prove ownership of is no better
 * than no marker at all.
 */
export function readInstanceFile(options: InstanceFileOptions = {}): WebInstance | null {
  try {
    const raw = fs.readFileSync(resolveWebInstancePath(options.appHome), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WebInstance>;
    if (!Number.isInteger(parsed.port) || !Number.isInteger(parsed.pid)) return null;
    if ((parsed.port as number) < 1 || (parsed.port as number) > 65535) return null;
    if (typeof parsed.token !== 'string' || !TOKEN_RE.test(parsed.token)) return null;
    return {
      pid: parsed.pid as number,
      port: parsed.port as number,
      startedAt: String(parsed.startedAt ?? ''),
      token: parsed.token,
    };
  } catch {
    return null;
  }
}

/**
 * Removes the marker, but only when it is this exact server's.
 *
 * The pid alone is not enough. One process can run two servers — the picker
 * starts one for ^O while `--web` is already serving in the same process, and
 * the tests start several — and closing the first one would then delete the
 * marker belonging to the second, sending the next run to a port nobody is
 * listening on. Pid, port and token all have to match, which is the same
 * identity `/api/status` proves over the wire.
 */
export function clearInstanceFile(options: ClearInstanceOptions): void {
  const current = readInstanceFile(options);
  if (current === null) return;
  if (current.pid !== process.pid) return;
  if (current.port !== options.port) return;
  if (current.token !== options.token) return;
  try {
    fs.unlinkSync(resolveWebInstancePath(options.appHome));
  } catch {
    /* already gone */
  }
}

/**
 * The browser UI that is already running, or null.
 *
 * Being recorded is not enough — the pid may have been reused, the port may
 * now belong to something else entirely — so the answer only counts if
 * `/api/status` comes back saying it is one of ours.
 */
export async function findRunningWeb(options: InstanceFileOptions = {}): Promise<RunningWeb | null> {
  const instance = readInstanceFile(options);
  if (instance === null) return null;
  // A pid that is gone settles it without touching the network at all.
  if (!isProcessAlive(instance.pid)) return null;
  const alive = await probe(instance.port, { token: instance.token });
  return alive ? { url: `http://127.0.0.1:${instance.port}`, port: instance.port } : null;
}

export interface ProbeOptions {
  /** The marker's secret. Without it nothing can prove it is ours. */
  token?: string | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
}

/**
 * True when the server on that port can prove it wrote our `web.json`.
 *
 * It is asked for `sha256(token + nonce)` with a nonce chosen here, so the
 * token itself never crosses the wire and a recorded answer is useless next
 * time. The read is capped in both bytes and wall-clock time: `timeout` alone
 * is socket-idle, which a slow drip of bytes sails straight past.
 */
export function probe(port: number, options: ProbeOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? PROBE_MAX_BYTES;
  const token = options.token;
  const nonce = crypto.randomBytes(12).toString('hex');

  return new Promise((resolve) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    let req: http.ClientRequest | undefined;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      req?.destroy();
      resolve(value);
    };

    if (token === undefined || !TOKEN_RE.test(token)) {
      resolve(false);
      return;
    }

    deadline = setTimeout(() => done(false), timeoutMs);
    if (typeof deadline.unref === 'function') deadline.unref();

    req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/status?nonce=${nonce}`,
        method: 'GET',
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maxBytes) {
            // Whatever this is, it is not a status page.
            res.destroy();
            done(false);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              app?: unknown;
              auth?: unknown;
            };
            done(
              res.statusCode === 200 &&
                body.app === APP_NAME &&
                typeof body.auth === 'string' &&
                timingSafeEqualHex(body.auth, proofFor(token, nonce)),
            );
          } catch {
            done(false);
          }
        });
        res.on('error', () => done(false));
      },
    );
    req.on('timeout', () => done(false));
    req.on('error', () => done(false));
    req.end();
  });
}

/** Constant-time comparison of two hex digests of the same length. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/** Search page URL for a query, used when handing a query to a running server. */
export function searchUrl(base: string, query: string): string {
  return query.trim() === '' ? `${base}/` : `${base}/?q=${encodeURIComponent(query)}`;
}
