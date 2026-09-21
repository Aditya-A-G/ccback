#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_ALIAS } from './core/alias.js';
import {
  APP_NAME,
  closeSharedDatabases,
  DEFAULT_MODEL_ID,
  enableSemantic,
  indexedProjectsDir,
  INSTALL_HINT,
  isModelReady,
  isTransformersAvailable,
  isUserError,
  matchCountLabel,
  NO_SESSIONS_YET,
  recentSessions,
  resolveModelCacheDir,
  resolveProjectsDir,
  sanitizeLine,
  search,
  semanticStatus,
  SIGINT_EXIT_CODE,
  status,
  sync,
  topUpEmbeddings,
  UserError,
  withInterrupt,
} from './core/index.js';
import type { SearchMode, SessionResult, SortOrder } from './core/index.js';

// The TUI and web front ends are imported lazily so `--json` never pays for
// Ink or the server.

/** Options every command understands. The TUI and web entry points take the same shape. */
export interface CommonOptions {
  mode: SearchMode;
  sort: SortOrder;
  limit: number;
  cwdPrefix?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  role?: 'user' | 'assistant' | undefined;
  projectsDir?: string | undefined;
  noSync: boolean;
  json: boolean;
}

/** What `runTui(opts)` receives. */
export interface TuiOptions extends CommonOptions {
  query: string;
}

/** What `runWeb(opts)` receives. */
export interface WebOptions extends CommonOptions {
  /** Words typed alongside `--web`; they become the page's initial query. */
  query: string;
  port: number;
  open: boolean;
}

/** Default port for the browser UI. */
export const DEFAULT_PORT = 4777;

export const HELP = `${APP_NAME} — find any Claude Code session by what was said in it

  ${APP_NAME} recording videos        search, then Enter to resume the session
  ${APP_NAME} -w recording videos     the same search, in your browser
  ${APP_NAME} -p invoices --json      plain results, for scripts and pipes

Usage
  ${APP_NAME} [words...]     words are always the search; a word that is not a
                             known flag stays a word, and everything after --
                             is search text

Options
  -w, --web              open the browser UI (reuses one that is already running)
  -p, --print            plain results instead of the picker (automatic when piped)
      --json             machine-readable results
      --sort recent      order by last activity instead of best match
      --stats            what the index holds, and where
      --reindex [--full] update the index now; --full rebuilds it from scratch
      --keyword-only     skip smart search for this run
      --alias [name]     offer to add a short command (default ${DEFAULT_ALIAS}) to your shell
      --yes              with --alias: skip the question, still run every check
      --limit N          how many results (default 10)
      --cwd <path>       only sessions in this folder or under it
      --since <date> --until <date>    ISO date or datetime
      --role user|assistant
      --projects-dir <path>   default $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects
      --port N  --no-open     browser UI: port (default ${DEFAULT_PORT}), and don't open a tab
      --no-sync          skip the incremental index update
  -h, --help    -v, --version
`;

/**
 * Every flag the tool understands, and whether it takes a value.
 *
 * This is the single source of truth for the grammar: the tokeniser uses it to
 * tell a flag from a query word, and `parseArgs` validates what is left.
 */
export const OPTION_TYPES: Record<string, 'string' | 'boolean'> = {
  // Hidden from the help: the modes exist for debugging a ranking question,
  // not for anybody to have to choose between.
  mode: 'string',
  'keyword-only': 'boolean',
  sort: 'string',
  limit: 'string',
  cwd: 'string',
  since: 'string',
  until: 'string',
  role: 'string',
  'projects-dir': 'string',
  'no-sync': 'boolean',
  json: 'boolean',
  print: 'boolean',
  web: 'boolean',
  stats: 'boolean',
  reindex: 'boolean',
  full: 'boolean',
  // `--alias` on its own means the default name, so the value is optional.
  alias: 'string',
  yes: 'boolean',
  port: 'string',
  'no-open': 'boolean',
  help: 'boolean',
  version: 'boolean',
};

/** Single-letter forms. All of them are switches, so none takes a value. */
export const SHORT_FLAGS: Record<string, string> = {
  p: 'print',
  w: 'web',
  h: 'help',
  v: 'version',
};

const PARSE_OPTIONS = {
  mode: { type: 'string' },
  'keyword-only': { type: 'boolean', default: false },
  sort: { type: 'string' },
  limit: { type: 'string' },
  cwd: { type: 'string' },
  since: { type: 'string' },
  until: { type: 'string' },
  role: { type: 'string' },
  'projects-dir': { type: 'string' },
  'no-sync': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  print: { type: 'boolean', short: 'p', default: false },
  web: { type: 'boolean', short: 'w', default: false },
  stats: { type: 'boolean', default: false },
  reindex: { type: 'boolean', default: false },
  full: { type: 'boolean', default: false },
  alias: { type: 'string' },
  yes: { type: 'boolean', default: false },
  port: { type: 'string' },
  'no-open': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

/** Index of the `--` terminator, or -1. Everything after it is query text. */
function terminatorAt(argv: string[]): number {
  return argv.indexOf('--');
}

/**
 * `--alias` takes an optional name, which `parseArgs` cannot express: a bare
 * `--alias` (or one followed by another flag) gets the default name here.
 *
 * Only the part of the command line before `--` is touched: after it, every
 * token is query text and must survive untouched.
 */
export function withAliasDefault(argv: string[]): string[] {
  const end = terminatorAt(argv);
  const limit = end === -1 ? argv.length : end;
  const index = argv.indexOf('--alias');
  if (index === -1 || index >= limit) return [...argv];
  const out = [...argv];
  const next = index + 1 < limit ? out[index + 1] : undefined;
  if (next === undefined || next.startsWith('-')) out.splice(index + 1, 0, DEFAULT_ALIAS);
  return out;
}

/** A command line split into the flags to validate and the words to search for. */
export interface SplitArgv {
  flags: string[];
  words: string[];
}

/**
 * Splits a command line into flags and query words.
 *
 * A dashed token that is not a flag this tool knows is a *word*, not an error:
 * `ccfind -p -weird` searches for "-weird". Everything after `--` is always
 * query text. Known flags are handed to `parseArgs`, which still validates
 * them strictly, so `--sort bogus` is as loud as it ever was.
 */
export function splitArgv(argv: string[]): SplitArgv {
  const flags: string[] = [];
  const words: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === '--') {
      words.push(...argv.slice(i + 1));
      return { flags, words };
    }

    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const type = OPTION_TYPES[name];
      if (type === undefined) {
        words.push(token);
        continue;
      }
      flags.push(token);
      // A value belongs to its flag even when it looks like one: `--cwd -x`
      // asks for the folder named `-x`, and a missing value is parseArgs' job.
      if (type === 'string' && eq === -1 && i + 1 < argv.length && argv[i + 1] !== '--') {
        i += 1;
        flags.push(argv[i]!);
      }
      continue;
    }

    if (token.length > 1 && token.startsWith('-') && !token.startsWith('--')) {
      const letters = [...token.slice(1)];
      if (letters.every((letter) => SHORT_FLAGS[letter] !== undefined)) {
        flags.push(token);
        continue;
      }
      words.push(token);
      continue;
    }

    words.push(token);
  }

  return { flags, words };
}

async function main(rawArgv: string[]): Promise<number> {
  const { flags: flagArgs, words } = splitArgv(withAliasDefault(rawArgv));
  let parsed;
  try {
    parsed = parseArgs({
      args: flagArgs,
      allowPositionals: false,
      strict: true,
      options: PARSE_OPTIONS,
    });
  } catch (err) {
    throw new UserError(`${(err as Error).message} Run ${APP_NAME} --help to see the flags.`);
  }

  const flags = parsed.values;

  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (flags.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  // Every word is part of the query, so `ccfind web project` searches for
  // "web project" instead of running a subcommand nobody typed.
  const query = words.join(' ');

  const common: CommonOptions = {
    mode: parseMode(flags.mode, flags['keyword-only'] === true),
    sort: parseSort(flags.sort),
    limit: parseLimit(flags.limit),
    cwdPrefix: flags.cwd,
    since: flags.since,
    until: flags.until,
    role: parseRole(flags.role),
    projectsDir: flags['projects-dir'],
    noSync: flags['no-sync'] === true,
    json: flags.json === true,
  };

  const actions = (['web', 'stats', 'reindex'] as const).filter((name) => flags[name] === true);
  if (flags.alias !== undefined) actions.unshift('alias' as never);
  if (actions.length > 1) {
    throw new UserError(`--${actions[0]} and --${actions[1]} do different things; run one at a time.`);
  }

  // `--full` on its own reads like it should do something, and does not.
  if (flags.full === true && flags.reindex !== true) {
    throw new UserError(`--full only means something with --reindex. Run: ${APP_NAME} --reindex --full`);
  }

  if (flags.alias !== undefined) {
    // `--alias sf web` silently dropped "web" before; the name is one word.
    if (words.length > 0) {
      throw new UserError(
        `--alias takes one name, so "${words[0]}" is not part of it. Run: ${APP_NAME} --alias ${flags.alias}`,
      );
    }
    return runAliasCommand(flags.alias, flags.yes === true);
  }
  if (flags.stats) return runStats(common);
  if (flags.reindex) return runReindex(common, flags.full === true);
  if (flags.web) {
    const { runWeb } = await import('./web/index.js');
    return runWeb({ ...common, query, port: parsePort(flags.port), open: !flags['no-open'] });
  }

  // Plain output when asked for, and whenever this is not a terminal: piping
  // into `head` or a script must never try to draw a picker.
  const interactive =
    flags.print !== true && !common.json && Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
  if (!interactive) return runSearch(query, common);
  // The picker scrolls, so it reads more rows than a printed list — unless the
  // user said how many they want.
  return runInteractive(query, {
    ...common,
    limit: flags.limit === undefined ? PICKER_LIMIT : common.limit,
  });
}

/** Rows the picker fetches when `--limit` was not given. */
export const PICKER_LIMIT = 50;

/**
 * `--alias [name]`: offer the user a short command their machine has room for.
 * Every decision lives in the core; this only supplies the environment and the
 * question.
 */
async function runAliasCommand(name: string, assumeYes: boolean): Promise<number> {
  const { runAlias } = await import('./core/alias.js');
  return runAlias(name, {
    home: os.homedir(),
    shell: process.env['SHELL'],
    platform: process.platform,
    pathEntries: (process.env['PATH'] ?? '').split(path.delimiter),
    pathExt: (process.env['PATHEXT'] ?? '').split(path.delimiter).filter(Boolean),
    isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    assumeYes,
    prompt: async (question: string) => {
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    write: (text: string) => process.stdout.write(text),
  });
}

/** The slice of the web module the picker's ^O needs. Injected, so it is testable. */
export interface WebBridge {
  findRunningWeb: () => Promise<{ url: string } | null>;
  startWebServer: (options: {
    port: number;
    projectsDir?: string | undefined;
    autoEmbed?: boolean | undefined;
  }) => Promise<{ url: string; close: () => Promise<void> }>;
  transcriptUrl: (handle: { url: string }, sessionId: string, messageId?: number) => string;
  openInBrowser: (url: string) => boolean;
}

export interface TranscriptOpener {
  openTranscript: (sessionId: string, messageId?: number) => Promise<string>;
  /** Stops a server this process started. Safe to call when none was. */
  close: () => Promise<void>;
}

/**
 * ^O: reuse the browser UI if one is already up, otherwise start one, open it,
 * and hand the URL back for display.
 *
 * The *promise* is memoised, not the handle: `server ??= await start()` leaves
 * a window where a second ^O starts a second server, and the one that loses
 * the assignment is never closed — which is also why ccfind would then refuse
 * to exit. The picker's server never embeds either: the picker is already
 * embedding in this same process, and two jobs on one database is one too many.
 */
export function createTranscriptOpener(
  web: WebBridge,
  options: { port: number; projectsDir?: string | undefined },
): TranscriptOpener {
  let started: Promise<{ url: string; close: () => Promise<void> }> | undefined;

  const start = (): Promise<{ url: string; close: () => Promise<void> }> => {
    const attempt =
      started ??
      (started = web.startWebServer({
        port: options.port,
        projectsDir: options.projectsDir,
        autoEmbed: false,
      }));
    // A failed start must not be remembered, or every later ^O repeats it.
    attempt.catch(() => {
      if (started === attempt) started = undefined;
    });
    return attempt;
  };

  return {
    async openTranscript(sessionId: string, messageId?: number): Promise<string> {
      const base = started !== undefined ? await started : ((await web.findRunningWeb()) ?? (await start()));
      const url = web.transcriptUrl(base, sessionId, messageId);
      web.openInBrowser(url);
      return url;
    },
    async close(): Promise<void> {
      const pending = started;
      started = undefined;
      if (pending === undefined) return;
      try {
        await (await pending).close();
      } catch {
        /* it never came up; there is nothing to stop */
      }
    },
  };
}

/** How long cleanup gets before the process leaves anyway. */
export const EXIT_GRACE_MS = 500;

export interface FinishOptions {
  graceMs?: number | undefined;
  exit?: ((code: number) => void) | undefined;
  flush?: (() => Promise<void>) | undefined;
}

/**
 * Leaves the picker for the shell prompt, promptly.
 *
 * Quitting while the smart-search model is still loading used to hang: the load
 * is inside native code that no AbortSignal reaches, and its handles keep the
 * event loop alive for as long as it takes to download 23 MB. `--reindex`
 * already had a guaranteed exit for exactly this; the interactive path needs
 * the same one. It is safe here because `runTui` has already restored the
 * terminal and, on Enter, already waited for `claude` to finish — so this
 * cannot cut anything off, and the child's exit code is what gets propagated.
 */
export async function finishInteractive(
  code: number,
  cleanup: () => Promise<void>,
  options: FinishOptions = {},
): Promise<void> {
  await Promise.race([
    cleanup().catch(() => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.graceMs ?? EXIT_GRACE_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
  try {
    closeSharedDatabases();
  } catch {
    /* the handle was already gone */
  }
  await (options.flush ?? flushStdout)();
  (options.exit ?? ((value: number) => process.exit(value)))(code);
}

/** Waits for stdout to drain, briefly: a TTY write is not synchronous on Windows. */
function flushStdout(timeoutMs = 200): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => {
      process.stdout.write('', () => resolve());
    }),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

async function runInteractive(query: string, common: CommonOptions): Promise<number> {
  const { runTui } = await import('./tui/index.js');
  const web = await import('./web/index.js');
  const opener = createTranscriptOpener(web, { port: DEFAULT_PORT, projectsDir: common.projectsDir });
  const code = await runTui({ ...common, query, openTranscript: opener.openTranscript });
  await finishInteractive(code, opener.close);
  return code;
}

/**
 * `--no-sync --projects-dir <somewhere else>`: the index is not going to be
 * brought in line with that folder, so the results are about the folder it was
 * built from. Silently answering with somebody else's sessions is the kind of
 * thing that gets noticed three commands later, so it is one line on stderr —
 * stdout stays exactly what a pipeline expects.
 */
function warnProjectsDirMismatch(common: CommonOptions): void {
  if (common.projectsDir === undefined) return;
  const recorded = indexedProjectsDir();
  if (recorded === null) return;
  const asked = resolveProjectsDir(common.projectsDir);
  if (sameFolder(recorded, asked)) return;
  process.stderr.write(
    `--no-sync: this index was built from ${sanitizeLine(recorded)}, so these results are from there, ` +
      `not from ${sanitizeLine(asked)}.\n`,
  );
}

/**
 * Two spellings of one folder are one folder: a symlinked `~/.claude`, or a
 * different letter case on a case-insensitive disk.
 *
 * The indexer answers the same question for its own refusal, but does not
 * export it, so this is the same rule written out: canonical real paths first,
 * then device and inode.
 */
function sameFolder(a: string, b: string): boolean {
  const canonical = (p: string): string => {
    const resolved = path.resolve(p);
    try {
      return fs.realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  const left = canonical(a);
  const right = canonical(b);
  if (left === right) return true;
  try {
    const sa = fs.statSync(left);
    const sb = fs.statSync(right);
    return sa.ino === sb.ino && sa.dev === sb.dev && sa.ino !== 0;
  } catch {
    return false;
  }
}

async function maybeSync(common: CommonOptions): Promise<void> {
  if (common.noSync) {
    warnProjectsDirMismatch(common);
    return;
  }
  const result = await sync({ projectsDir: common.projectsDir });
  if (result.indexedFiles > 0 || result.removedFiles > 0) {
    process.stderr.write(
      `Indexed ${result.indexedFiles} session${result.indexedFiles === 1 ? '' : 's'}` +
        `${result.removedFiles > 0 ? `, removed ${result.removedFiles}` : ''}` +
        ` in ${(result.durationMs / 1000).toFixed(1)}s\n`,
    );
  }
  reportFailures(result.failedFiles);
}

/** Unreadable files are worth a line, and they are retried next run. */
function reportFailures(failedFiles: number): void {
  if (failedFiles > 0) {
    const one = failedFiles === 1;
    process.stderr.write(
      `Could not read ${failedFiles} transcript file${one ? '' : 's'}; ` +
        `${one ? 'it was' : 'they were'} left out and will be retried on the next run.\n`,
    );
  }
}

/**
 * What a scripted run may do about smart search.
 *
 * `-p` and `--json` end up in pipelines and CI, where a 23 MB download nobody
 * asked for is never the right answer. So `auto` only stays `auto` when the
 * model is already on disk; otherwise it silently becomes keyword, and
 * `modeUsed` on each result says so. Asking for `semantic` or `hybrid`
 * explicitly is a different thing: that gets a one-line error.
 */
export function nonInteractiveMode(mode: SearchMode, cacheDir: string = resolveModelCacheDir()): SearchMode {
  if (mode === 'keyword') return mode;
  const ready = isTransformersAvailable() && isModelReady(cacheDir, DEFAULT_MODEL_ID);
  if (mode === 'auto') return ready ? 'auto' : 'keyword';
  if (!isTransformersAvailable()) throw new UserError(INSTALL_HINT);
  if (!ready) {
    throw new UserError(
      `--mode ${mode} needs the smart-search model, which is not on this machine yet. ` +
        `Run ${APP_NAME} --reindex once to set it up.`,
    );
  }
  return mode;
}

async function runSearch(query: string, common: CommonOptions): Promise<number> {
  const mode = nonInteractiveMode(common.mode);
  await maybeSync(common);
  const hasQuery = query.trim() !== '';

  const results = hasQuery
    ? await search({
        query,
        mode,
        // Nothing here may reach the network: the model is loaded from the
        // local cache or not at all.
        localOnly: true,
        sort: common.sort,
        limit: common.limit,
        cwdPrefix: common.cwdPrefix,
        since: common.since,
        until: common.until,
        role: common.role,
      })
    : recentSessions({ limit: common.limit, cwdPrefix: common.cwdPrefix });

  if (common.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }

  if (results.length === 0) {
    // An empty index and a query that found nothing are different situations.
    const indexEmpty = recentSessions({ limit: 1 }).length === 0;
    process.stdout.write(indexEmpty ? `${NO_SESSIONS_YET}\n` : 'No matching sessions.\n');
    return 0;
  }

  process.stdout.write(results.map((r, i) => formatResult(r, i + 1, hasQuery)).join('\n') + '\n');
  return 0;
}

/**
 * `--reindex`: bring the index up to date now, and embed whatever is new when
 * smart search is already on. `--full` starts from an empty database, which
 * costs every embedding, so they are rebuilt straight away.
 *
 * This is the one *scripted* path that may set smart search up from scratch,
 * model download and all: the user asked for indexing, explicitly, and can stop
 * it with Ctrl+C. `--keyword-only --reindex` skips it entirely. The picker and
 * the browser UI also download it, in the background, where somebody is
 * watching a screen; a plain `-p`/`--json` search never does.
 */
async function runReindex(common: CommonOptions, full: boolean): Promise<number> {
  const wasEnabled = full ? semanticStatus().enabled : false;
  const result = await sync({ projectsDir: common.projectsDir, rebuild: full });
  process.stdout.write(
    `Indexed ${result.indexedFiles} of ${result.scannedFiles} session files ` +
      `(${result.skippedFiles} unchanged, ${result.removedFiles} removed, ${result.skippedSessions} skipped) ` +
      `in ${(result.durationMs / 1000).toFixed(1)}s\n` +
      `${result.sessions} sessions, ${result.messages} messages, ${result.chunks} chunks\n`,
  );
  reportFailures(result.failedFiles);

  const state = semanticStatus();
  // `--reindex` is the explicit, interactive-by-nature command, so it is also
  // the one place on the command line where smart search may start from
  // nothing. A plain search never does that, and `--keyword-only` opts out.
  const wanted = common.mode !== 'keyword';
  if (!state.runtimeInstalled || !wanted) return 0;
  if (state.pendingChunks === 0) return 0;
  const buildAll = wasEnabled || !state.enabled;

  const started = Date.now();
  // Ctrl+C must land even while the model is still loading or downloading,
  // which is where no AbortSignal is being polled.
  const outcome = await withInterrupt(
    (signal) => {
      const options = {
        signal,
        onProgress: ({ phase, done, total }: { phase: string; done?: number; total?: number }) => {
          if (phase === 'model') {
            process.stderr.write('Loading the smart-search model…\n');
            return;
          }
          if (done === undefined) return;
          if (process.stderr.isTTY) process.stderr.write(`\rSmart search ${done}/${total ?? state.pendingChunks}`);
          else if (done % 640 === 0) process.stderr.write(`Smart search ${done}/${total ?? '?'}\n`);
        },
      };
      // `enableSemantic` is the one that may start from nothing (and download
      // the model); `topUpEmbeddings` is the cheap daily case.
      return buildAll ? enableSemantic(options).then(() => ({ embedded: 0 })) : topUpEmbeddings(options);
    },
    {
      onInterrupt: () => {
        process.stderr.write('\nStopped. Finished embeddings are kept; the rest are done next time.\n');
      },
    },
  );

  if (process.stderr.isTTY) process.stderr.write('\r');
  if (outcome.interrupted || outcome.value === undefined) {
    // The work may still be inside an unabortable model load, so leaving is
    // the only way to be prompt about it.
    closeSharedDatabases();
    process.exit(SIGINT_EXIT_CODE);
  }
  const after = semanticStatus();
  if (!after.enabled && after.pendingChunks === state.pendingChunks) {
    // The model could not be loaded or downloaded. Keyword search does not
    // care, and nothing here is worth a stack trace.
    process.stdout.write('Smart search could not start (the model is not available). Keyword search is unaffected.\n');
    return 0;
  }
  process.stdout.write(
    `Smart search: ${after.totalChunks - after.pendingChunks} of ${after.totalChunks} chunks ready ` +
      `(${((Date.now() - started) / 1000).toFixed(1)}s)\n`,
  );
  return 0;
}

async function runStats(common: CommonOptions): Promise<number> {
  // "Where does this thing keep its files?" is exactly the question somebody
  // asks when the transcript directory is not where ccfind looked, so a missing
  // one prints the layout and the hint rather than one bare error line.
  try {
    await maybeSync(common);
  } catch (err) {
    if (!isUserError(err)) throw err;
  }
  const s = status({ projectsDir: common.projectsDir });
  if (common.json) {
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    return 0;
  }
  const smart = s.semantic.runtimeInstalled
    ? s.semantic.enabled
      ? s.semantic.pendingChunks === 0
        ? 'on'
        : `building (${s.semantic.pendingChunks} chunks left)`
      : 'off (starts the first time you open the picker or the browser UI)'
    : 'not installed (keyword search only)';
  process.stdout.write(
    [
      `projects dir     ${s.projectsDir}`,
      `index            ${s.dbPath} (${formatBytes(s.dbSizeBytes)})`,
      `sessions         ${s.sessions}`,
      `messages         ${s.messages}`,
      `chunks           ${s.chunks} (${s.chunksEmbedded} embedded)`,
      `smart search     ${smart}`,
      `embedding model  ${s.embeddingModel ?? '—'}`,
      '',
    ].join('\n'),
  );
  if (s.projectsDirHint !== null) process.stdout.write(`${s.projectsDirHint}\n`);
  return 0;
}

const useColor = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'];
const dim = (s: string): string => (useColor ? `\u001b[2m${s}\u001b[0m` : s);
const bold = (s: string): string => (useColor ? `\u001b[1m${s}\u001b[0m` : s);
const primary = (s: string): string => (useColor ? `\u001b[36m${s}\u001b[0m` : s);

/**
 * Titles, paths and snippets come from transcripts, so they are sanitised
 * again on the way out: nothing printed here can carry an escape sequence,
 * even if it somehow reached the index.
 */
function line(text: string): string {
  return sanitizeLine(text).replace(/\s+/g, ' ');
}

/** `line`, plus trimming: for fields where surrounding space is never content. */
function field(text: string): string {
  return line(text).trim();
}

function formatResult(result: SessionResult, position: number, showMatchCount: boolean): string {
  const folder = result.cwdExists ? field(result.cwd) : `${field(result.cwd)} (folder missing)`;
  const meta = [
    formatDate(result.lastTs),
    field(result.gitBranch) || '—',
    // Browsing recent sessions has no query, so there is no count to state.
    showMatchCount && result.matchCount > 0 ? matchCountLabel(result.matchCount) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  const lines = [
    `${position}. ${bold(field(result.title))}`,
    `   ${dim(folder)}`,
    `   ${dim(meta)}`,
  ];
  if (result.snippet.text !== '') {
    lines.push(`   ${result.snippet.role === 'user' ? 'You' : 'Claude'}: ${highlight(result.snippet).trim()}`);
  }
  lines.push(`   ${primary(field(result.resumeCommand))}`);
  return lines.join('\n') + '\n';
}

function highlight(snippet: { text: string; highlights: [number, number][] }): string {
  // Slice first, sanitise each piece: sanitising the whole string first would
  // shift the offsets the highlight ranges point at.
  if (!useColor || snippet.highlights.length === 0) return line(snippet.text);
  let out = '';
  let cursor = 0;
  for (const [start, end] of snippet.highlights) {
    out += line(snippet.text.slice(cursor, start));
    out += bold(line(snippet.text.slice(start, end)));
    cursor = end;
  }
  out += line(snippet.text.slice(cursor));
  return out;
}

/** Local date, the way the web UI writes it: `Sep 10, 2026`. */
function formatDate(ts: string): string {
  if (ts === '') return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return line(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Quotes a rejected value so an empty or space-filled one is still visible. */
function quoted(value: string): string {
  return JSON.stringify(sanitizeLine(value));
}

function parseMode(value: string | undefined, keywordOnly: boolean): SearchMode {
  if (keywordOnly) {
    if (value !== undefined && value !== 'keyword') {
      throw new UserError(`--keyword-only and --mode ${quoted(value)} contradict each other.`);
    }
    return 'keyword';
  }
  if (value === undefined) return 'auto';
  if (value === 'auto' || value === 'keyword' || value === 'semantic' || value === 'hybrid') return value;
  throw new UserError(`Unknown --mode: ${quoted(value)}. Use auto, keyword, semantic or hybrid.`);
}

function parseSort(value: string | undefined): SortOrder {
  if (value === undefined) return 'relevance';
  if (value === 'relevance' || value === 'recent') return value;
  throw new UserError(`Unknown --sort: ${quoted(value)}. Use relevance or recent.`);
}

/**
 * `--port 0` is not a mistake: it asks the operating system for any free port,
 * which is what `startWebServer` documents and what a scripted run wants when
 * the default one is taken.
 */
function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new UserError(`--port must be 0 (any free port) or between 1 and 65535, got: ${quoted(value)}`);
  }
  return n;
}

function parseRole(value: string | undefined): 'user' | 'assistant' | undefined {
  if (value === undefined) return undefined;
  if (value === 'user' || value === 'assistant') return value;
  throw new UserError(`Unknown --role: ${quoted(value)}. Use user or assistant.`);
}

/** Above this a "result list" is a data dump; ask for it deliberately with --json and a filter. */
export const MAX_LIMIT = 200;

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 10;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UserError(`--limit must be a positive integer, got: ${quoted(value)}`);
  if (n > MAX_LIMIT) throw new UserError(`--limit must be ${MAX_LIMIT} or less, got: ${quoted(value)}`);
  return n;
}

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/**
 * True when this file is what node was asked to run.
 *
 * `main()` must not run on `import('ccfind/dist/cli.js')` — somebody poking at
 * the module should not kick off a sync against their real index. The npm bin
 * is a symlink (`…/bin/ccfind` -> `dist/cli.js`) and on Windows a shim that
 * still passes the real path, so both sides are resolved through `realpath`
 * before comparing, case-insensitively where the filesystem is.
 */
export function isEntryPoint(moduleUrl: string, entry: string | undefined): boolean {
  if (entry === undefined || entry === '') return false;
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  let self: string;
  try {
    self = real(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
  const target = real(entry);
  return process.platform === 'win32' ? self.toLowerCase() === target.toLowerCase() : self === target;
}

export async function runCli(argv: string[]): Promise<void> {
  try {
    process.exitCode = await main(argv);
  } catch (err) {
    // Anything the user can act on is one line and nothing else. A stack trace
    // is only ever printed when it was asked for.
    if (isUserError(err)) {
      process.stderr.write(`${sanitizeLine(err.message)}\n`);
      process.exitCode = 2;
    } else if (process.env['CCFIND_DEBUG']) {
      process.stderr.write(`${APP_NAME}: ${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 1;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${APP_NAME}: ${sanitizeLine(message).split('\n').join(' ')}\n` +
          'Set CCFIND_DEBUG=1 and run it again to see the stack trace.\n',
      );
      process.exitCode = 1;
    }
  } finally {
    closeSharedDatabases();
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) void runCli(process.argv.slice(2));
