import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { UserError } from './errors.js';
import { APP_NAME, resolveModelCacheDir } from './paths.js';

/**
 * Anything that turns text into vectors. Tests inject a deterministic fake, so
 * no test ever downloads a model or touches the network.
 */
export interface Embedder {
  /** Stable identifier stored in `meta`; changing it invalidates all embeddings. */
  id: string;
  /** Vector length. */
  dims: number;
  /** Returns one L2-normalised vector per input text, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** The model the real embedder uses: quantized MiniLM, 384 dims, ~25 MB. */
export const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_MODEL_DIMS = 384;

/** Package name of the optional dependency. Only ever loaded dynamically. */
export const TRANSFORMERS_PACKAGE = '@huggingface/transformers';

export const INSTALL_HINT =
  `Smart search needs the optional package ${TRANSFORMERS_PACKAGE}, which this install skipped.\n` +
  `Run: npm install -g ${APP_NAME}`;

/**
 * True when `@huggingface/transformers` is installed. Resolves the module
 * without loading it, so checking is cheap and cannot start onnxruntime.
 */
export function isTransformersAvailable(): boolean {
  try {
    const require = createRequire(import.meta.url);
    require.resolve(TRANSFORMERS_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

export interface CreateEmbedderOptions {
  modelId?: string | undefined;
  /** Where the model is cached. Defaults to `<app home>/models`. */
  cacheDir?: string | undefined;
  /** onnx weight precision; `q8` keeps the download around 25 MB. */
  dtype?: string | undefined;
  /**
   * Never reach the network: load what is already cached, or fail. Scripted
   * runs (`-p`, `--json`) set this, so a pipeline can never stall on a
   * download nobody asked for.
   */
  localOnly?: boolean | undefined;
}

/**
 * Where a finished download is recorded.
 *
 * transformers.js lays its cache out in its own way, and that layout is not a
 * contract — so "is the model here?" is answered by a marker this tool writes
 * itself, once a pipeline has actually been built from those files. A
 * half-finished download leaves no marker, which is exactly the answer a
 * scripted run needs.
 */
export function modelMarkerPath(cacheDir: string, modelId: string = DEFAULT_MODEL_ID): string {
  return path.join(modelCacheDirFor(cacheDir, modelId), '.ccfind-model-ready');
}

/** Directory transformers.js caches one model in. */
export function modelCacheDirFor(cacheDir: string, modelId: string = DEFAULT_MODEL_ID): string {
  // Model ids are `owner/name`; nothing else is ever passed, and anything that
  // tried to climb out of the cache directory is refused below.
  const target = path.resolve(cacheDir, ...modelId.split('/'));
  const inside = path.relative(path.resolve(cacheDir), target);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new UserError(`Refusing to use ${modelId} as a model cache path.`);
  }
  return target;
}

/** True when this model has been loaded successfully from this cache before. */
export function isModelReady(cacheDir: string, modelId: string = DEFAULT_MODEL_ID): boolean {
  try {
    if (!fs.statSync(modelMarkerPath(cacheDir, modelId)).isFile()) return false;
    // The marker alone is not enough: somebody may have deleted the weights.
    return fs.readdirSync(modelCacheDirFor(cacheDir, modelId)).some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

/** Records that this model loaded. Best effort: a read-only cache is not an error. */
export function markModelReady(cacheDir: string, modelId: string = DEFAULT_MODEL_ID): void {
  try {
    const dir = modelCacheDirFor(cacheDir, modelId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(modelMarkerPath(cacheDir, modelId), `${new Date().toISOString()}\n`);
  } catch {
    /* the cache is not writable; the next run simply checks again */
  }
}

/**
 * Throws away one model's cached files so the next load starts clean.
 *
 * Deletion follows nothing. `fs.rmSync(..., { recursive: true })` walks into
 * whatever a directory entry points at, so a symbolic link inside the cache —
 * or a symlinked `Xenova/` above it — would have let a download turn into a
 * delete somewhere else entirely. Here every entry is `lstat`ed, links are
 * unlinked rather than followed, only real files and real directories inside
 * the canonical cache directory are removed, and anything that refuses to go
 * is left alone rather than chased.
 */
export function clearModelCache(cacheDir: string, modelId: string = DEFAULT_MODEL_ID): void {
  const modelDir = modelCacheDirFor(cacheDir, modelId);

  // A model directory that is itself a link: the link is in the cache, so it
  // goes, but nothing on the other side of it is touched.
  try {
    if (fs.lstatSync(modelDir).isSymbolicLink()) {
      fs.unlinkSync(modelDir);
      return;
    }
  } catch {
    // Nothing there: nothing to clear.
    return;
  }

  // And the path must still be inside the cache once every link above it is
  // resolved, or this is somebody else's directory wearing our name.
  let root: string;
  let cacheRoot: string;
  try {
    cacheRoot = fs.realpathSync(path.resolve(cacheDir));
    root = fs.realpathSync(modelDir);
  } catch {
    return;
  }
  const inside = path.relative(cacheRoot, root);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return;

  removeInside(root);
  try {
    fs.rmdirSync(root);
  } catch {
    /* something in it would not go; the next load simply re-downloads */
  }
}

/** Deletes the contents of one real directory, never following a link out of it. */
function removeInside(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    try {
      if (stat.isSymbolicLink()) {
        // The link itself goes; whatever it points at is none of our business.
        fs.unlinkSync(full);
      } else if (stat.isDirectory()) {
        removeInside(full);
        fs.rmdirSync(full);
      } else if (stat.isFile()) {
        fs.unlinkSync(full);
      }
      // Anything else (a socket, a device) is left exactly where it is.
    } catch {
      /* leave it; a cache that will not clear is not worth an error */
    }
  }
}

// Typed as `string` on purpose: a literal type would make tsc resolve the
// optional dependency at build time, which would break builds without it.
const TRANSFORMERS_SPECIFIER: string = TRANSFORMERS_PACKAGE;

interface TransformersLike {
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<FeatureExtractor>;
  env: Record<string, unknown>;
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: ArrayLike<number>; dims: number[] }>;

/**
 * Builds the transformers.js embedder. The optional dependency is imported here
 * and nowhere else, so keyword search never depends on it.
 *
 * Throws {@link UserError} (exit code 2) when the dependency is missing or
 * cannot be loaded on this platform.
 */
export async function createDefaultEmbedder(options: CreateEmbedderOptions = {}): Promise<Embedder> {
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const cacheDir = options.cacheDir ?? resolveModelCacheDir();

  // The test suite sets this: a code path that reaches the real model must
  // fail loudly instead of quietly downloading 23 MB during `npm test`.
  if (process.env['CCFIND_NO_MODEL'] === '1') {
    throw new UserError('CCFIND_NO_MODEL=1 is set, so the embedding model was not loaded.');
  }

  if (!isTransformersAvailable()) throw new UserError(INSTALL_HINT);

  let transformers: TransformersLike;
  try {
    transformers = (await import(TRANSFORMERS_SPECIFIER)) as unknown as TransformersLike;
  } catch (err) {
    throw new UserError(
      `${TRANSFORMERS_PACKAGE} is installed but failed to load: ${(err as Error).message}\n${INSTALL_HINT}`,
    );
  }

  transformers.env['cacheDir'] = cacheDir;

  // `env` belongs to the module, not to this call, so a local-only load used to
  // leave remote loading switched off for every later load in the same process:
  // the picker's `-p` pass would quietly disable the download the background
  // job was about to do. Whatever was there is put back before returning, on
  // the failure path too.
  const previous = {
    allowRemoteModels: transformers.env['allowRemoteModels'],
    allowLocalModels: transformers.env['allowLocalModels'],
    localModelPath: transformers.env['localModelPath'],
  };

  let extractor: FeatureExtractor;
  try {
    // Inside the `try`, so no exit path — not even a setter that throws — can
    // leave the module's flags pointing at this one call's preferences.
    transformers.env['allowLocalModels'] = false;
    if (options.localOnly === true) {
      // Local-files-only. transformers.js refuses to load anything when both local
      // and remote are off, so serve the download cache as a local model folder:
      // its layout (<cacheDir>/<org>/<model>/…) is exactly what that expects.
      transformers.env['allowRemoteModels'] = false;
      transformers.env['allowLocalModels'] = true;
      transformers.env['localModelPath'] = cacheDir;
    }

    try {
      extractor = await transformers.pipeline('feature-extraction', modelId, {
        dtype: options.dtype ?? 'q8',
      });
    } catch {
      // Older/newer builds may not accept `dtype`; fall back to defaults.
      extractor = await transformers.pipeline('feature-extraction', modelId);
    }
  } finally {
    transformers.env['allowRemoteModels'] = previous.allowRemoteModels ?? true;
    transformers.env['allowLocalModels'] = previous.allowLocalModels ?? false;
    transformers.env['localModelPath'] = previous.localModelPath;
  }

  // Everything this model needs is on disk now, and demonstrably usable.
  markModelReady(cacheDir, modelId);

  let dims = DEFAULT_MODEL_DIMS;

  return {
    id: modelId,
    get dims() {
      return dims;
    },
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      const width = output.dims[output.dims.length - 1] ?? DEFAULT_MODEL_DIMS;
      dims = width;
      const flat = output.data;
      const result: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 1) {
        const vec = new Float32Array(width);
        for (let j = 0; j < width; j += 1) vec[j] = Number(flat[i * width + j]);
        result.push(normalize(vec));
      }
      return result;
    },
  };
}

/** L2-normalises in place and returns the same array. */
export function normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i += 1) vec[i] = vec[i]! / norm;
  }
  return vec;
}
