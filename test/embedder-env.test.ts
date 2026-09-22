/**
 * `transformers.env` is module-global, so one load's settings outlive it.
 *
 * A scripted run (`-p`, `--json`) loads local-files-only and switches remote
 * loading off, so it has to switch it back: left off, it would stay off for the
 * rest of the process, and a later load in the same process could not download
 * the model it needs. Nothing here reaches the network: the
 * transformers package is replaced with a fake that records what it was handed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDirs, tempDir } from './helpers.js';

/** What the fake module's `env` starts as, the way the real one arrives. */
const INITIAL_ENV = { allowRemoteModels: true, allowLocalModels: true, localModelPath: '/somewhere/models' };

vi.mock('@huggingface/transformers', () => {
  const env: Record<string, unknown> = { ...INITIAL_ENV };
  const calls: Record<string, unknown>[] = [];
  let failures = 0;
  const pipeline = async (_task: string, _model: string): Promise<unknown> => {
    calls.push({ ...env });
    if (failures > 0) {
      failures -= 1;
      throw new Error('this build cannot load that model');
    }
    return async () => ({ data: [1, 0, 0, 0], dims: [1, 4] });
  };
  return {
    env,
    pipeline,
    // Test-only handles on the fake.
    __calls: calls,
    __reset: (alwaysFail = 0): void => {
      Object.assign(env, INITIAL_ENV);
      calls.length = 0;
      failures = alwaysFail;
    },
  };
});

interface FakeTransformers {
  env: Record<string, unknown>;
  __calls: Record<string, unknown>[];
  __reset: (alwaysFail?: number) => void;
}

const fake = (await import('@huggingface/transformers')) as unknown as FakeTransformers;
const { createDefaultEmbedder } = await import('../src/core/embedder.js');

afterAll(cleanupTempDirs);

/** The suite sets CCBACK_NO_MODEL; these tests are the one place that may load. */
async function withModelAllowed<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env['CCBACK_NO_MODEL'];
  delete process.env['CCBACK_NO_MODEL'];
  try {
    return await run();
  } finally {
    if (previous !== undefined) process.env['CCBACK_NO_MODEL'] = previous;
  }
}

beforeEach(() => fake.__reset());

describe('a localOnly load', () => {
  it('loads from the cache without reaching the network', async () => {
    const cacheDir = tempDir('ccback-env-cache-');
    await withModelAllowed(() => createDefaultEmbedder({ cacheDir, localOnly: true }));

    expect(fake.__calls).toHaveLength(1);
    expect(fake.__calls[0]).toMatchObject({
      allowRemoteModels: false,
      allowLocalModels: true,
      localModelPath: cacheDir,
    });
  });

  it('leaves remote loading enabled for the next load in the same process', async () => {
    const cacheDir = tempDir('ccback-env-cache-');
    await withModelAllowed(() => createDefaultEmbedder({ cacheDir, localOnly: true }));

    // What a normal load sees afterwards: this is the regression.
    expect(fake.env['allowRemoteModels']).toBe(true);
    expect(fake.env['allowLocalModels']).toBe(INITIAL_ENV.allowLocalModels);
    expect(fake.env['localModelPath']).toBe(INITIAL_ENV.localModelPath);

    await withModelAllowed(() => createDefaultEmbedder({ cacheDir }));
    expect(fake.__calls).toHaveLength(2);
    expect(fake.__calls[1]).toMatchObject({ allowRemoteModels: true, allowLocalModels: false });
  });

  it('puts the flags back even when the model could not be loaded at all', async () => {
    const cacheDir = tempDir('ccback-env-cache-');
    fake.__reset(2);
    await expect(withModelAllowed(() => createDefaultEmbedder({ cacheDir, localOnly: true }))).rejects.toThrow(
      /cannot load/,
    );
    expect(fake.env['allowRemoteModels']).toBe(true);
    expect(fake.env['localModelPath']).toBe(INITIAL_ENV.localModelPath);
  });

  it('records the model as ready only once a pipeline really came back', async () => {
    const cacheDir = tempDir('ccback-env-cache-');
    fake.__reset(2);
    await expect(withModelAllowed(() => createDefaultEmbedder({ cacheDir, localOnly: true }))).rejects.toThrow();
    expect(fs.existsSync(path.join(cacheDir, 'Xenova'))).toBe(false);

    fake.__reset();
    await withModelAllowed(() => createDefaultEmbedder({ cacheDir }));
    expect(fs.existsSync(path.join(cacheDir, 'Xenova', 'all-MiniLM-L6-v2', '.ccback-model-ready'))).toBe(true);
  });

  /**
   * The flags were set *before* the `try` whose `finally` puts them back, so
   * anything that threw while they were being set left the module globally
   * local-only: every later load in the process would then refuse to download.
   * A `localModelPath` setter that throws once is the smallest way to stand in
   * for that.
   */
  it('puts the flags back even when setting them is what fails', async () => {
    const cacheDir = tempDir('ccback-env-cache-');
    const previous = fake.env['localModelPath'];
    let thrown = false;
    Object.defineProperty(fake.env, 'localModelPath', {
      configurable: true,
      get: () => previous,
      set: () => {
        if (thrown) return;
        thrown = true;
        throw new Error('localModelPath is not writable in this build');
      },
    });

    try {
      await expect(withModelAllowed(() => createDefaultEmbedder({ cacheDir, localOnly: true }))).rejects.toThrow(
        /not writable/,
      );
    } finally {
      delete (fake.env as Record<string, unknown>)['localModelPath'];
      fake.env['localModelPath'] = previous;
    }

    // The next load in this process can still reach the network.
    expect(thrown).toBe(true);
    expect(fake.env['allowRemoteModels']).toBe(true);
    expect(fake.env['allowLocalModels']).toBe(INITIAL_ENV.allowLocalModels);
    expect(fake.__calls).toHaveLength(0);
  });

  it('still refuses to load anything when CCBACK_NO_MODEL is set', async () => {
    await expect(createDefaultEmbedder({ cacheDir: tempDir('ccback-env-cache-') })).rejects.toThrow(/CCBACK_NO_MODEL/);
    expect(fake.__calls).toHaveLength(0);
  });
});
