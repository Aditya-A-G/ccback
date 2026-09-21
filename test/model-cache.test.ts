/**
 * A scripted run must never reach the network, and a half-downloaded model
 * must not break smart search for good.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { nonInteractiveMode } from '../src/cli.js';
import type { Db } from '../src/core/db.js';
import { UserError } from '../src/core/errors.js';
import { enableSemantic, semanticStatus } from '../src/core/smart.js';
import { sync } from '../src/core/api.js';
import {
  clearModelCache,
  DEFAULT_MODEL_ID,
  isModelReady,
  markModelReady,
  modelCacheDirFor,
  modelMarkerPath,
} from '../src/core/embedder.js';
import {
  cleanupTempDirs,
  fakeEmbedder,
  makeFixture,
  openFixtureDb,
  tempDir,
  userMessage,
  writeSession,
} from './helpers.js';

afterAll(cleanupTempDirs);

/** A cache that looks exactly like a finished download to `isModelReady`. */
function completeCache(): string {
  const cache = tempDir('sf-model-');
  const dir = modelCacheDirFor(cache, DEFAULT_MODEL_ID);
  fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  fs.writeFileSync(path.join(dir, 'onnx', 'model_quantized.onnx'), 'weights');
  markModelReady(cache, DEFAULT_MODEL_ID);
  return cache;
}

describe('the model cache', () => {
  it('is not ready when nothing was ever downloaded', () => {
    expect(isModelReady(tempDir('sf-model-'), DEFAULT_MODEL_ID)).toBe(false);
  });

  it('is not ready when the download stopped halfway', () => {
    // Files on disk, but no successful load ever happened.
    const cache = tempDir('sf-model-');
    const dir = modelCacheDirFor(cache, DEFAULT_MODEL_ID);
    fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    fs.writeFileSync(path.join(dir, 'onnx', 'model_quantized.onnx'), 'half');
    expect(isModelReady(cache, DEFAULT_MODEL_ID)).toBe(false);
  });

  it('is ready once a load has succeeded', () => {
    expect(isModelReady(completeCache(), DEFAULT_MODEL_ID)).toBe(true);
  });

  it('is not ready again when the weights are deleted under it', () => {
    const cache = completeCache();
    const dir = modelCacheDirFor(cache, DEFAULT_MODEL_ID);
    for (const name of fs.readdirSync(dir)) {
      if (name !== path.basename(modelMarkerPath(cache, DEFAULT_MODEL_ID))) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      }
    }
    expect(isModelReady(cache, DEFAULT_MODEL_ID)).toBe(false);
  });

  it('clears only the one model, inside the cache', () => {
    const cache = completeCache();
    fs.writeFileSync(path.join(cache, 'unrelated.txt'), 'keep me');
    clearModelCache(cache, DEFAULT_MODEL_ID);
    expect(isModelReady(cache, DEFAULT_MODEL_ID)).toBe(false);
    expect(fs.existsSync(path.join(cache, 'unrelated.txt'))).toBe(true);
  });

  it('refuses a model id that would climb out of the cache', () => {
    expect(() => modelCacheDirFor(tempDir('sf-model-'), '../../etc')).toThrow(/Refusing/);
  });

  it('never deletes through a symlink inside the cache', () => {
    const cache = completeCache();
    const outside = tempDir('sf-model-outside-');
    const keep = path.join(outside, 'precious.bin');
    fs.writeFileSync(keep, 'somebody else\'s file');
    const dir = modelCacheDirFor(cache, DEFAULT_MODEL_ID);
    // Both shapes: a link to a file, and a link to a whole directory.
    fs.symlinkSync(keep, path.join(dir, 'weights.onnx'));
    fs.symlinkSync(outside, path.join(dir, 'onnx-elsewhere'));

    clearModelCache(cache, DEFAULT_MODEL_ID);

    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.readFileSync(keep, 'utf8')).toBe('somebody else\'s file');
    expect(fs.existsSync(outside)).toBe(true);
    // The links themselves are gone with the rest of the model directory.
    expect(fs.existsSync(dir)).toBe(false);
    expect(isModelReady(cache, DEFAULT_MODEL_ID)).toBe(false);
  });

  it('never deletes through a symlinked model directory', () => {
    const cache = tempDir('sf-model-');
    const outside = tempDir('sf-model-outside2-');
    fs.writeFileSync(path.join(outside, 'precious.bin'), 'keep me');
    const dir = modelCacheDirFor(cache, DEFAULT_MODEL_ID);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.symlinkSync(outside, dir);

    clearModelCache(cache, DEFAULT_MODEL_ID);

    expect(fs.existsSync(path.join(outside, 'precious.bin'))).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses to walk a model directory that leads out of the cache', () => {
    const cache = tempDir('sf-model-');
    const outside = tempDir('sf-model-outside3-');
    // <cache>/Xenova is the link this time: the leaf itself is a real directory.
    const owner = path.join(outside, 'all-MiniLM-L6-v2');
    fs.mkdirSync(owner, { recursive: true });
    fs.writeFileSync(path.join(owner, 'precious.bin'), 'keep me');
    fs.mkdirSync(cache, { recursive: true });
    fs.symlinkSync(outside, path.join(cache, 'Xenova'));

    clearModelCache(cache, DEFAULT_MODEL_ID);

    expect(fs.readFileSync(path.join(owner, 'precious.bin'), 'utf8')).toBe('keep me');
  });

  it('is quiet about a cache that was never there', () => {
    expect(() => clearModelCache(path.join(tempDir('sf-model-'), 'never'), DEFAULT_MODEL_ID)).not.toThrow();
  });
});

describe('what a scripted run may do about smart search', () => {
  const cached = completeCache();
  const empty = tempDir('sf-model-');

  it('leaves keyword alone', () => {
    expect(nonInteractiveMode('keyword', empty)).toBe('keyword');
  });

  it('falls back to keyword when the model is not on disk', () => {
    expect(nonInteractiveMode('auto', empty)).toBe('keyword');
  });

  it('keeps auto when the model is already here', () => {
    expect(nonInteractiveMode('auto', cached)).toBe('auto');
  });

  it('refuses an explicit semantic or hybrid in one line, pointing at --reindex', () => {
    for (const mode of ['semantic', 'hybrid'] as const) {
      expect(() => nonInteractiveMode(mode, empty)).toThrow(/--reindex/);
      let message = '';
      try {
        nonInteractiveMode(mode, empty);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message.split('\n')).toHaveLength(1);
    }
  });

  it('allows an explicit semantic or hybrid once the model is here', () => {
    expect(nonInteractiveMode('semantic', cached)).toBe('semantic');
    expect(nonInteractiveMode('hybrid', cached)).toBe('hybrid');
  });
});

describe('a corrupt model cache', () => {
  /** An index with one chunk waiting for a vector. */
  async function pendingFixture(): Promise<{ appHome: string; db: Db }> {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-alpha', 'alpha', [
      userMessage('a message long enough to become a chunk of text worth embedding here', {
        cwd: '/tmp/alpha',
      }),
    ]);
    const db = openFixtureDb(fixture);
    await sync({ db, projectsDir: fixture.projectsDir });
    return { appHome: fixture.home, db };
  }

  it('is thrown away and retried once, so smart search repairs itself', async () => {
    const { appHome, db } = await pendingFixture();
    const cacheDir = path.join(appHome, 'models');
    const dir = modelCacheDirFor(cacheDir, DEFAULT_MODEL_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'model.onnx'), 'truncated download');

    const seen: boolean[] = [];
    let attempts = 0;
    await enableSemantic({
      db,
      appHome,
      createEmbedder: async () => {
        attempts += 1;
        // What the second attempt sees: the broken file, or a clean slate.
        seen.push(fs.existsSync(path.join(dir, 'model.onnx')));
        if (attempts === 1) throw new Error('onnxruntime: failed to load model');
        return fakeEmbedder();
      },
    });

    expect(attempts).toBe(2);
    expect(seen).toEqual([true, false]);
    expect(semanticStatus({ db, embedder: fakeEmbedder() }).pendingChunks).toBe(0);
    db.close();
  });

  it('gives up after one retry rather than looping', async () => {
    const { appHome, db } = await pendingFixture();
    let attempts = 0;
    await enableSemantic({
      db,
      appHome,
      createEmbedder: async () => {
        attempts += 1;
        throw new Error('still broken');
      },
    });
    expect(attempts).toBe(2);
    // Keyword search is untouched and nothing was marked as set up.
    expect(semanticStatus({ db, embedder: fakeEmbedder() }).pendingChunks).toBeGreaterThan(0);
    db.close();
  });

  it('deletes nothing when the refusal was a decision, not a broken file', async () => {
    const { appHome, db } = await pendingFixture();
    const cacheDir = path.join(appHome, 'models');
    const dir = modelCacheDirFor(cacheDir, DEFAULT_MODEL_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'model.onnx'), 'perfectly good weights');

    let attempts = 0;
    await enableSemantic({
      db,
      appHome,
      createEmbedder: async () => {
        attempts += 1;
        // This is what CCFIND_NO_MODEL and a missing optional package throw.
        throw new UserError('CCFIND_NO_MODEL=1 is set, so the embedding model was not loaded.');
      },
    });

    expect(attempts).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'model.onnx'), 'utf8')).toBe('perfectly good weights');
    db.close();
  });
});
