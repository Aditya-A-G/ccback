/**
 * Smart search: the embedding side of the index, as the front ends see it.
 *
 * Nothing here ever installs anything. `@huggingface/transformers` is an
 * optional dependency, so a normal install has it and `npm i -g ccback
 * --omit=optional` does not; when it is missing, every function here is a
 * quiet no-op and `auto` search stays keyword-only. The only thing that can
 * happen on first use is the model download (about 23 MB), and that happens
 * inside the embedder, in the background, where somebody is looking at a UI.
 */
import type { Db } from './db.js';
import { getMeta, setMeta } from './db.js';
import { clearModelCache, createDefaultEmbedder, type Embedder, isTransformersAvailable } from './embedder.js';
import { UserError } from './errors.js';
import { resolveModelCacheDir } from './paths.js';
import { embedMissing as embedChunks } from './semantic.js';
import { type IndexAccessOptions, resolveDb } from './search.js';

/**
 * Download the user is told about when smart search is mentioned: the optional
 * libraries plus the model. With the default install the libraries are already
 * on disk and only the model (about 23 MB) is fetched on first use.
 */
export const SEMANTIC_DOWNLOAD_MB = 165;

/** The part of {@link SEMANTIC_DOWNLOAD_MB} that is fetched on first use. */
export const MODEL_DOWNLOAD_MB = 23;

/** Meta key remembering that embeddings were asked for, before any exist. */
const ENABLED_KEY = 'semantic_enabled';

export interface SemanticStatus {
  /** Embeddings exist, or are being built right now. */
  enabled: boolean;
  /** The embedding library can be resolved in this installation. */
  runtimeInstalled: boolean;
  /** Chunks still waiting for a vector. */
  pendingChunks: number;
  /** Chunks in the index, embedded or not. */
  totalChunks: number;
  /** Megabytes the one-time setup costs, for anything that has to say a number. */
  downloadMb: number;
}

export interface SemanticStatusOptions extends IndexAccessOptions {
  /** Present when a front end injected an embedder, which counts as installed. */
  embedder?: Embedder | undefined;
}

/** Where smart search stands: used by the picker, the web UI and `--stats`. */
export function semanticStatus(options: SemanticStatusOptions = {}): SemanticStatus {
  const db = resolveDb(options);
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN embedding IS NULL THEN 1 ELSE 0 END) AS pending FROM chunks`,
    )
    .get() as { total: number; pending: number | null };
  const runtimeInstalled = options.embedder !== undefined || isTransformersAvailable();
  const embedded = counts.total - (counts.pending ?? 0);
  return {
    enabled: runtimeInstalled && (embedded > 0 || getMeta(db, ENABLED_KEY) === '1'),
    runtimeInstalled,
    pendingChunks: counts.pending ?? 0,
    totalChunks: counts.total,
    downloadMb: SEMANTIC_DOWNLOAD_MB,
  };
}

/** Which stage of the setup progress is describing. */
export type SemanticPhase = 'install' | 'model' | 'embed';

export interface SemanticProgress {
  phase: SemanticPhase;
  /** Units finished, when the phase can count. */
  done?: number;
  /** Units in total, when the phase knows. */
  total?: number;
}

export interface EnableSemanticOptions extends IndexAccessOptions {
  onProgress?: ((progress: SemanticProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
  /** Injected in tests so no model is ever loaded. */
  embedder?: Embedder | undefined;
  /** Batch size passed through to the embedder. */
  batchSize?: number | undefined;
  /**
   * How the real embedder is built. Only ever replaced by tests, which need to
   * make a load fail without putting a broken model on somebody's disk.
   */
  createEmbedder?: ((options: { cacheDir: string }) => Promise<Embedder>) | undefined;
}

/**
 * Turns smart search on: load the model (downloading it on first use), then
 * embed every chunk that has no vector. Resumable — interrupting keeps what
 * was finished — and a no-op when the optional library is not installed.
 */
export async function enableSemantic(options: EnableSemanticOptions = {}): Promise<void> {
  await runEmbedding(options, true);
}

export interface TopUpResult {
  /** Chunks embedded by this call. */
  embedded: number;
}

/**
 * Embeds the chunks that appeared since the last run — normally the handful of
 * new messages a day of work adds. Does nothing at all unless smart search is
 * already enabled, so it can be called on any code path without surprising
 * anybody with a download.
 */
export async function topUpEmbeddings(options: EnableSemanticOptions = {}): Promise<TopUpResult> {
  const db = resolveDb(options);
  const state = semanticStatus({ ...options, db });
  if (!state.enabled || state.pendingChunks === 0) return { embedded: 0 };
  return { embedded: await runEmbedding({ ...options, db }, false) };
}

async function runEmbedding(options: EnableSemanticOptions, markEnabled: boolean): Promise<number> {
  const db: Db = resolveDb(options);
  const embedder = options.embedder ?? (await loadEmbedder(options));
  // A keyword-only installation, or a model that will not load, has nothing to
  // do here and must not complain — and must not leave the flag set either,
  // or every UI would show a setup that is never going to finish.
  if (embedder === null) return 0;
  if (options.signal?.aborted) return 0;
  // Set once the model is really in hand, and before the first batch, so a UI
  // asking "is this being built?" during a long first run gets yes.
  if (markEnabled) setMeta(db, ENABLED_KEY, '1');

  options.onProgress?.({ phase: 'embed', done: 0 });
  const result = await embedChunks(db, embedder, {
    batchSize: options.batchSize,
    signal: options.signal,
    onProgress: ({ embedded, total }) => options.onProgress?.({ phase: 'embed', done: embedded, total }),
  });
  return result.embedded;
}

/**
 * Loads the real embedder, or null when this installation has no runtime.
 *
 * A download interrupted halfway leaves files that parse as a model and then
 * fail to load, and nothing ever cleans them up — so smart search would stay
 * broken until the user found `~/.ccback/models` themselves. One failure is
 * therefore treated as a corrupt cache: those files go, and the load is tried
 * once more from scratch.
 */
async function loadEmbedder(options: EnableSemanticOptions): Promise<Embedder | null> {
  if (!isTransformersAvailable()) return null;
  options.onProgress?.({ phase: 'model' });
  const cacheDir = resolveModelCacheDir(options.appHome);
  const create = options.createEmbedder ?? ((opts: { cacheDir: string }) => createDefaultEmbedder(opts));
  try {
    return await create({ cacheDir });
  } catch (err) {
    // A UserError here is a decision, not a broken file: the optional package
    // is missing, or CCBACK_NO_MODEL says not to. Deleting anything would be
    // wrong, and retrying would only fail the same way.
    if (err instanceof UserError || options.signal?.aborted === true) return null;
    try {
      clearModelCache(cacheDir);
    } catch {
      /* nothing to clean up, or not ours to clean */
    }
    try {
      return await create({ cacheDir });
    } catch {
      // An unloadable or undownloadable model leaves keyword search intact, so
      // it is reported by `semanticStatus` staying off, not by an exception.
      return null;
    }
  }
}
