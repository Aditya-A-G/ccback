/**
 * Re-indexing must not throw embeddings away.
 *
 * Before this, appending one message to a session deleted every chunk it had,
 * so a normal day of work left thousands of chunks unembedded and smart search
 * quietly got worse. Chunks now carry a digest of their text and a re-index
 * carries the vectors across, so only genuinely new sentences cost anything.
 */
import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { chunkHash } from '../src/core/hash.js';
import { enableSemantic, search, semanticStatus, syncIndex } from '../src/core/index.js';
import {
  aiTitle,
  appendSession,
  assistantMessage,
  cleanupTempDirs,
  fakeEmbedder,
  makeFixture,
  openFixtureDb,
  userMessage,
  writeSession,
} from './helpers.js';

afterAll(cleanupTempDirs);

const MESSAGES = 200;

/** A 200-message session, indexed and fully embedded. */
async function buildEmbeddedSession(): Promise<{
  fixture: ReturnType<typeof makeFixture>;
  db: ReturnType<typeof openFixtureDb>;
  file: string;
}> {
  const fixture = makeFixture();
  const records: unknown[] = [aiTitle('A long working session')];
  for (let i = 0; i < MESSAGES; i += 1) {
    const stamp = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
    records.push(
      (i % 2 === 0 ? userMessage : assistantMessage)(
        `Message number ${i} about recording screencasts, editing the footage and publishing it.`,
        { cwd: '/tmp/long', timestamp: stamp },
      ),
    );
  }
  const file = writeSession(fixture.projectsDir, '-tmp-long', 'longsess', records);
  const db = openFixtureDb(fixture);
  await syncIndex(db, { projectsDir: fixture.projectsDir });
  await enableSemantic({ db, embedder: fakeEmbedder() });
  return { fixture, db, file };
}

/** Appending changes (mtime, size), which is what makes the next sync re-read it. */
function touch(file: string): void {
  const now = new Date(Date.now() + 2000);
  fs.utimesSync(file, now, now);
}

describe('re-indexing a session that grew', () => {
  it('leaves exactly the new chunks unembedded', async () => {
    const { fixture, db, file } = await buildEmbeddedSession();
    const before = semanticStatus({ db, embedder: fakeEmbedder() });
    expect(before.pendingChunks).toBe(0);
    expect(before.totalChunks).toBe(MESSAGES);

    const newText = 'One more message, written today, about colour grading and captions.';
    appendSession(file, [assistantMessage(newText, { cwd: '/tmp/long', timestamp: '2026-02-01T00:00:00.000Z' })]);
    touch(file);
    const result = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(result.indexedFiles).toBe(1);

    const pending = db.prepare('SELECT text FROM chunks WHERE embedding IS NULL').all() as { text: string }[];
    expect(pending.map((row) => row.text)).toEqual([newText]);
    expect(semanticStatus({ db, embedder: fakeEmbedder() })).toMatchObject({
      totalChunks: MESSAGES + 1,
      pendingChunks: 1,
      enabled: true,
    });
    db.close();
  });

  it('stores a digest for every chunk and reuses it by text, not by row id', async () => {
    const { fixture, db, file } = await buildEmbeddedSession();
    const sample = db.prepare('SELECT text, text_hash FROM chunks ORDER BY id LIMIT 1').get() as {
      text: string;
      text_hash: string;
    };
    expect(sample.text_hash).toBe(chunkHash(sample.text));

    // Rewrite the file with a new message in *front* of the old ones, so every
    // old chunk lands on a different row id than it had. Matching by id would
    // lose all 200 vectors; matching by digest keeps them.
    const idBefore = (
      db.prepare('SELECT id FROM chunks WHERE text = ?').get(sample.text) as { id: number }
    ).id;
    const records: unknown[] = [
      aiTitle('A long working session'),
      userMessage('A completely different new topic: invoicing and taxes for the studio.', {
        cwd: '/tmp/long',
        timestamp: '2025-12-31T00:00:00.000Z',
      }),
    ];
    for (let i = 0; i < MESSAGES; i += 1) {
      const stamp = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
      records.push(
        (i % 2 === 0 ? userMessage : assistantMessage)(
          `Message number ${i} about recording screencasts, editing the footage and publishing it.`,
          { cwd: '/tmp/long', timestamp: stamp },
        ),
      );
    }
    writeSession(fixture.projectsDir, '-tmp-long', 'longsess', records);
    touch(file);
    await syncIndex(db, { projectsDir: fixture.projectsDir });

    const moved = db.prepare('SELECT id, embedding IS NULL AS pending FROM chunks WHERE text = ?').get(
      sample.text,
    ) as { id: number; pending: number };
    expect(moved.id).not.toBe(idBefore);
    expect(moved.pending).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get() as { n: number }).n,
    ).toBe(MESSAGES);
    db.close();
  });

  it('embedding the top-up is quick and finishes the job', async () => {
    const { fixture, db, file } = await buildEmbeddedSession();
    appendSession(file, [
      assistantMessage('Another new paragraph about the thumbnail and the title.', {
        cwd: '/tmp/long',
        timestamp: '2026-02-03T00:00:00.000Z',
      }),
    ]);
    touch(file);
    await syncIndex(db, { projectsDir: fixture.projectsDir });

    await enableSemantic({ db, embedder: fakeEmbedder() });
    expect(semanticStatus({ db, embedder: fakeEmbedder() }).pendingChunks).toBe(0);
    db.close();
  });
});

describe('searching while some chunks are still unembedded', () => {
  it('keeps working: the pending chunks are simply not candidates', async () => {
    const { fixture, db, file } = await buildEmbeddedSession();
    appendSession(file, [
      assistantMessage('A pending message nobody has embedded yet, about kerning.', {
        cwd: '/tmp/long',
        timestamp: '2026-02-04T00:00:00.000Z',
      }),
    ]);
    touch(file);
    await syncIndex(db, { projectsDir: fixture.projectsDir });

    const embedder = fakeEmbedder();
    const hybrid = await search({ db, query: 'editing the footage', embedder });
    expect(hybrid.length).toBeGreaterThan(0);
    expect(hybrid[0]!.modeUsed).toBe('hybrid');

    const semantic = await search({ db, query: 'editing the footage', mode: 'semantic', embedder });
    expect(semantic.length).toBeGreaterThan(0);
    db.close();
  });

  it('a snippet returned after a re-index still points at a message that exists', async () => {
    const { fixture, db, file } = await buildEmbeddedSession();
    const embedder = fakeEmbedder();
    // Warms the per-handle vector matrix with the old row ids.
    await search({ db, query: 'publishing the footage', mode: 'semantic', embedder });

    appendSession(file, [
      assistantMessage('Yet another message, so every chunk row id moves.', {
        cwd: '/tmp/long',
        timestamp: '2026-02-05T00:00:00.000Z',
      }),
    ]);
    touch(file);
    await syncIndex(db, { projectsDir: fixture.projectsDir });

    const hits = await search({ db, query: 'publishing the footage', mode: 'semantic', embedder });
    expect(hits.length).toBeGreaterThan(0);
    const exists = db
      .prepare('SELECT 1 AS ok FROM messages WHERE id = ?')
      .get(hits[0]!.snippet.messageId) as { ok: number } | undefined;
    expect(exists).toBeDefined();
    db.close();
  });
});
