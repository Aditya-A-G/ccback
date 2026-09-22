/**
 * The suite's own safety net.
 *
 * A test run must never read or write the app home a person actually uses. One
 * `CCBACK_HOME` exported in the shell that starts the suite is enough to point
 * every child at a real index, so nothing is left to inheritance: the run sets
 * its own home before any test module loads, every spawned child is given one
 * explicitly, and the real app home is stat-ed before and after the run.
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
const POISON_HOME = '/nonexistent-ccback-home-that-must-never-be-used';

describe('the environment every test runs in', () => {
  it('points HOME and CCBACK_HOME at a temp directory, never at the real one', () => {
    const appHome = process.env['CCBACK_HOME'];
    const home = process.env['HOME'] ?? process.env['USERPROFILE'];
    expect(appHome, 'CCBACK_HOME must be set by the vitest setup file').toBeTruthy();
    expect(home, 'HOME must be set by the vitest setup file').toBeTruthy();
    const temp = fs.realpathSync(os.tmpdir());
    expect(fs.realpathSync(appHome as string).startsWith(temp)).toBe(true);
    expect(fs.realpathSync(home as string).startsWith(temp)).toBe(true);
    // And whatever the caller exported is gone: this is the exact failure that
    // let `CCBACK_HOME=/somewhere npx vitest run` write outside the temp tree.
    expect(appHome).not.toBe(POISON_HOME);
    expect(appHome).not.toBe('/tmp/should-not-be-used');
  });

  it('never loads the embedding model and never colours its output', () => {
    expect(process.env['CCBACK_NO_MODEL']).toBe('1');
    expect(process.env['NO_COLOR']).toBe('1');
    expect(process.env['CCBACK_DEBUG']).toBeUndefined();
  });

  it('resolves the app home to the temp directory, not to ~/.ccback', async () => {
    const { resolveAppHome } = await import('../src/core/paths.js');
    expect(resolveAppHome()).toBe(path.resolve(process.env['CCBACK_HOME'] as string));
    expect(resolveAppHome().startsWith(realAppHome(os.homedir()))).toBe(false);
  });
});

describe('childEnv', () => {
  it('scrubs every inherited variable that could redirect a child', () => {
    const previous = { ...process.env };
    try {
      for (const key of SCRUBBED_ENV) process.env[key] = POISON_HOME;
      const env = childEnv({ CCBACK_HOME: '/tmp/explicit-home' });
      expect(env['CCBACK_HOME']).toBe('/tmp/explicit-home');
      expect(env['CCBACK_DEBUG']).toBeUndefined();
      expect(env['SHELL']).toBeUndefined();
      expect(env['CLAUDE_CONFIG_DIR']).not.toBe(POISON_HOME);
      expect(env['NO_COLOR']).toBe('1');
      expect(env['CCBACK_NO_MODEL']).toBe('1');
    } finally {
      process.env = previous;
    }
  });

  it('lets a caller unset a variable outright', () => {
    expect(childEnv({ CCBACK_HOME: '/tmp/x', NO_COLOR: undefined })['NO_COLOR']).toBeUndefined();
  });
});

describe('a child process of a test', () => {
  it('indexes into the home it was given, even with a poisoned one inherited', () => {
    const appHome = tempDir('ccback-hermetic-home-');
    const projects = tempDir('ccback-hermetic-projects-');
    writeSession(projects, '-tmp-herm', 'herm', [
      userMessage('a session about recording videos', { cwd: '/tmp/herm' }),
    ]);

    const previous = process.env['CCBACK_HOME'];
    let result;
    try {
      // Exactly what an exported `CCBACK_HOME` does to a test run.
      process.env['CCBACK_HOME'] = POISON_HOME;
      result = spawnSync(process.execPath, [cliPath, '--reindex', '--projects-dir', projects], {
        encoding: 'utf8',
        env: childEnv({ CCBACK_HOME: appHome }),
      });
    } finally {
      if (previous === undefined) delete process.env['CCBACK_HOME'];
      else process.env['CCBACK_HOME'] = previous;
    }

    expect([result.status, result.stderr]).toEqual([0, result.stderr]);
    expect(fs.existsSync(path.join(appHome, 'index.db'))).toBe(true);
    expect(fs.existsSync(POISON_HOME)).toBe(false);
  });
});

describe('the guard on the real app home', () => {
  it('says nothing when the directory does not exist', () => {
    const missing = path.join(tempDir('ccback-guard-'), 'never-created');
    expect(statSnapshot(missing)).toBeNull();
    expect(snapshotDifferences(statSnapshot(missing), statSnapshot(missing))).toEqual([]);
  });

  it('notices a file added, changed or removed under it', () => {
    const dir = tempDir('ccback-guard-app-');
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
    const dir = path.join(tempDir('ccback-guard-new-'), '.ccback');
    const before = statSnapshot(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.db'), 'x');
    expect(snapshotDifferences(before, statSnapshot(dir))).toEqual([
      'the directory did not exist before the run and does now',
    ]);
  });

  it('points at the real ~/.ccback, which is what the run is guarding', () => {
    expect(realAppHome('/Users/someone')).toBe(path.join('/Users/someone', '.ccback'));
  });
});
