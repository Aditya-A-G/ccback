/**
 * What the tool does when something is wrong: a broken index, a transcript
 * directory that is not there, an empty history. Each one gets a sentence a
 * person can act on, an honest exit code, and never a stack trace.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase, SCHEMA_VERSION, setMeta } from '../src/core/db.js';
import { UserError } from '../src/core/errors.js';
import { syncIndex } from '../src/core/indexer.js';
import { status } from '../src/core/api.js';
import {
  aiTitle,
  childEnv,
  cleanupTempDirs,
  makeFixture,
  tempDir,
  userMessage,
  writeSession,
  type Fixture,
} from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');

let fixture: Fixture;

beforeAll(() => {
  fixture = makeFixture();
  writeSession(fixture.projectsDir, '-tmp-alpha', 'alpha', [
    aiTitle('Recording and editing videos'),
    userMessage('how I will be recording the videos and how you will be editing them', { cwd: '/tmp/alpha' }),
  ]);
});

afterAll(cleanupTempDirs);

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string | undefined> = {}): Run {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: childEnv({ CCFIND_HOME: fixture.home, ...env }),
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const hasStack = (text: string): boolean => text.includes('    at ') || text.includes('SqliteError');

/* ------------------------------------------------------ 5. a broken index */

describe('an unreadable index (ux 5)', () => {
  it('explains it in one line with the fix, exit 2, for search, index, stats and web', () => {
    const home = tempDir('sf-corrupt-');
    const dbPath = path.join(home, 'index.db');
    fs.writeFileSync(dbPath, 'this is definitely not a SQLite database\n'.repeat(40));

    for (const args of [
      ['recording'],
      ['--reindex'],
      ['--stats'],
      ['--web', '--no-open'],
    ]) {
      const result = run([...args, '--projects-dir', fixture.projectsDir], { CCFIND_HOME: home });
      expect([args.join(' '), result.status]).toEqual([args.join(' '), 2]);
      const lines = result.stderr.trim().split('\n');
      expect([args.join(' '), lines.length]).toEqual([args.join(' '), 1]);
      expect(lines[0]).toContain(`The search index at ${dbPath} is unusable`);
      expect(lines[0]).toContain(`Delete ${dbPath} and run again; it is rebuilt automatically.`);
      expect(hasStack(result.stderr)).toBe(false);
    }
  });

  it('works again after deleting the file, exactly as the message says', () => {
    const home = tempDir('sf-corrupt2-');
    const dbPath = path.join(home, 'index.db');
    fs.writeFileSync(dbPath, 'garbage');
    expect(run(['recording', '--projects-dir', fixture.projectsDir], { CCFIND_HOME: home }).status).toBe(2);

    fs.rmSync(dbPath);
    const after = run(['recording', '--projects-dir', fixture.projectsDir], { CCFIND_HOME: home });
    expect(after.status).toBe(0);
    expect(after.stdout).toContain('alpha');
  });

  it('refuses an index from a newer build instead of wiping it', () => {
    const home = tempDir('sf-newer-');
    const dbPath = path.join(home, 'index.db');
    const db = openDatabase(dbPath);
    setMeta(db, 'schema_version', String(SCHEMA_VERSION + 7));
    db.close();

    const result = run(['recording', '--projects-dir', fixture.projectsDir], { CCFIND_HOME: home });
    expect(result.status).toBe(2);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('written by a newer version of ccfind');
    expect(hasStack(result.stderr)).toBe(false);

    // The file is still there: nothing was destroyed on the user's behalf.
    expect(fs.existsSync(dbPath)).toBe(true);
    const still = new Database(dbPath, { readonly: true });
    expect(still.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')).toEqual({
      value: String(SCHEMA_VERSION + 7),
    });
    still.close();
  });

  it('says a directory where the index should be is unusable, in one line, exit 2', () => {
    const home = tempDir('sf-weird-');
    // A directory where the index file should be: not corruption, just broken.
    // SQLite cannot open it, and the fix is the same as for a corrupt file.
    fs.mkdirSync(path.join(home, 'index.db'), { recursive: true });

    const result = run(['recording', '--projects-dir', fixture.projectsDir], { CCFIND_HOME: home });
    expect(result.status).toBe(2);
    expect(hasStack(result.stderr)).toBe(false);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('is unusable');
    expect(result.stderr).toContain(`Delete ${path.join(home, 'index.db')}`);
  });

  it('prints one line plus a debug hint for an error nobody planned for', () => {
    // A home directory that cannot exist: the failure happens before SQLite is
    // involved at all, so it is nobody's planned-for case.
    const home = '/dev/null/session-finder-home';

    const result = run(['recording', '--projects-dir', fixture.projectsDir], { CCFIND_HOME: home });
    expect(result.status).toBe(1);
    expect(hasStack(result.stderr)).toBe(false);
    expect(result.stderr.trim().split('\n')).toHaveLength(2);
    expect(result.stderr).toContain('CCFIND_DEBUG=1');

    const debug = run(['recording', '--projects-dir', fixture.projectsDir], {
      CCFIND_HOME: home,
      CCFIND_DEBUG: '1',
    });
    expect(debug.status).toBe(1);
    expect(debug.stderr).toContain('    at ');
  });

  it('an older schema version is migrated in place, not wiped', async () => {
    const home = tempDir('sf-old-');
    const dbPath = path.join(home, 'index.db');
    const db = openDatabase(dbPath);
    await syncIndex(db, { projectsDir: fixture.projectsDir });
    setMeta(db, 'schema_version', '1');
    db.close();

    const reopened = openDatabase(dbPath);
    expect(reopened.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')).toEqual({
      value: String(SCHEMA_VERSION),
    });
    // What the user already indexed survives the upgrade.
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    const result = await syncIndex(reopened, { projectsDir: fixture.projectsDir });
    expect(result.sessions).toBe(1);
    reopened.close();
  });
});

/* -------------------------------------- 6. a transcript directory that is not there */

describe('a missing transcripts directory (ux 6)', () => {
  const missing = '/nonexistent-claude-projects-for-tests';

  it('is a setup error with a hint, not an empty history', () => {
    for (const args of [['recording'], ['--reindex'], []]) {
      const result = run([...args, '--projects-dir', missing]);
      const label = args.join(' ') || '(bare)';
      expect([label, result.status]).toEqual([label, 2]);
      expect(result.stderr).toContain(`No Claude Code transcripts found at ${missing}`);
      expect(result.stderr).toContain('--projects-dir');
      expect(result.stderr).toContain('CLAUDE_CONFIG_DIR');
      expect(result.stdout).not.toContain('No matching sessions');
      expect(hasStack(result.stderr)).toBe(false);
    }
  });

  it('still lets --stats answer "where does this keep its files?"', () => {
    // That is exactly the question somebody asks when the directory is not
    // where ccfind looked, so it answers it and adds the hint.
    const result = run(['--stats', '--projects-dir', missing]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('projects dir');
    expect(result.stdout).toContain('index');
    expect(result.stdout).toContain(`No Claude Code transcripts found at ${missing}`);
    expect(result.stdout).toContain('--projects-dir');
    expect(hasStack(result.stderr)).toBe(false);
  });

  it('is reported the same way by the core, for the TUI and the web to show', async () => {
    const home = tempDir('sf-missing-');
    const db = openDatabase(path.join(home, 'index.db'));
    await expect(syncIndex(db, { projectsDir: missing })).rejects.toBeInstanceOf(UserError);

    const info = status({ db, projectsDir: missing });
    expect(info.projectsDirExists).toBe(false);
    expect(info.projectsDirHint).toContain(`No Claude Code transcripts found at ${missing}`);
    db.close();
  });

  it('an existing but empty directory is not an error', () => {
    const empty = tempDir('sf-empty-projects-');
    const home = tempDir('sf-empty-home-');
    const result = run(['recording', '--projects-dir', empty], { CCFIND_HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('No sessions yet');

    const browsing = run(['--projects-dir', empty], { CCFIND_HOME: home });
    expect(browsing.status).toBe(0);
    expect(browsing.stdout.trim()).toBe('No sessions yet');
  });

  it('still says "No matching sessions." when the index has sessions but none match', () => {
    const result = run(['zzzqqqxyz', '--projects-dir', fixture.projectsDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No matching sessions.');
  });
});

describe('files that could not be read (should-fix 9)', () => {
  // root can read a 0o000 file, and chmod on Windows only toggles the
  // read-only bit — neither can make a file genuinely unreadable.
  const rootOnly = process.getuid?.() === 0 || process.platform === 'win32';

  it.skipIf(rootOnly)('are reported on stderr and retried, not silently dropped', () => {
    const projects = tempDir('sf-unreadable-projects-');
    const home = tempDir('sf-unreadable-home-');
    writeSession(projects, '-tmp-good', 'good', [userMessage('a readable session about videos', { cwd: '/tmp/good' })]);
    const broken = writeSession(projects, '-tmp-bad', 'bad', [
      userMessage('an unreadable session about videos', { cwd: '/tmp/bad' }),
    ]);
    fs.chmodSync(broken, 0o000);

    const first = run(['--reindex', '--projects-dir', projects], { CCFIND_HOME: home });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('1 sessions');
    expect(first.stderr).toContain('Could not read 1 transcript file;');
    // One file is "it", not "they": the summary reads as a sentence.
    expect(first.stderr).toContain('it was left out and will be retried on the next run.');
    expect(first.stderr).not.toContain('they were');
    expect(hasStack(first.stderr)).toBe(false);

    fs.chmodSync(broken, 0o644);
    const second = run(['--reindex', '--projects-dir', projects], { CCFIND_HOME: home });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('2 sessions');
    expect(second.stderr).not.toContain('Could not read');
  });
});

/* ------------------------------------------------- 7, 8, 12. honest output */

describe('counts and flags (ux 7, 8 and should-fix 12)', () => {
  it('shows no count at all when browsing without a query', () => {
    const result = run(['--projects-dir', fixture.projectsDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Recording and editing videos');
    expect(result.stdout).not.toContain('0 matches');
    expect(result.stdout).not.toMatch(/\d+ match/);
    expect(result.stdout).not.toContain('mention');
  });

  it('says what the number means when there is a query', () => {
    const result = run(['recording videos', '--projects-dir', fixture.projectsDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/1 message mentions this|\d+ messages mention this/);
    expect(result.stdout).not.toMatch(/\d+ matches?\b/);
  });

  it('rejects a --limit above 200 with a usage error', () => {
    const tooMany = run(['recording', '--limit', '201', '--projects-dir', fixture.projectsDir]);
    expect(tooMany.status).toBe(2);
    expect(tooMany.stderr).toContain('--limit must be 200 or less');
    expect(hasStack(tooMany.stderr)).toBe(false);

    expect(run(['recording', '--limit', '200', '--projects-dir', fixture.projectsDir]).status).toBe(0);
  });

  it('prints a local date, not a UTC ISO day', () => {
    const result = run(['recording videos', '--projects-dir', fixture.projectsDir], {
      TZ: 'Pacific/Kiritimati',
      LANG: 'en_US.UTF-8',
    });
    expect(result.status).toBe(0);
    const metaLine = result.stdout.split('\n').find((l) => l.includes(' · ')) ?? '';
    expect(metaLine).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // The fixture message is 2026-09-10T12:00Z, which is the 11th in +14:00.
    expect(metaLine).toMatch(/Sep 11, 2026|11 Sep 2026/);
  });
});
