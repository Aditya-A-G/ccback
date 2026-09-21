/**
 * The last line of defence: no test run may write to the user's real `~/.ccfind`.
 *
 * Two agents damaged a real index by inheriting `CCFIND_HOME` from the shell
 * they were started in, so the suite no longer trusts any of its own callers to
 * get that right. The whole directory is stat-ed before the run and after it,
 * and any difference at all fails the run — after the fact, but loudly, and
 * with the paths that changed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Carries the per-run temp directory from the global setup to every worker. */
export const RUN_HOME_ENV = 'CCFIND_TEST_RUN_HOME';

/** The directory the tool owns under a real home. Never written to by tests. */
export function realAppHome(home: string = os.homedir()): string {
  return path.join(home, '.ccfind');
}

/** Size and mtime of every file under `dir`, or null when it is not there. */
export function statSnapshot(dir: string): Record<string, string> | null {
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  const walk = (current: string, relative: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      out[`${relative}/`] = 'unreadable';
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const key = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        out[`${key}/`] = 'dir';
        walk(full, key);
        continue;
      }
      try {
        const stat = fs.lstatSync(full);
        out[key] = `${stat.size}:${stat.mtimeMs}`;
      } catch {
        out[key] = 'gone';
      }
    }
  };
  walk(dir, '');
  return out;
}

/**
 * What changed between two snapshots, as lines a person can act on.
 *
 * `null` on both sides means the directory does not exist here, which is the
 * normal case on a machine that never ran the tool: nothing to guard, so the
 * check passes. `null` before and something after means the run created it,
 * which is exactly the accident this exists to catch.
 */
export function snapshotDifferences(
  before: Record<string, string> | null,
  after: Record<string, string> | null,
): string[] {
  if (before === null && after === null) return [];
  if (before === null) return [`the directory did not exist before the run and does now`];
  if (after === null) return [`the directory existed before the run and is gone`];
  const differences: string[] = [];
  for (const key of Object.keys(before)) {
    if (!(key in after)) differences.push(`removed: ${key}`);
    else if (after[key] !== before[key]) differences.push(`changed: ${key}`);
  }
  for (const key of Object.keys(after)) {
    if (!(key in before)) differences.push(`added: ${key}`);
  }
  return differences.sort();
}
