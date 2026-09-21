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

/** The name this tool shipped under before, still honoured so older setups keep working. */
export const LEGACY_APP_HOME_ENV = 'SESSION_FINDER_HOME';

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
 * Overridable with `CCFIND_HOME` (used by every test). The tool's former name
 * is still honoured silently so an existing `SESSION_FINDER_HOME` keeps
 * working; nothing is ever migrated automatically.
 */
export function resolveAppHome(override?: string | undefined): string {
  if (override && override.length > 0) return path.resolve(expandHome(override));
  for (const key of [APP_HOME_ENV, LEGACY_APP_HOME_ENV]) {
    const fromEnv = process.env[key];
    if (fromEnv && fromEnv.length > 0) return path.resolve(expandHome(fromEnv));
  }
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
