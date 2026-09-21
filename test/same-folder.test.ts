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

  // Windows' other second spelling of one folder. `os.tmpdir()` on a CI runner
  // hands out `C:\Users\RUNNER~1\…` while the same folder is really
  // `C:\Users\runneradmin\…`; `--no-sync` would warn about a folder the user
  // never changed if those two did not compare equal.
  it.runIf(process.platform === 'win32')('sees through an 8.3 short-name spelling', () => {
    const dir = tempDir('sf-same-short-');
    const long = fs.realpathSync.native(dir);
    // Only meaningful when this machine really does hand out a short name.
    if (long === dir) return;
    expect(sameDirectory(dir, long)).toBe(true);
    expect(canonicalDir(dir)).toBe(long);
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
  it('says nothing when no --projects-dir was given and the default is the recorded one', async () => {
    const { db, projectsDir } = await indexed();
    const previous = process.env['CLAUDE_CONFIG_DIR'];
    // `$CLAUDE_CONFIG_DIR/projects` is exactly the folder the index holds, so
    // a run with no flag at all has nothing to warn about.
    process.env['CLAUDE_CONFIG_DIR'] = path.dirname(projectsDir);
    try {
      expect(projectsDirMismatch(undefined, { db })).toBeNull();
      expect(projectsDirMismatch('', { db })).toBeNull();
    } finally {
      if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
      else process.env['CLAUDE_CONFIG_DIR'] = previous;
    }
    db.close();
  });

  /**
   * The comment here used to claim that without `--projects-dir` the index and
   * the request agree by construction. They do not: the default folder moves
   * when `CLAUDE_CONFIG_DIR` changes, or when the index was built from a
   * `--projects-dir` that is not being passed this time.
   */
  it('still names both folders when the default folder is not the recorded one', async () => {
    const { db, projectsDir } = await indexed();
    const previous = process.env['CLAUDE_CONFIG_DIR'];
    const elsewhere = tempDir('sf-default-elsewhere-');
    process.env['CLAUDE_CONFIG_DIR'] = elsewhere;
    try {
      const line = projectsDirMismatch(undefined, { db });
      expect(line).not.toBeNull();
      expect(line).toContain(canonicalDir(projectsDir));
      expect(line).toContain(path.join(path.resolve(elsewhere), 'projects'));
    } finally {
      if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
      else process.env['CLAUDE_CONFIG_DIR'] = previous;
    }
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
