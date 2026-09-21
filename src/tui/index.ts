/**
 * Public entry point of the terminal UI.
 *
 * ```ts
 * import { runTui } from './tui/index.js';
 * process.exit(await runTui({ ...common, query, openTranscript }));
 * ```
 *
 * `runTui` owns the whole interactive lifetime: it renders the Ink app, waits
 * for it to unmount, restores the terminal, and only then spawns
 * `claude --resume <id>` so the child gets a clean terminal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { isUserError, sanitizeLine } from '../core/index.js';
import { App, errorText, type Outcome } from './app.js';
import { defaultDeps, type TuiDeps, type TuiOptions, type TuiRenderInstance } from './deps.js';

export type { Outcome } from './app.js';
export type {
  MatchSnippet,
  SemanticStatus,
  SortOrder,
  TuiDeps,
  TuiOptions,
  TuiRenderInstance,
  TuiSearchMode,
} from './deps.js';
export { defaultDeps, DEFAULT_DEBOUNCE_MS } from './deps.js';
export { copyToClipboard } from './clipboard.js';

export interface RunTuiOptions extends TuiOptions {
  /**
   * Starts the web server if needed and returns the URL of the transcript page
   * for that session; injected by cli.ts. Undefined hides the browser action.
   */
  openTranscript?: (sessionId: string, messageId?: number) => Promise<string>;
  /** Overrides for testing. Production passes nothing and gets real behaviour. */
  deps?: Partial<TuiDeps>;
}

/** Runs the TUI and resolves with the process exit code. */
export async function runTui(opts: RunTuiOptions): Promise<number> {
  const deps: TuiDeps = { ...defaultDeps(), ...opts.deps };
  const state: { outcome: Outcome } = { outcome: { kind: 'quit' } };
  let instance: TuiRenderInstance | undefined;

  // Opening the index can fail in a way the user must fix (a corrupt file, an
  // index from a newer build). Say it in one line before taking over the
  // terminal, rather than inside a half-drawn UI.
  try {
    await deps.status({ projectsDir: opts.projectsDir });
  } catch (err) {
    if (isUserError(err)) {
      deps.writeErr(`${sanitizeLine(err.message)}\n`);
      return 2;
    }
  }

  try {
    instance = deps.render(
      createElement(App, {
        options: opts,
        deps,
        openTranscript: opts.openTranscript,
        onOutcome: (outcome: Outcome) => {
          state.outcome = outcome;
        },
      }),
    );
    await instance.waitUntilExit();
  } catch (err) {
    unmountQuietly(instance);
    deps.restoreStdin();
    deps.writeErr(`${errorText(err)}\n`);
    return 1;
  }

  // The terminal is ours again from here on.
  unmountQuietly(instance);
  deps.restoreStdin();

  const outcome = state.outcome;
  if (outcome.kind !== 'resume') {
    if (outcome.printCommand !== undefined) deps.writeOut(`${outcome.printCommand}\n`);
    return 0;
  }

  // The folder is checked again here, right before spawning: the index may be
  // minutes old, and a transcript could have claimed a relative path. `claude`
  // must never start in whatever directory the user happened to launch from.
  if (!isSafeSpawnCwd(outcome.cwd)) {
    deps.writeErr(
      `Not resuming: ${sanitizeLine(outcome.cwd)} is not an existing folder. ` +
        `Run this once it is back: ${sanitizeLine(outcome.resumeCommand)}\n`,
    );
    return 2;
  }

  try {
    // `claude` may own the terminal for hours; do not hold the index open.
    deps.closeIndex();
  } catch {
    /* nothing useful to do if the handle was already gone */
  }

  try {
    return await deps.spawnResume({ cwd: outcome.cwd, sessionId: outcome.sessionId });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // ENOENT is spawn's answer to two different questions: no `claude`, and
      // no working directory. The folder was there a moment ago, so ask again
      // rather than blaming the PATH for a folder that has just been deleted.
      if (!isSafeSpawnCwd(outcome.cwd)) {
        deps.writeErr(
          `Not resuming: ${sanitizeLine(outcome.cwd)} no longer exists. ` +
            `Run this once it is back: ${sanitizeLine(outcome.resumeCommand)}\n`,
        );
        return 2;
      }
      deps.writeErr(`claude is not on your PATH. Run this instead:\n  ${outcome.resumeCommand}\n`);
      return 2;
    }
    deps.writeErr(`${errorText(err)}\n`);
    return 1;
  }
}

/** Absolute, and a directory that exists right now. */
export function isSafeSpawnCwd(cwd: string): boolean {
  if (cwd === '' || !path.isAbsolute(cwd)) return false;
  try {
    return fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

function unmountQuietly(instance: TuiRenderInstance | undefined): void {
  try {
    instance?.unmount();
  } catch {
    /* already unmounted */
  }
}
