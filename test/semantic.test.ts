import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/core/db.js';
import { getMeta } from '../src/core/db.js';
import type { Embedder } from '../src/core/embedder.js';
import { UserError } from '../src/core/errors.js';
import { syncIndex } from '../src/core/indexer.js';
import { search } from '../src/core/search.js';
import {
  CHUNK_SIZE,
  chunkText,
  embedMissing,
  hasEmbeddings,
  MAX_CHUNKS_PER_MESSAGE,
  semanticSearch,
} from '../src/core/semantic.js';
import {
  assistantMessage,
  cleanupTempDirs,
  fakeEmbedder,
  makeFixture,
  openFixtureDb,
  userMessage,
  writeSession,
} from './helpers.js';

afterAll(cleanupTempDirs);

describe('chunking', () => {
  it('drops text under 20 characters', () => {
    expect(chunkText('too short')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
  });

  it('returns one chunk for a normal message', () => {
    const text = 'A reasonably sized message about recording screencasts.';
    expect(chunkText(text)).toEqual([text]);
  });

  it('splits long text on paragraph and sentence boundaries', () => {
    const paragraph = `${'Sentence about editing footage. '.repeat(40)}`.trim();
    const chunks = chunkText(paragraph);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_SIZE);
  });

  it('never exceeds six chunks per message', () => {
    const huge = `${'Some long sentence that keeps going and going for a while. '.repeat(400)}`;
    expect(chunkText(huge).length).toBeLessThanOrEqual(MAX_CHUNKS_PER_MESSAGE);
  });
});

async function buildIndexedFixture(): Promise<{ db: Db }> {
  const fixture = makeFixture();
  writeSession(fixture.projectsDir, '-tmp-video', 'video', [
    userMessage(
      'We spent the afternoon recording screencasts with OBS and editing the footage in Resolve before publishing.',
      { cwd: '/tmp/video' },
    ),
    assistantMessage('I suggested trimming the footage and exporting at a higher bitrate.', {
      cwd: '/tmp/video',
    }),
  ]);
  writeSession(fixture.projectsDir, '-tmp-cooking', 'cooking', [
    userMessage('The recipe needs tomatoes, garlic and olive oil simmered slowly for an hour.', {
      cwd: '/tmp/cooking',
    }),
  ]);
  writeSession(fixture.projectsDir, '-tmp-infra', 'infra', [
    userMessage('Kubernetes ingress kept returning a gateway timeout on the staging cluster.', {
      cwd: '/tmp/infra',
    }),
  ]);
  const db = openFixtureDb(fixture);
  await syncIndex(db, { projectsDir: fixture.projectsDir });
  return { db };
}

describe('semantic search with a deterministic fake embedder (criterion 10)', () => {
  it('creates a chunk per message at index time, unembedded', async () => {
    const { db } = await buildIndexedFixture();
    const counts = db
      .prepare('SELECT COUNT(*) AS total, COUNT(embedding) AS embedded FROM chunks')
      .get() as { total: number; embedded: number };
    expect(counts.total).toBe(4);
    expect(counts.embedded).toBe(0);
    expect(hasEmbeddings(db)).toBe(false);
    db.close();
  });

  it('embeds every chunk and then ranks by meaning', async () => {
    const { db } = await buildIndexedFixture();
    const embedder = fakeEmbedder();
    const result = await embedMissing(db, embedder, { batchSize: 2 });
    expect(result.embedded).toBe(4);
    expect(result.remaining).toBe(0);
    expect(getMeta(db, 'embedding_model')).toBe(embedder.id);
    expect(getMeta(db, 'embedding_dims')).toBe(String(embedder.dims));

    const hits = await semanticSearch(db, 'recording and editing footage', embedder, { limit: 5 });
    expect(hits[0]?.sessionId).toBe('video');
    expect(hits[0]?.snippet?.text).toContain('footage');
    expect(hits[0]?.snippet?.highlights).toEqual([]);
    // matchCount only counts messages above the similarity floor, so it never
    // degenerates into "every message in the session".
    expect(hits[0]?.matchCount).toBeLessThanOrEqual(2);
    const cooking = hits.find((h) => h.sessionId === 'cooking');
    expect(cooking?.matchCount).toBe(1);
    db.close();
  });

  it('works end to end through search() in semantic and hybrid mode', async () => {
    const { db } = await buildIndexedFixture();
    const embedder = fakeEmbedder();
    await embedMissing(db, embedder, { batchSize: 32 });

    const semantic = await search({ db, query: 'recording and editing footage', mode: 'semantic', embedder });
    expect(semantic[0]?.sessionId).toBe('video');
    expect(semantic[0]?.sources).toEqual(['semantic']);
    expect(semantic[0]?.resumeCommand).toBe("cd '/tmp/video' && claude --resume 'video'");

    const hybrid = await search({ db, query: 'recording and editing footage', mode: 'hybrid', embedder });
    expect(hybrid[0]?.sessionId).toBe('video');
    expect(hybrid[0]?.sources).toContain('semantic');
    expect(hybrid[0]?.sources).toContain('keyword');
    // The keyword snippet wins, so highlights survive into hybrid results.
    expect(hybrid[0]?.snippet.highlights.length).toBeGreaterThan(0);
    db.close();
  });

  it('applies filters in semantic mode too', async () => {
    const { db } = await buildIndexedFixture();
    const embedder = fakeEmbedder();
    await embedMissing(db, embedder);
    const hits = await semanticSearch(db, 'recording and editing footage', embedder, {
      limit: 5,
      filters: { cwdPrefix: '/tmp/cooking' },
    });
    expect(hits.every((h) => h.sessionId === 'cooking')).toBe(true);
    db.close();
  });

  it('is resumable: an aborted run keeps its progress', async () => {
    const { db } = await buildIndexedFixture();
    const controller = new AbortController();
    const base = fakeEmbedder();
    let calls = 0;
    const abortingEmbedder: Embedder = {
      id: base.id,
      dims: base.dims,
      async embed(texts) {
        calls += 1;
        const vectors = await base.embed(texts);
        if (calls === 1) controller.abort();
        return vectors;
      },
    };

    const first = await embedMissing(db, abortingEmbedder, { batchSize: 1, signal: controller.signal });
    expect(first.aborted).toBe(true);
    expect(first.embedded).toBe(1);
    expect(first.remaining).toBe(3);

    const second = await embedMissing(db, base, { batchSize: 1 });
    expect(second.embedded).toBe(3);
    expect(second.remaining).toBe(0);
    db.close();
  });

  it('reports progress as it goes', async () => {
    const { db } = await buildIndexedFixture();
    const seen: number[] = [];
    await embedMissing(db, fakeEmbedder(), { batchSize: 1, onProgress: (p) => seen.push(p.embedded) });
    expect(seen).toEqual([1, 2, 3, 4]);
    db.close();
  });

  it('clears every embedding when the model id changes', async () => {
    const { db } = await buildIndexedFixture();
    await embedMissing(db, fakeEmbedder('model-a'));
    const before = db.prepare('SELECT embedding FROM chunks ORDER BY id LIMIT 1').get() as {
      embedding: Buffer;
    };

    const result = await embedMissing(db, fakeEmbedder('model-b', 32));
    expect(result.total).toBe(4);
    expect(result.embedded).toBe(4);
    expect(getMeta(db, 'embedding_model')).toBe('model-b');
    expect(getMeta(db, 'embedding_dims')).toBe('32');

    const after = db.prepare('SELECT embedding FROM chunks ORDER BY id LIMIT 1').get() as {
      embedding: Buffer;
    };
    expect(after.embedding.byteLength).toBe(32 * 4);
    expect(before.embedding.byteLength).toBe(64 * 4);
    db.close();
  });

  it('a changed session keeps the embeddings of the text that did not change', async () => {
    const fixture = makeFixture();
    const file = writeSession(fixture.projectsDir, '-tmp-a', 's1', [
      userMessage('The original message about recording screencasts with OBS.', { cwd: '/tmp/a' }),
    ]);
    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });
    await embedMissing(db, fakeEmbedder());
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL').get() as { n: number }).n,
    ).toBe(0);

    const { appendSession } = await import('./helpers.js');
    appendSession(file, [
      assistantMessage('A new reply about editing the footage afterwards in Resolve.', { cwd: '/tmp/a' }),
    ]);
    const now = new Date(Date.now() + 2000);
    (await import('node:fs')).utimesSync(file, now, now);
    await syncIndex(db, { projectsDir: fixture.projectsDir });

    // Only the sentence that is actually new needs embedding; the one that was
    // already there carried its vector across the re-index.
    const rows = db
      .prepare('SELECT text, embedding IS NULL AS pending FROM chunks ORDER BY id')
      .all() as { text: string; pending: number }[];
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.pending === 1).map((row) => row.text)).toEqual([
      'A new reply about editing the footage afterwards in Resolve.',
    ]);
    db.close();
  });

  it('fails with an actionable error and exit code 2 when there are no embeddings', async () => {
    const { db } = await buildIndexedFixture();
    const embedder = fakeEmbedder();

    await expect(search({ db, query: 'recording footage', mode: 'semantic', embedder })).rejects.toThrow(
      /no embeddings yet/,
    );
    await expect(search({ db, query: 'recording footage', mode: 'hybrid', embedder })).rejects.toThrow(
      /no embeddings yet/,
    );
    await search({ db, query: 'recording footage', mode: 'semantic', embedder }).catch((err: unknown) => {
      expect(err).toBeInstanceOf(UserError);
      expect((err as UserError).exitCode).toBe(2);
    });

    // Keyword mode is untouched by any of this.
    const keyword = await search({ db, query: 'recording footage' });
    expect(keyword[0]?.sessionId).toBe('video');
    db.close();
  });
});
