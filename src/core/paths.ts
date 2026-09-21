import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The single place the product name lives. Renaming the tool means changing
 * this constant plus `name`/`bin` in package.json.
 */
export const APP_NAME = 'ccfind';

/** Environment variable that relocates {@link resolveAppHome}. */
export const APP_HOME_ENV = 'CCFIND_HOME';

/**
 * Directory that holds the Claude Code transcripts.
 *
 * Resolution order: explicit override, then `$CLAUDE_CONFIG_DIR/projects`,
 * then `~/.claude/projects`.
 */
export function resolveProjectsDir(override?: string | undefined): string {
  if (override && override.length > 0) return path.resolve(expandHome(override));
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  if (configDir && configDir.length > 0) {
    return path.resolve(expandHome(configDir), 'projects');
  }
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Directory this tool owns: index database, model cache and the running-server
 * marker.
 *
 * An explicit argument wins, then `CCFIND_HOME`, then `~/.ccfind`. A leading
 * `~` is expanded, so the variable can be set the way a shell writes it.
 */
export function resolveAppHome(override?: string | undefined): string {
  if (override && override.length > 0) return path.resolve(expandHome(override));
  const fromEnv = process.env[APP_HOME_ENV];
  if (fromEnv && fromEnv.length > 0) return path.resolve(expandHome(fromEnv));
  return path.join(os.homedir(), `.${APP_NAME}`);
}

/** Path to the SQLite index. */
export function resolveIndexPath(appHome?: string | undefined): string {
  return path.join(resolveAppHome(appHome), 'index.db');
}

/** True when the transcript directory exists on disk. */
export function projectsDirExists(projectsDir: string): boolean {
  try {
    return fs.statSync(projectsDir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Said the same way everywhere: a missing transcript directory is a setup
 * problem with two knobs, never an empty history.
 */
export function missingProjectsDirMessage(projectsDir: string): string {
  return (
    `No Claude Code transcripts found at ${projectsDir}. ` +
    `Point ${APP_NAME} at them with --projects-dir <path>, or set CLAUDE_CONFIG_DIR.`
  );
}

/** What every front end says when the directory exists but holds nothing yet. */
export const NO_SESSIONS_YET = 'No sessions yet';

/** Directory transformers.js caches downloaded models in. */
export function resolveModelCacheDir(appHome?: string | undefined): string {
  return path.join(resolveAppHome(appHome), 'models');
}

/** Marker file describing the web server that is currently running, if any. */
export function resolveWebInstancePath(appHome?: string | undefined): string {
  return path.join(resolveAppHome(appHome), 'web.json');
}

/** Symlinks resolved where possible, so `/tmp/x` and `/private/tmp/x` compare equal. */
export function canonicalDir(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Two spellings of one folder are the same folder: a symlinked `~/.claude`, or
 * different letter case on a case-insensitive disk. Identity is decided by
 * device and inode; text comparison is only the fallback when one side is gone.
 *
 * The one place this question is answered: the indexer refuses to sync an index
 * against a different folder with it, and `projectsDirMismatch` decides whether
 * a front end has anything to warn about with it.
 */
export function sameDirectory(a: string, b: string): boolean {
  const left = canonicalDir(a);
  const right = canonicalDir(b);
  if (left === right) return true;
  try {
    const sa = fs.statSync(left);
    const sb = fs.statSync(right);
    return sa.ino === sb.ino && sa.dev === sb.dev && sa.ino !== 0;
  } catch {
    return false;
  }
}

/** `/Users/me/x` -> `~/x`, on every platform. Home prefixes are noise in a list. */
export function shortenHomePath(p: string, home: string = os.homedir()): string {
  if (p === '' || home === '') return p;
  const sameCase = process.platform === 'win32' ? p.toLowerCase().startsWith(home.toLowerCase()) : p.startsWith(home);
  if (!sameCase) return p;
  const rest = p.slice(home.length);
  if (rest === '') return '~';
  if (rest.startsWith('/') || rest.startsWith('\\')) return `~${rest}`;
  return p;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
