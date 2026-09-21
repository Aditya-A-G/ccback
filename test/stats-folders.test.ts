/**
 * Where the counts came from.
 *
 * `--stats` printed the folder it was *asked* about next to counts that had
 * been built from somewhere else entirely — so an index built from a
 * `--projects-dir` you are not passing this time looked like an index of the
 * default folder, with sessions and messages to match. Both folders are on
 * screen now whenever they differ, and one line when they do not.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { IndexStatus } from '../src/core/index.js';
import { canonicalDir, status, sync } from '../src/core/index.js';
import { startWebServer } from '../src/web/index.js';
import { request } from './web/web-helpers.js';
import {
  childEnv,
  cleanupTempDirs,
  makeFixture,
  openFixtureDb,
  tempDir,
  userMessage,
  writeSession,
  type Fixture,
} from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');

afterAll(cleanupTempDirs);

async function indexed(): Promise<Fixture> {
  const fixture = makeFixture();
  writeSession(fixture.projectsDir, '-tmp-alpha', 'alpha', [
    userMessage('a conversation about recording videos', { cwd: '/tmp/alpha' }),
  ]);
  const db = openFixtureDb(fixture);
  await sync({ db, projectsDir: fixture.projectsDir });
  db.close();
  return fixture;
}

function run(fixture: Fixture, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: childEnv({ CCFIND_HOME: fixture.home }),
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('status()', () => {
  it('records the folder the index was built from', async () => {
    const fixture = await indexed();
    const same = status({ dbPath: fixture.dbPath, projectsDir: fixture.projectsDir });
    expect(same.indexedProjectsDir).toBe(canonicalDir(fixture.projectsDir));
    expect(same.projectsDirMatchesIndex).toBe(true);

    const elsewhere = tempDir('ccfind-stats-elsewhere-');
    const different = status({ dbPath: fixture.dbPath, projectsDir: elsewhere });
    expect(different.projectsDir).toBe(path.resolve(elsewhere));
    expect(different.indexedProjectsDir).toBe(canonicalDir(fixture.projectsDir));
    expect(different.projectsDirMatchesIndex).toBe(false);
    // The counts are the recorded folder's, which is the whole point.
    expect(different.sessions).toBe(1);
  });

  it('says nothing it does not know for an index that has never synced', () => {
    const fixture = makeFixture();
    const fresh = status({ dbPath: fixture.dbPath, projectsDir: fixture.projectsDir });
    expect(fresh.indexedProjectsDir).toBeNull();
    expect(fresh.projectsDirMatchesIndex).toBe(true);
  });
});

describe('--stats', () => {
  it('shows one folder line when the index and the request agree', async () => {
    const fixture = await indexed();
    const result = run(fixture, ['--stats', '--projects-dir', fixture.projectsDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('projects dir');
    expect(result.stdout).not.toContain('index built from');
  });

  it('shows both folders when the counts came from another one', async () => {
    const fixture = await indexed();
    const elsewhere = tempDir('ccfind-stats-asked-');
    const result = run(fixture, ['--no-sync', '--stats', '--projects-dir', elsewhere]);
    expect(result.status).toBe(0);

    const dirLine = result.stdout.split('\n').find((line) => line.startsWith('projects dir'))!;
    const fromLine = result.stdout.split('\n').find((line) => line.startsWith('index built from'))!;
    expect(dirLine).toContain(path.resolve(elsewhere));
    expect(fromLine).toContain(canonicalDir(fixture.projectsDir));
    // The line above the counts is the one they belong to.
    expect(result.stdout.indexOf('index built from')).toBeLessThan(result.stdout.indexOf('sessions'));
  });

  it('carries both into --json', async () => {
    const fixture = await indexed();
    const elsewhere = tempDir('ccfind-stats-json-');
    const result = run(fixture, ['--no-sync', '--stats', '--json', '--projects-dir', elsewhere]);
    const body = JSON.parse(result.stdout) as IndexStatus;
    expect(body.projectsDir).toBe(path.resolve(elsewhere));
    expect(body.indexedProjectsDir).toBe(canonicalDir(fixture.projectsDir));
    expect(body.projectsDirMatchesIndex).toBe(false);
  });
});

describe('/api/status', () => {
  it('reports both folders when they differ', async () => {
    const fixture = await indexed();
    const elsewhere = tempDir('ccfind-stats-web-');
    const db = openFixtureDb(fixture);
    const handle = await startWebServer({
      port: 0,
      db,
      dbPath: fixture.dbPath,
      appHome: fixture.home,
      projectsDir: elsewhere,
      announce: false,
      autoEmbed: false,
    });
    try {
      const body = (await request(handle.port, '/api/status')).json() as IndexStatus;
      expect(body.projectsDir).toBe(path.resolve(elsewhere));
      expect(body.indexedProjectsDir).toBe(canonicalDir(fixture.projectsDir));
      expect(body.projectsDirMatchesIndex).toBe(false);
      expect(body.sessions).toBe(1);
    } finally {
      await handle.close();
      db.close();
    }
  });
});

describe('the CLI it all runs through', () => {
  it('is built', () => {
    expect(fs.existsSync(cliPath)).toBe(true);
  });
});
