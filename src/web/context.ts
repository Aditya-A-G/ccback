import type { Db, Embedder } from '../core/index.js';
import type { EmbedJob } from './embed-job.js';

/** Everything a request handler needs. One per running server. */
export interface ServerContext {
  /** Open index handle, shared for the life of the server. */
  db: Db;
  /** Port the server actually bound to, used for the Host/Origin checks. */
  port: number;
  /** Where transcripts are read from, reported by `/api/status`. */
  projectsDir: string | undefined;
  appHome: string | undefined;
  dbPath: string | undefined;
  /** Injected by tests so embedding never downloads a model. */
  embedder: Embedder | undefined;
  /** State of the background semantic-indexing job, per server. */
  job: EmbedJob;
  /**
   * The secret from `web.json`. `/api/status` proves knowledge of it, hashed
   * with a caller's nonce, so another local process cannot pass itself off as
   * this one. Undefined for a server that did not announce itself.
   */
  token?: string | undefined;
}
