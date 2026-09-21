/**
 * Runs once, before any worker starts, and once after the last one finishes.
 *
 * Before: a temp directory for the whole run, handed to every worker through
 * the environment, plus a stat snapshot of the real `~/.ccfind`.
 * After: the snapshot again. Any difference fails the run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUN_HOME_ENV, realAppHome, snapshotDifferences, statSnapshot } from './real-home-guard.js';

export default function setup(): () => void {
  // Resolved before anything here touches HOME, so it really is the user's own.
  const guarded = realAppHome();
  const before = statSnapshot(guarded);

  const runHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfind-test-run-'));
  // Workers are forked after this returns, so they inherit it.
  process.env[RUN_HOME_ENV] = runHome;

  return () => {
    const after = statSnapshot(guarded);
    fs.rmSync(runHome, { recursive: true, force: true });
    const differences = snapshotDifferences(before, after);
    if (differences.length > 0) {
      throw new Error(
        `A test wrote to the real app home ${guarded}. No test may ever touch it.\n` +
          differences.slice(0, 10).join('\n'),
      );
    }
  };
}
