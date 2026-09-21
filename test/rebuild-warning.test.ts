/**
 * `index --rebuild` throws the embeddings away too, and must say so.
 *
 * Its own file because the warning is deliberately printed once per process:
 * a run that rebuilds twenty databases should not print twenty lines.
 */
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { openDatabase, rebuildDatabase } from '../src/core/db.js';
import { toBlob } from '../src/core/semantic.js';
import { cleanupTempDirs, fakeEmbedder, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

describe('a deliberate rebuild', () => {
  it('stays quiet when there was nothing to lose', () => {
    const home = tempDir('sf-rebuild-quiet-');
    const db = openDatabase(path.join(home, 'index.db'));
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      rebuildDatabase(db);
    } finally {
      spy.mockRestore();
      db.close();
    }
    expect(written.join('')).toBe('');
  });

  it('says once that semantic search needs indexing again', async () => {
    const home = tempDir('sf-rebuild-');
    const db = openDatabase(path.join(home, 'index.db'));
    const [vector] = await fakeEmbedder().embed(['recording screencasts and editing the footage']);
    db.prepare('INSERT INTO chunks(message_id, session_id, text, embedding) VALUES (1, ?, ?, ?)').run(
      'video',
      'recording screencasts and editing the footage',
      toBlob(vector!),
    );

    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      rebuildDatabase(db);
      expect(db.prepare('SELECT COUNT(*) AS n FROM chunks').get()).toEqual({ n: 0 });

      // Second rebuild, with embeddings again: the point has been made.
      db.prepare('INSERT INTO chunks(message_id, session_id, text, embedding) VALUES (1, ?, ?, ?)').run(
        'video',
        'more recording',
        toBlob(vector!),
      );
      rebuildDatabase(db);
    } finally {
      spy.mockRestore();
      db.close();
    }

    const told = written.filter((line) => line.includes('embeddings are gone'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('rebuilt in the background');
  });
});
