import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listSessionFiles, syncIndex } from '../src/core/indexer.js';
import { keywordSearch } from '../src/core/keyword.js';
import {
  appendSession,
  assistantMessage,
  cleanupTempDirs,
  makeFixture,
  openFixtureDb,
  snapshotTree,
  userMessage,
  writeSession,
} from './helpers.js';

afterAll(cleanupTempDirs);

describe('subagent transcripts (criterion 2)', () => {
  it('never indexes files under <sessionId>/subagents/', async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-app', 'main-session', [
      userMessage('the visible parent conversation about pelicans', { cwd: '/tmp/app' }),
    ]);

    const subagentDir = path.join(fixture.projectsDir, '-tmp-app', 'main-session', 'subagents');
    fs.mkdirSync(subagentDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentDir, 'sub-1.jsonl'),
      `${JSON.stringify(userMessage('the hidden subagent conversation about pelicans', { cwd: '/tmp/app' }))}\n`,
    );

    const files = await listSessionFiles(fixture.projectsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/main-session\.jsonl$/);

    const db = openFixtureDb(fixture);
    const result = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(result.sessions).toBe(1);

    const hits = keywordSearch(db, 'pelicans');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sessionId).toBe('main-session');
    expect(db.prepare("SELECT COUNT(*) AS n FROM files WHERE path LIKE '%subagents%'").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('read-only guarantee (criterion 4 of the task brief)', () => {
  it('never writes anything inside the projects directory', async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-app', 's1', [userMessage('hello world', { cwd: '/tmp/app' })]);
    writeSession(fixture.projectsDir, '-tmp-other', 's2', [userMessage('second session', { cwd: '/tmp/other' })]);

    const before = snapshotTree(fixture.projectsDir);
    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });
    keywordSearch(db, 'hello world');
    await syncIndex(db, { projectsDir: fixture.projectsDir });
    db.close();
    const after = snapshotTree(fixture.projectsDir);

    expect(after).toEqual(before);
  });
});

describe('incremental sync (criterion 6)', () => {
  it('re-parses nothing when nothing changed', async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-a', 's1', [userMessage('alpha content', { cwd: '/tmp/a' })]);
    writeSession(fixture.projectsDir, '-tmp-b', 's2', [userMessage('beta content', { cwd: '/tmp/b' })]);

    const db = openFixtureDb(fixture);
    const first = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(first.indexedFiles).toBe(2);
    expect(first.skippedFiles).toBe(0);

    const second = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(second.indexedFiles).toBe(0);
    expect(second.skippedFiles).toBe(2);
    expect(second.sessions).toBe(2);
    db.close();
  });

  it('re-indexes only the appended session', async () => {
    const fixture = makeFixture();
    const fileA = writeSession(fixture.projectsDir, '-tmp-a', 's1', [
      userMessage('alpha content', { cwd: '/tmp/a' }),
    ]);
    writeSession(fixture.projectsDir, '-tmp-b', 's2', [userMessage('beta content', { cwd: '/tmp/b' })]);

    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });

    appendSession(fileA, [assistantMessage('a freshly appended sentence about kangaroos', { cwd: '/tmp/a' })]);
    // mtime granularity can be coarse; make the change unambiguous.
    const now = new Date(Date.now() + 2000);
    fs.utimesSync(fileA, now, now);

    const second = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(second.indexedFiles).toBe(1);
    expect(second.skippedFiles).toBe(1);

    const hits = keywordSearch(db, 'kangaroos');
    expect(hits.map((h) => h.sessionId)).toEqual(['s1']);
    // The re-index must not duplicate the original message.
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get('s1') as { n: number };
    expect(count.n).toBe(2);
    db.close();
  });

  it('removes a session when its file is deleted', async () => {
    const fixture = makeFixture();
    const fileA = writeSession(fixture.projectsDir, '-tmp-a', 's1', [
      userMessage('alpha content about wombats', { cwd: '/tmp/a' }),
    ]);
    writeSession(fixture.projectsDir, '-tmp-b', 's2', [userMessage('beta content', { cwd: '/tmp/b' })]);

    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(keywordSearch(db, 'wombats')).toHaveLength(1);

    fs.rmSync(fileA);
    const second = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(second.removedFiles).toBe(1);
    expect(second.sessions).toBe(1);
    expect(keywordSearch(db, 'wombats')).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?').get('s1')).toEqual({ n: 0 });
    db.close();
  });

  it('records unindexable files so they are not re-parsed every sync', async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-a', 'nothing', [{ type: 'mode', mode: 'default' }]);

    const db = openFixtureDb(fixture);
    const first = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(first.skippedSessions).toBe(1);
    expect(first.sessions).toBe(0);

    // `skippedSessions` counts the files in a skipped state, not the writes, so
    // a second run over the same disk reports the same number.
    const second = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(second.skippedSessions).toBe(1);
    expect(second.skippedFiles).toBe(1);
    db.close();
  });

  it('--rebuild drops everything first', async () => {
    const fixture = makeFixture();
    const file = writeSession(fixture.projectsDir, '-tmp-a', 's1', [
      userMessage('alpha content', { cwd: '/tmp/a' }),
    ]);
    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });
    fs.rmSync(file);

    const rebuilt = await syncIndex(db, { projectsDir: fixture.projectsDir, rebuild: true });
    expect(rebuilt.sessions).toBe(0);
    expect(rebuilt.messages).toBe(0);
    db.close();
  });

  it('keeps indexing when one file is garbage (criterion 5)', async () => {
    const fixture = makeFixture();
    writeSession(
      fixture.projectsDir,
      '-tmp-a',
      'ragged',
      [userMessage('a good message about narwhals', { cwd: '/tmp/a' })],
      ['}{ not json', '{"type":"user","message":{"role":"user","content":"trunc'],
    );
    const db = openFixtureDb(fixture);
    const result = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(result.sessions).toBe(1);
    expect(keywordSearch(db, 'narwhals')).toHaveLength(1);
    db.close();
  });
});

/* ------------------------------------------------- adversarial review fixes */

describe('a file whose parse throws is retried, not written off (should-fix 9)', () => {
  // root can read a 0o000 file, and chmod on Windows only toggles the
  // read-only bit — neither can make a file genuinely unreadable.
  const rootOnly = process.getuid?.() === 0 || process.platform === 'win32';

  it.skipIf(rootOnly)('leaves an unreadable file unrecorded and counts it', async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-ok', 'good-session', [
      userMessage('a readable conversation about pelicans', { cwd: '/tmp/ok' }),
    ]);
    const broken = writeSession(fixture.projectsDir, '-tmp-bad', 'broken-session', [
      userMessage('a conversation nobody can read', { cwd: '/tmp/bad' }),
    ]);
    fs.chmodSync(broken, 0o000);

    const db = openFixtureDb(fixture);
    const first = await syncIndex(db, { projectsDir: fixture.projectsDir });

    // The other files were still indexed.
    expect(first.indexedFiles).toBe(1);
    expect(first.failedFiles).toBe(1);
    expect(first.skippedSessions).toBe(0);
    const tracked = db.prepare('SELECT path FROM files').all() as { path: string }[];
    expect(tracked.map((row) => row.path)).not.toContain(broken);

    // Still unreadable: tried again, still not recorded.
    const second = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(second.failedFiles).toBe(1);
    expect(second.skippedFiles).toBe(1);

    // Readable again: indexed without any file having to change.
    fs.chmodSync(broken, 0o644);
    const third = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(third.failedFiles).toBe(0);
    expect(third.indexedFiles).toBe(1);
    expect(keywordSearch(db, 'nobody read').map((r) => r.sessionId)).toContain('broken-session');
  });

  it('records a file that parsed fine but held nothing, so it is not re-parsed', async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-empty', 'empty-session', [{ type: 'mode', mode: 'plan' }]);

    const db = openFixtureDb(fixture);
    const first = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(first.skippedSessions).toBe(1);
    expect(first.failedFiles).toBe(0);

    const second = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(second.skippedFiles).toBe(1);
    expect(second.indexedFiles).toBe(0);
  });
});

describe('the same session id in two folders (should-fix 11)', () => {
  const twoCopies = (): { fixture: ReturnType<typeof makeFixture>; older: string; newer: string } => {
    const fixture = makeFixture();
    const older = writeSession(fixture.projectsDir, '-tmp-one', 'twin', [
      userMessage('the older copy talks about pelicans', { cwd: '/tmp/one' }),
    ]);
    const newer = writeSession(fixture.projectsDir, '-tmp-two', 'twin', [
      userMessage('the newer copy talks about pelicans', { cwd: '/tmp/two' }),
    ]);
    fs.utimesSync(older, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    fs.utimesSync(newer, new Date(1_800_000_000_000), new Date(1_800_000_000_000));
    return { fixture, older, newer };
  };

  it('indexes the most recently modified file and tracks the other as a duplicate', async () => {
    const { fixture, older, newer } = twoCopies();
    const db = openFixtureDb(fixture);
    const result = await syncIndex(db, { projectsDir: fixture.projectsDir });

    expect(result.sessions).toBe(1);
    const session = db.prepare('SELECT cwd, file_path FROM sessions WHERE id = ?').get('twin') as {
      cwd: string;
      file_path: string;
    };
    expect(session.file_path).toBe(newer);
    expect(session.cwd).toBe('/tmp/two');

    const loser = db.prepare('SELECT session_id, state FROM files WHERE path = ?').get(older) as {
      session_id: string | null;
      state: string;
    };
    expect(loser).toEqual({ session_id: null, state: 'duplicate' });

    // Deterministic: a second run reaches the same answer and re-parses nothing.
    const again = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(again.indexedFiles).toBe(0);
    expect(again.sessions).toBe(1);
  });

  it('deleting the duplicate leaves the indexed copy untouched', async () => {
    const { fixture, older } = twoCopies();
    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });

    fs.rmSync(older);
    const result = await syncIndex(db, { projectsDir: fixture.projectsDir });

    expect(result.removedFiles).toBe(1);
    expect(result.sessions).toBe(1);
    expect(keywordSearch(db, 'pelicans').map((r) => r.sessionId)).toEqual(['twin']);
    expect(
      (db.prepare('SELECT cwd FROM sessions WHERE id = ?').get('twin') as { cwd: string }).cwd,
    ).toBe('/tmp/two');
  });

  it('promotes the other file when the indexed one is deleted', async () => {
    const { fixture, newer } = twoCopies();
    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });

    fs.rmSync(newer);
    const result = await syncIndex(db, { projectsDir: fixture.projectsDir });

    expect(result.sessions).toBe(1);
    expect(result.indexedFiles).toBe(1);
    const session = db.prepare('SELECT cwd FROM sessions WHERE id = ?').get('twin') as { cwd: string };
    expect(session.cwd).toBe('/tmp/one');
    expect(keywordSearch(db, 'older copy').map((r) => r.sessionId)).toEqual(['twin']);
  });
});

/* ------------------------------------ second review, must-fix 3: ownership */

describe('a newer file that yields nothing must not hide the older one', () => {
  // root can read a 0o000 file, and chmod on Windows only toggles the
  // read-only bit — neither can make a file genuinely unreadable.
  const rootOnly = process.getuid?.() === 0 || process.platform === 'win32';

  /** Two files with the same session id; the newer one is handed to `spoil`. */
  const twins = (
    spoil: (newerPath: string) => void,
  ): { fixture: ReturnType<typeof makeFixture>; older: string; newer: string } => {
    const fixture = makeFixture();
    const older = writeSession(fixture.projectsDir, '-tmp-one', 'twin', [
      userMessage('the older copy talks about pelicans', { cwd: '/tmp/one' }),
    ]);
    const newer = writeSession(fixture.projectsDir, '-tmp-two', 'twin', [
      userMessage('the newer copy talks about pelicans', { cwd: '/tmp/two' }),
    ]);
    spoil(newer);
    fs.utimesSync(older, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    fs.utimesSync(newer, new Date(1_800_000_000_000), new Date(1_800_000_000_000));
    return { fixture, older, newer };
  };

  const summary = (result: Awaited<ReturnType<typeof syncIndex>>): string =>
    `${result.scannedFiles}/${result.indexedFiles}/${result.skippedFiles}/${result.removedFiles}/` +
    `${result.skippedSessions}/${result.failedFiles}/${result.sessions}`;

  it.skipIf(rootOnly)('an unreadable newer file leaves the older one searchable', async () => {
    const { fixture, older, newer } = twins((p) => fs.chmodSync(p, 0o000));
    try {
      const db = openFixtureDb(fixture);
      const first = await syncIndex(db, { projectsDir: fixture.projectsDir });

      expect(first.failedFiles).toBe(1);
      expect(first.sessions).toBe(1);
      expect(keywordSearch(db, 'older copy').map((r) => r.sessionId)).toEqual(['twin']);
      expect((db.prepare('SELECT cwd FROM sessions WHERE id = ?').get('twin') as { cwd: string }).cwd).toBe('/tmp/one');
      expect((db.prepare('SELECT state FROM files WHERE path = ?').get(older) as { state: string }).state).toBe(
        'indexed',
      );
      // The file that could not be read is not recorded, so it is retried.
      expect(db.prepare('SELECT path FROM files WHERE path = ?').get(newer)).toBeUndefined();

      // Two consecutive runs over an unchanged disk say exactly the same thing.
      const second = await syncIndex(db, { projectsDir: fixture.projectsDir });
      const third = await syncIndex(db, { projectsDir: fixture.projectsDir });
      expect(summary(third)).toBe(summary(second));
      expect(second.failedFiles).toBe(1);
      expect(second.skippedSessions).toBe(first.skippedSessions);
      expect(third.sessions).toBe(1);

      // And the newer file takes over the moment it can be read.
      fs.chmodSync(newer, 0o644);
      const fourth = await syncIndex(db, { projectsDir: fixture.projectsDir });
      expect(fourth.failedFiles).toBe(0);
      expect((db.prepare('SELECT cwd FROM sessions WHERE id = ?').get('twin') as { cwd: string }).cwd).toBe('/tmp/two');
      expect((db.prepare('SELECT state FROM files WHERE path = ?').get(older) as { state: string }).state).toBe(
        'duplicate',
      );
      db.close();
    } finally {
      fs.chmodSync(newer, 0o644);
    }
  });

  it('a zero-byte newer file leaves the older one searchable', async () => {
    const { fixture, older, newer } = twins((p) => fs.writeFileSync(p, ''));
    const db = openFixtureDb(fixture);
    const first = await syncIndex(db, { projectsDir: fixture.projectsDir });

    expect(first.sessions).toBe(1);
    expect(keywordSearch(db, 'older copy').map((r) => r.sessionId)).toEqual(['twin']);
    expect((db.prepare('SELECT state FROM files WHERE path = ?').get(newer) as { state: string }).state).toBe('empty');
    expect((db.prepare('SELECT state FROM files WHERE path = ?').get(older) as { state: string }).state).toBe(
      'indexed',
    );

    // Nothing on disk changed, so nothing about the report changes either: the
    // file that holds no session is counted as skipped on every run, not once.
    const second = await syncIndex(db, { projectsDir: fixture.projectsDir });
    const third = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(summary(third)).toBe(summary(second));
    expect([first.skippedSessions, second.skippedSessions, third.skippedSessions]).toEqual([1, 1, 1]);
    expect(third.sessions).toBe(1);
    expect(keywordSearch(db, 'older copy').map((r) => r.sessionId)).toEqual(['twin']);
    db.close();
  });

  it('a newer file with nothing indexable in it leaves the older one searchable', async () => {
    const { fixture, newer } = twins((p) => fs.writeFileSync(p, `${JSON.stringify({ type: 'mode', mode: 'plan' })}\n`));
    const db = openFixtureDb(fixture);
    const first = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(first.sessions).toBe(1);
    expect(keywordSearch(db, 'older copy').map((r) => r.sessionId)).toEqual(['twin']);
    expect((db.prepare('SELECT state FROM files WHERE path = ?').get(newer) as { state: string }).state).toBe('empty');

    const second = await syncIndex(db, { projectsDir: fixture.projectsDir });
    const third = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(summary(third)).toBe(summary(second));
    expect([first.skippedSessions, second.skippedSessions]).toEqual([1, 1]);
    expect(keywordSearch(db, 'older copy')).toHaveLength(1);
    db.close();
  });

  it('a newer file that becomes empty gives the session back to the older copy', async () => {
    const { fixture, older, newer } = twins(() => {});
    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect((db.prepare('SELECT cwd FROM sessions WHERE id = ?').get('twin') as { cwd: string }).cwd).toBe('/tmp/two');

    // The winner is emptied out; the loser must be promoted, not deleted too.
    fs.writeFileSync(newer, '');
    fs.utimesSync(newer, new Date(1_900_000_000_000), new Date(1_900_000_000_000));
    const result = await syncIndex(db, { projectsDir: fixture.projectsDir });
    expect(result.sessions).toBe(1);
    expect((db.prepare('SELECT cwd FROM sessions WHERE id = ?').get('twin') as { cwd: string }).cwd).toBe('/tmp/one');
    expect(keywordSearch(db, 'older copy').map((r) => r.sessionId)).toEqual(['twin']);
    expect((db.prepare('SELECT state FROM files WHERE path = ?').get(older) as { state: string }).state).toBe(
      'indexed',
    );
    db.close();
  });
});

describe('one index, one transcripts folder', () => {
  it('refuses to sync against a different folder instead of pruning everything', async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-app', 'kept-session', [
      userMessage('a conversation about herons', { cwd: '/tmp/app' }),
    ]);
    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });

    const other = makeFixture();
    await expect(syncIndex(db, { projectsDir: other.projectsDir })).rejects.toThrow(/built from/);
    expect(keywordSearch(db, 'herons')).toHaveLength(1);

    // An explicit full rebuild is the way to switch folders.
    const switched = await syncIndex(db, { projectsDir: other.projectsDir, rebuild: true });
    expect(switched.sessions).toBe(0);
    await syncIndex(db, { projectsDir: other.projectsDir });
    db.close();
  });

  it('also protects an index from before the folder was recorded, even against an ancestor path', async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-app', 'legacy-session', [
      userMessage('a conversation about egrets', { cwd: '/tmp/app' }),
    ]);
    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });
    db.prepare("DELETE FROM meta WHERE key = 'projects_dir'").run();

    await expect(syncIndex(db, { projectsDir: path.dirname(fixture.projectsDir) })).rejects.toThrow(/built from/);
    expect(keywordSearch(db, 'egrets')).toHaveLength(1);
    db.close();
  });

  it('accepts another spelling of the same folder (symlink)', async () => {
    const fixture = makeFixture();
    writeSession(fixture.projectsDir, '-tmp-app', 'linked-session', [
      userMessage('a conversation about ibises', { cwd: '/tmp/app' }),
    ]);
    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });

    const link = `${fixture.projectsDir}-link`;
    fs.symlinkSync(fixture.projectsDir, link);
    try {
      const again = await syncIndex(db, { projectsDir: link });
      expect(again.sessions).toBe(1);
      expect(keywordSearch(db, 'ibises')).toHaveLength(1);
    } finally {
      fs.unlinkSync(link);
    }
    db.close();
  });
});
