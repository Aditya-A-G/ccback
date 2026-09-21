/**
 * One answer to "are these two paths the same folder?".
 *
 * The indexer refuses to sync an index against a different transcripts folder,
 * and every front end warns when `--no-sync` is pointed at one. Those were two
 * copies of the same realpath-then-dev/ino rule; they are now one exported
 * `sameDirectory`, and `projectsDirMismatch` is the one sentence built on it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/core/index.js';
import { canonicalDir, projectsDirMismatch, sameDirectory, sync } from '../src/core/index.js';
import {
  cleanupTempDirs,
  makeFixture,
  openFixtureDb,
  tempDir,
  userMessage,
  writeSession,
} from './helpers.js';

afterAll(cleanupTempDirs);

describe('canonicalDir', () => {
  it('resolves a real directory the way the filesystem spells it', () => {
    const dir = tempDir('sf-canon-');
    expect(canonicalDir(dir)).toBe(fs.realpathSync.native(dir));
  });

  it('falls back to the resolved path when the directory is not there', () => {
    const missing = path.join(tempDir('sf-canon-gone-'), 'nowhere');
    expect(canonicalDir(missing)).toBe(path.resolve(missing));
  });
});

describe('sameDirectory', () => {
  it('ignores a trailing separator', () => {
    const dir = tempDir('sf-same-');
    expect(sameDirectory(dir, `${dir}${path.sep}`)).toBe(true);
  });

  it('says no to two different directories', () => {
    expect(sameDirectory(tempDir('sf-same-a-'), tempDir('sf-same-b-'))).toBe(false);
  });

  it('compares text when neither side exists', () => {
    const base = tempDir('sf-same-missing-');
    expect(sameDirectory(path.join(base, 'gone'), path.join(base, 'gone'))).toBe(true);
    expect(sameDirectory(path.join(base, 'gone'), path.join(base, 'other'))).toBe(false);
  });

  // Windows needs Developer Mode or elevation to create a symlink, so the
  // interesting case here cannot be set up there at all.
  it.skipIf(process.platform === 'win32')('sees through a symlinked spelling', () => {
    const base = tempDir('sf-same-link-');
    const real = path.join(base, 'real');
    const link = path.join(base, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    expect(sameDirectory(real, link)).toBe(true);
  });
});

/** A fixture whose index records its own transcripts folder. */
async function indexed(): Promise<{ projectsDir: string; db: Db }> {
  const fixture = makeFixture();
  writeSession(fixture.projectsDir, '-tmp-alpha', 'alpha', [
    userMessage('a conversation about recording videos', { cwd: '/tmp/alpha' }),
  ]);
  const db = openFixtureDb(fixture);
  await sync({ db, projectsDir: fixture.projectsDir });
  return { projectsDir: fixture.projectsDir, db };
}

describe('projectsDirMismatch', () => {
  it('says nothing when no --projects-dir was given', async () => {
    const { db } = await indexed();
    expect(projectsDirMismatch(undefined, { db })).toBeNull();
    expect(projectsDirMismatch('', { db })).toBeNull();
    db.close();
  });

  it('says nothing when the folder asked for is the one the index holds', async () => {
    const { db, projectsDir } = await indexed();
    expect(projectsDirMismatch(projectsDir, { db })).toBeNull();
    expect(projectsDirMismatch(`${projectsDir}${path.sep}`, { db })).toBeNull();
    db.close();
  });

  it('says nothing when the index has never recorded a folder', () => {
    const fixture = makeFixture();
    const db = openFixtureDb(fixture);
    expect(projectsDirMismatch(fixture.projectsDir, { db })).toBeNull();
    db.close();
  });

  it('names both folders when they differ', async () => {
    const { db, projectsDir } = await indexed();
    const elsewhere = tempDir('sf-mismatch-');
    const line = projectsDirMismatch(elsewhere, { db });
    expect(line).not.toBeNull();
    expect(line).toContain('--no-sync');
    // The index records the canonical spelling, which is not the one the
    // fixture handed over on a platform where a temp dir is a symlink.
    expect(line).toContain(canonicalDir(projectsDir));
    expect(line).toContain(path.resolve(elsewhere));
    // One line: every front end puts it somewhere that has exactly one.
    expect(line?.includes('\n')).toBe(false);
    db.close();
  });

  it('sanitises the path it echoes back', async () => {
    const { db } = await indexed();
    const hostile = path.join(tempDir('sf-hostile-'), 'esc\u001b[31mred\u0007');
    const line = projectsDirMismatch(hostile, { db });
    expect(line).not.toBeNull();
    expect(line).not.toContain('\u001b');
    expect(line).not.toContain('\u0007');
    // The printable part survives; only the control characters are dropped.
    expect(line).toContain('red');
    db.close();
  });
});
