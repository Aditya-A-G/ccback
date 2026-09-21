/**
 * The suite's own safety net.
 *
 * Two runs of this project's tooling wrote into a real `~/.ccfind` because
 * `CCFIND_HOME` was exported in the shell that started them: the test files set
 * the *legacy* variable on their children, and the inherited one outranked it.
 * So the run now sets its own home before any test module loads, every spawned
 * child is given one explicitly, and the real app home is stat-ed before and
 * after the run.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { childEnv, cleanupTempDirs, SCRUBBED_ENV, tempDir, userMessage, writeSession } from './helpers.js';
import { realAppHome, snapshotDifferences, statSnapshot } from './real-home-guard.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');

afterAll(cleanupTempDirs);

/** A home this run must never be pointed at, even if a fix regresses. */
const POISON_HOME = '/nonexistent-ccfind-home-that-must-never-be-used';

describe('the environment every test runs in', () => {
  it('points HOME and CCFIND_HOME at a temp directory, never at the real one', () => {
    const appHome = process.env['CCFIND_HOME'];
    const home = process.env['HOME'] ?? process.env['USERPROFILE'];
    expect(appHome, 'CCFIND_HOME must be set by the vitest setup file').toBeTruthy();
    expect(home, 'HOME must be set by the vitest setup file').toBeTruthy();
    const temp = fs.realpathSync(os.tmpdir());
    expect(fs.realpathSync(appHome as string).startsWith(temp)).toBe(true);
    expect(fs.realpathSync(home as string).startsWith(temp)).toBe(true);
    // And whatever the caller exported is gone: this is the exact failure that
    // let `CCFIND_HOME=/somewhere npx vitest run` write outside the temp tree.
    expect(appHome).not.toBe(POISON_HOME);
    expect(appHome).not.toBe('/tmp/should-not-be-used');
  });

  it('never loads the embedding model and never colours its output', () => {
    expect(process.env['CCFIND_NO_MODEL']).toBe('1');
    expect(process.env['NO_COLOR']).toBe('1');
    expect(process.env['CCFIND_DEBUG']).toBeUndefined();
  });

  it('resolves the app home to the temp directory, not to ~/.ccfind', async () => {
    const { resolveAppHome } = await import('../src/core/paths.js');
    expect(resolveAppHome()).toBe(path.resolve(process.env['CCFIND_HOME'] as string));
    expect(resolveAppHome().startsWith(realAppHome(os.homedir()))).toBe(false);
  });
});

describe('childEnv', () => {
  it('scrubs every inherited variable that could redirect a child', () => {
    const previous = { ...process.env };
    try {
      for (const key of SCRUBBED_ENV) process.env[key] = POISON_HOME;
      const env = childEnv({ CCFIND_HOME: '/tmp/explicit-home' });
      expect(env['CCFIND_HOME']).toBe('/tmp/explicit-home');
      expect(env['SESSION_FINDER_HOME']).toBeUndefined();
      expect(env['CCFIND_DEBUG']).toBeUndefined();
      expect(env['SHELL']).toBeUndefined();
      expect(env['CLAUDE_CONFIG_DIR']).not.toBe(POISON_HOME);
      expect(env['NO_COLOR']).toBe('1');
      expect(env['CCFIND_NO_MODEL']).toBe('1');
    } finally {
      process.env = previous;
    }
  });

  it('lets a caller unset a variable outright', () => {
    expect(childEnv({ CCFIND_HOME: '/tmp/x', NO_COLOR: undefined })['NO_COLOR']).toBeUndefined();
  });
});

describe('a child process of a test', () => {
  it('indexes into the home it was given, even with a poisoned one inherited', () => {
    const appHome = tempDir('sf-hermetic-home-');
    const projects = tempDir('sf-hermetic-projects-');
    writeSession(projects, '-tmp-herm', 'herm', [
      userMessage('a session about recording videos', { cwd: '/tmp/herm' }),
    ]);

    const previous = process.env['CCFIND_HOME'];
    let result;
    try {
      // Exactly what `CCFIND_HOME=... npx vitest run` used to do to us.
      process.env['CCFIND_HOME'] = POISON_HOME;
      result = spawnSync(process.execPath, [cliPath, '--reindex', '--projects-dir', projects], {
        encoding: 'utf8',
        env: childEnv({ CCFIND_HOME: appHome }),
      });
    } finally {
      if (previous === undefined) delete process.env['CCFIND_HOME'];
      else process.env['CCFIND_HOME'] = previous;
    }

    expect([result.status, result.stderr]).toEqual([0, result.stderr]);
    expect(fs.existsSync(path.join(appHome, 'index.db'))).toBe(true);
    expect(fs.existsSync(POISON_HOME)).toBe(false);
  });
});

describe('the guard on the real app home', () => {
  it('says nothing when the directory does not exist', () => {
    const missing = path.join(tempDir('sf-guard-'), 'never-created');
    expect(statSnapshot(missing)).toBeNull();
    expect(snapshotDifferences(statSnapshot(missing), statSnapshot(missing))).toEqual([]);
  });

  it('notices a file added, changed or removed under it', () => {
    const dir = tempDir('sf-guard-app-');
    fs.writeFileSync(path.join(dir, 'index.db'), 'one');
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    const before = statSnapshot(dir);

    fs.writeFileSync(path.join(dir, 'web.json'), '{}');
    expect(snapshotDifferences(before, statSnapshot(dir))).toEqual(['added: web.json']);

    fs.rmSync(path.join(dir, 'web.json'));
    fs.writeFileSync(path.join(dir, 'index.db'), 'one and a bit more');
    expect(snapshotDifferences(before, statSnapshot(dir))).toEqual(['changed: index.db']);

    fs.rmSync(path.join(dir, 'index.db'));
    expect(snapshotDifferences(before, statSnapshot(dir))).toEqual(['removed: index.db']);
  });

  it('notices a run that creates the directory from nothing', () => {
    const dir = path.join(tempDir('sf-guard-new-'), '.ccfind');
    const before = statSnapshot(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.db'), 'x');
    expect(snapshotDifferences(before, statSnapshot(dir))).toEqual([
      'the directory did not exist before the run and does now',
    ]);
  });

  it('points at the real ~/.ccfind, which is what the run is guarding', () => {
    expect(realAppHome('/Users/someone')).toBe(path.join('/Users/someone', '.ccfind'));
  });
});
