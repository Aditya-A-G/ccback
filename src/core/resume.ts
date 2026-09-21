import { spawn as nodeSpawn } from 'node:child_process';
import { UserError } from './errors.js';
import { isValidSessionId } from './session-id.js';
import { whichSync } from './which.js';

/**
 * POSIX single-quote escaping. `it's here` becomes `'it'\''s here'`, which is
 * safe for paths containing spaces, quotes and anything else a shell would eat.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `cd '<cwd>' && claude --resume '<sessionId>'`.
 *
 * The id is validated *and* quoted. Validation alone would be enough today
 * (the indexer refuses anything else), and quoting alone would be enough for a
 * shell, so an injection needs both layers to fail at once.
 */
export function buildResumeCommand(cwd: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new UserError(`Refusing to build a resume command for an unsafe session id: ${JSON.stringify(sessionId)}`);
  }
  return `cd ${shellQuote(cwd)} && claude --resume ${shellQuote(sessionId)}`;
}

export interface SpawnResumeOptions {
  cwd: string;
  sessionId: string;
  /** Binary to run. Defaults to `claude`. */
  command?: string | undefined;
  /** Injected in tests so nothing ever launches a real `claude`. */
  spawn?: typeof nodeSpawn | undefined;
  /** Injected in tests: which platform's rules to follow. */
  platform?: NodeJS.Platform | undefined;
  /** Injected in tests: how `command` is found on PATH. */
  which?: ((name: string) => string | null) | undefined;
}

/**
 * Runs `claude --resume <id>` in the session's folder with inherited stdio and
 * resolves with its exit code. Used by the CLI and by the TUI after it has
 * unmounted and restored the terminal.
 *
 * The arguments are an argv array and `shell` is never set, so a session id
 * could not be interpreted by a shell even if one slipped past validation.
 */
export function spawnResume(options: SpawnResumeOptions): Promise<number> {
  const command = options.command ?? 'claude';
  if (!isValidSessionId(options.sessionId)) {
    return Promise.reject(
      new UserError(`Refusing to resume an unsafe session id: ${JSON.stringify(options.sessionId)}`),
    );
  }
  const spawnFn = options.spawn ?? nodeSpawn;
  const platform = options.platform ?? process.platform;
  const lookup = options.which ?? ((name: string) => whichSync(name, { platform }));

  // On Windows `claude` is a `claude.cmd` shim, and since the 2024 security fix
  // Node refuses to spawn a .cmd or .bat at all unless a shell is asked for —
  // the check is on the extension, so an absolute path does not help. That one
  // case therefore runs through cmd.exe, and nothing user-supplied goes into
  // the command line: the working directory travels as a spawn option, and the
  // session id is validated against a strict pattern above and passed as an
  // argument. Everywhere else there is no shell at all.
  const executable = platform === 'win32' ? (lookup(command) ?? command) : command;
  const isBatchShim = platform === 'win32' && /\.(cmd|bat)$/i.test(executable);

  return new Promise((resolve, reject) => {
    const child = spawnFn(
      // Quoted for a path containing spaces; a Windows path cannot contain `"`.
      isBatchShim ? `"${executable}"` : executable,
      ['--resume', options.sessionId],
      {
        cwd: options.cwd,
        stdio: 'inherit',
        ...(isBatchShim ? { shell: true } : {}),
      },
    );
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
}
