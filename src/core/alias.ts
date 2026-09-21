/**
 * `ccfind --alias [name]` — a short command that is safe on *this* machine.
 *
 * The published binaries are `ccfind` and `ccf`, deliberately: a package that
 * claims a name like `sf` breaks `npm i -g` for anybody who already has the
 * Salesforce CLI. So the short name is something the user opts into, after we
 * have checked that nothing on their machine answers to it already, and it is
 * one appended line in their own shell startup file — never a rewrite, never a
 * reorder, never without being shown exactly what will be added.
 */
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './errors.js';
import { APP_NAME, canonicalDir } from './paths.js';
import { whichSync } from './which.js';

/** Lower case, starts with a letter, up to 16 characters. Nothing a shell can read as syntax. */
export const ALIAS_NAME_RE = /^[a-z][a-z0-9_-]{0,15}$/;

/** The default short name, if the user does not pick one. */
export const DEFAULT_ALIAS = 'sf';

/**
 * Names no alias may take, on any operating system.
 *
 * `PATH` cannot answer this question: `cd`, `test` and `time` are builtins and
 * reserved words, so they are not files anywhere — and shadowing one of them
 * with an alias breaks scripts in ways that are miserable to track down. A
 * blocklist is the only honest check, so here it is, spelled out.
 */
export const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  '.',
  'alias',
  'bg',
  'bind',
  'break',
  'builtin',
  'case',
  'cd',
  'command',
  'continue',
  'declare',
  'dirs',
  'do',
  'done',
  'echo',
  'elif',
  'else',
  'esac',
  'eval',
  'exec',
  'exit',
  'export',
  'false',
  'fc',
  'fg',
  'fi',
  'for',
  'function',
  'getopts',
  'hash',
  'help',
  'history',
  'if',
  'in',
  'jobs',
  'kill',
  'let',
  'local',
  'logout',
  'popd',
  'printf',
  'pushd',
  'pwd',
  'read',
  'readonly',
  'return',
  'select',
  'set',
  'shift',
  'shopt',
  'source',
  'suspend',
  'test',
  'then',
  'time',
  'times',
  'trap',
  'true',
  'type',
  'typeset',
  'ulimit',
  'umask',
  'unalias',
  'unset',
  'until',
  'wait',
  'while',
  // fish has its own set, and most of it is builtins rather than files: a fish
  // user who aliased `string`, `count` or `end` would break their own prompt.
  'abbr',
  'and',
  'begin',
  'contains',
  'count',
  'end',
  'funced',
  'funcsave',
  'math',
  'not',
  'or',
  'status',
  'string',
  'switch',
  // And the names this tool already installs: aliasing one to itself is a loop.
  APP_NAME,
  'ccf',
]);

export type AliasShell = 'zsh' | 'bash' | 'fish' | 'unknown';

export interface AliasEnv {
  /** The user's home directory. */
  home: string;
  /** `$SHELL`, as the login shell reports it. */
  shell: string | undefined;
  /**
   * `$ZDOTDIR`. When it is set, zsh reads `$ZDOTDIR/.zshrc` and never looks at
   * `~/.zshrc`, so writing the alias there would be silently useless.
   */
  zdotdir?: string | undefined;
  /** `$XDG_CONFIG_HOME`. Moves fish's `fish/config.fish` and its `functions/` dir. */
  xdgConfigHome?: string | undefined;
  platform: NodeJS.Platform;
  /** `PATH`, already split on the platform's separator. */
  pathEntries: string[];
  /** Windows `PATHEXT`, split. Ignored elsewhere. */
  pathExt?: string[] | undefined;
  /** False when stdin is a pipe: then this only ever prints. */
  isTty: boolean;
  /** `--yes`: skip the question, still do every check. */
  assumeYes: boolean;
  /** Asks the question and resolves with what was typed. */
  prompt: (question: string) => Promise<string>;
  write: (text: string) => void;
}

export interface ShellTarget {
  shell: AliasShell;
  /** Startup file to append to. Empty for a shell we will not write for. */
  file: string;
  /**
   * Why there is no file, when the shell is known but its configuration
   * directory has been moved somewhere this tool will not write. Shown to the
   * user, who then gets the line to paste.
   */
  reason?: string | undefined;
}

/**
 * Where a shell reads its startup file from, honouring the variable that moves
 * it.
 *
 * Unset or empty means the default, which is what the shells themselves do.
 * Anything else has to be an absolute path inside the home directory: a
 * relative one resolves against wherever the tool happened to start, and one
 * that leads out of `$HOME` is somebody else's tree. Neither is a file to
 * append to unasked, so both end as a reason and the line to paste.
 */
function configDir(
  value: string | undefined,
  variable: string,
  fallback: string,
  home: string,
): { dir: string; reason?: undefined } | { dir?: undefined; reason: string } {
  if (value === undefined || value === '') return { dir: fallback };
  const nothingChanged = `so ${APP_NAME} did not guess which file to write`;
  if (!path.isAbsolute(value)) {
    return { reason: `$${variable} is ${JSON.stringify(value)}, which is not an absolute path, ${nothingChanged}.` };
  }
  const resolved = path.resolve(value);
  // Both sides through realpath, the way `resolveRcTarget` decides the same
  // question: on macOS a home under `/var` really lives in `/private/var`, and
  // comparing the two spellings would refuse a perfectly ordinary setup.
  const inside = path.relative(canonicalDir(home), canonicalDir(resolved));
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    return { reason: `$${variable} (${resolved}) is outside your home directory, ${nothingChanged}.` };
  }
  return { dir: resolved };
}

/**
 * Which file to append to, given `$SHELL`.
 *
 * bash reads `~/.bashrc` on Linux; on macOS a login shell reads
 * `~/.bash_profile`, and plenty of macOS users have only that one, so it is
 * used when `.bashrc` is not there. zsh and fish both let the environment move
 * their configuration directory, and the file the shell will actually read is
 * the only one worth writing to.
 */
export function detectShell(env: AliasEnv): ShellTarget {
  if (env.platform === 'win32') return { shell: 'unknown', file: '' };
  const name = path.basename(env.shell ?? '').replace(/\.exe$/i, '');
  if (name === 'zsh') {
    const home = configDir(env.zdotdir, 'ZDOTDIR', env.home, env.home);
    if (home.dir === undefined) return { shell: 'zsh', file: '', reason: home.reason };
    return { shell: 'zsh', file: path.join(home.dir, '.zshrc') };
  }
  if (name === 'fish') {
    const base = configDir(env.xdgConfigHome, 'XDG_CONFIG_HOME', path.join(env.home, '.config'), env.home);
    if (base.dir === undefined) return { shell: 'fish', file: '', reason: base.reason };
    return { shell: 'fish', file: path.join(base.dir, 'fish', 'config.fish') };
  }
  if (name === 'bash') {
    const bashrc = path.join(env.home, '.bashrc');
    if (fs.existsSync(bashrc)) return { shell: 'bash', file: bashrc };
    const profile = path.join(env.home, '.bash_profile');
    if (env.platform === 'darwin' || fs.existsSync(profile)) return { shell: 'bash', file: profile };
    return { shell: 'bash', file: bashrc };
  }
  return { shell: 'unknown', file: '' };
}

/** The one line that gets added, in that shell's syntax. */
export function aliasLine(name: string, shell: AliasShell): string {
  return shell === 'fish' ? `alias ${name} ${APP_NAME}` : `alias ${name}=${APP_NAME}`;
}

/** What is appended: a blank line, a comment saying who did this, and the alias. */
export function aliasBlock(name: string, shell: AliasShell): string {
  return `\n# ${APP_NAME} short command\n${aliasLine(name, shell)}\n`;
}

/**
 * The first executable called `name` on `PATH`, or null.
 *
 * PATH is walked directly rather than asking a shell, so nothing in the name
 * can ever be interpreted by one.
 */
export function findOnPath(name: string, env: AliasEnv): string | null {
  return whichSync(name, { pathEntries: env.pathEntries, pathExt: env.pathExt, platform: env.platform });
}

/**
 * Splits one line the way a shell would: quotes hold a token together, a
 * backslash escapes the next character, `;` is its own token, and an unquoted
 * `#` at the start of a token begins a comment.
 *
 * A regular expression cannot do this. `alias ll=ls sf=/x` really does define
 * `sf`, and `alias x='echo sf=y'` really does not, and telling those apart is
 * the difference between the promise on the tin and a guess.
 */
export function tokenizeShellLine(line: string): string[][] {
  const commands: string[][] = [];
  let tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: string | null = null;

  const endToken = (): void => {
    if (started) tokens.push(current);
    current = '';
    started = false;
  };
  const endCommand = (): void => {
    endToken();
    if (tokens.length > 0) commands.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      i += 1;
      current += line[i]!;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endToken();
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|') {
      endCommand();
      continue;
    }
    if (ch === '#' && !started) break;
    current += ch;
    started = true;
  }
  endCommand();
  return commands;
}

/** Drops leading `-x` / `--long` option tokens, which never name anything. */
function skipFlags(tokens: string[]): string[] {
  let at = 0;
  while (at < tokens.length && tokens[at]!.startsWith('-')) at += 1;
  return tokens.slice(at);
}

/** fish `abbr` options that are followed by a value word. */
const ABBR_VALUE_FLAGS = new Set(['-p', '--position', '-c', '--command', '-r', '--regex', '-f', '--function']);

function skipAbbrFlags(tokens: string[]): string[] {
  let at = 0;
  while (at < tokens.length && tokens[at]!.startsWith('-')) {
    const flag = tokens[at]!;
    at += 1;
    if (ABBR_VALUE_FLAGS.has(flag) && at < tokens.length) at += 1;
  }
  return tokens.slice(at);
}

/**
 * Words that can stand in front of a command without changing what it defines.
 *
 * `if [ -n "$X" ]; then alias sf=x; fi` really does define `sf`, and so does
 * the body of a loop or a group. The tokeniser already ends a command at `;`,
 * `&&` and `||`, so what is left to step over is the keyword that opens the
 * next one.
 */
const CONTROL_OPENERS: ReadonlySet<string> = new Set([
  '!',
  '(',
  '{',
  'do',
  'elif',
  'else',
  'for',
  'if',
  'then',
  'until',
  'while',
]);

/** True when this one command defines `name` as an alias, abbreviation or function. */
function definesName(rawTokens: string[], name: string, shell: AliasShell): boolean {
  let tokens = rawTokens;
  while (tokens.length > 1 && CONTROL_OPENERS.has(tokens[0]!)) tokens = tokens.slice(1);
  const head = tokens[0];
  if (head === undefined) return false;
  const rest = skipFlags(tokens.slice(1));

  if (head === 'alias') {
    // POSIX shells: any `name=value` word on the line, however many there are.
    if (rest.some((token) => token.startsWith(`${name}=`))) return true;
    // fish also spells it `alias name value`.
    return shell === 'fish' && rest[0] === name;
  }

  // fish abbreviations are aliases by another name. Some of their options take
  // a value, which would otherwise be mistaken for the name being defined.
  if (shell === 'fish' && head === 'abbr') {
    const word = skipAbbrFlags(tokens.slice(1))[0];
    return word === name || word === `${name}=`;
  }

  if (head === 'function') {
    const declared = rest[0];
    if (declared === undefined) return false;
    return declared === name || declared === `${name}()` || declared === `${name}(`;
  }

  // `sf() { … }` and `sf ()`, which is how most people write a shell function.
  if (shell !== 'fish') {
    const joined = tokens.join(' ');
    if (new RegExp(`^${escapeRegExp(name)}\\s*\\(\\s*\\)`).test(joined)) return true;
  }

  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * True when the startup file already defines this name as an alias, an
 * abbreviation or a function — in any spelling, on any line, with any quoting.
 */
export function definedInFile(contents: string, name: string, shell: AliasShell): boolean {
  // A backslash at the end of a line is not a line ending at all: the shell
  // joins the two, so `alias \` + newline + `sf=ls` defines `sf`.
  const joined = contents.replace(/\\\r?\n/g, '');
  for (const line of joined.split(/\r?\n/)) {
    for (const command of tokenizeShellLine(line)) {
      if (definesName(command, name, shell)) return true;
    }
  }
  return false;
}

/**
 * fish keeps one function per file; a file here is as good as a definition.
 *
 * Derived from `config.fish` rather than from `$HOME`, so a fish that has been
 * moved by `XDG_CONFIG_HOME` is checked where it really keeps its functions.
 */
export function fishFunctionFile(configFish: string, name: string): string {
  return path.join(path.dirname(configFish), 'functions', `${name}.fish`);
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Runs the whole flow and returns the exit code. Writes nothing unless the
 * name is free, the user is at a terminal, and they said yes.
 */
export async function runAlias(rawName: string, env: AliasEnv): Promise<number> {
  const name = rawName === '' ? DEFAULT_ALIAS : rawName;
  if (!ALIAS_NAME_RE.test(name)) {
    throw new UserError(
      `"${name}" is not a name a shell can use. Use lowercase letters, digits, - or _, ` +
        `starting with a letter, up to 16 characters: ${APP_NAME} --alias sf`,
    );
  }

  // Before anything is looked up on disk, and on every platform: a builtin is
  // not on PATH, so nothing later in this function could catch it.
  if (SHELL_BUILTINS.has(name)) {
    throw new UserError(
      `${name} is a shell builtin or a reserved word, so shadowing it would break other commands.\n` +
        `Pick another one, for example: ${APP_NAME} --alias ${name === DEFAULT_ALIAS ? 'ccf2' : DEFAULT_ALIAS}`,
    );
  }

  // Also before the shell is looked at: a name that is already a program is a
  // clash on Windows and under an unknown shell too, and printing "add this
  // line to get `ls`" would be advice that breaks the machine.
  const onPath = findOnPath(name, env);
  if (onPath !== null) {
    throw new UserError(
      `${name} is already a command on this machine: ${onPath}\n` +
        `Pick another one, for example: ${APP_NAME} --alias ${name === DEFAULT_ALIAS ? 'ccf2' : 'sf'}`,
    );
  }

  const target = detectShell(env);
  if (target.shell === 'unknown') {
    // Nothing is written for a shell whose startup file we would be guessing at.
    env.write(
      `Add this line to your shell's startup file to get \`${name}\`:\n` +
        `  ${aliasLine(name, 'zsh')}\n` +
        `PowerShell (in $PROFILE):\n` +
        `  Set-Alias ${name} ${APP_NAME}\n`,
    );
    return 0;
  }

  const line = aliasLine(name, target.shell);
  const suggestion = name === DEFAULT_ALIAS ? 'ccf2' : DEFAULT_ALIAS;

  // A known shell whose configuration directory has been pointed somewhere we
  // will not write: say why, hand over the line, change nothing.
  if (target.file === '') {
    env.write(`${target.reason ?? 'There is no startup file to write.'}\n` + `Add this line yourself:\n  ${line}\n`);
    return 0;
  }

  // Everything below writes inside the home directory, so it has to be one:
  // `HOME=/` would put a startup file at the root of the filesystem, and a
  // relative or empty one resolves against wherever the tool happened to start.
  assertUsableHome(env.home, line);

  // fish keeps one function per file, so the name can be taken without
  // config.fish saying anything at all.
  if (target.shell === 'fish') {
    const functionFile = fishFunctionFile(target.file, name);
    if (fs.existsSync(functionFile)) {
      throw new UserError(
        `${name} is already a fish function: ${functionFile}\n` +
          `Pick another one, for example: ${APP_NAME} --alias ${suggestion}`,
      );
    }
  }

  const existing = readIfExists(target.file);
  if (existing !== null && existing.split(/\r?\n/).some((row) => row.trim() === line)) {
    env.write(`${name} is already set up in ${target.file}. Nothing to do.\n`);
    return 0;
  }
  if (existing !== null && definedInFile(existing, name, target.shell)) {
    throw new UserError(
      `${name} is already defined in ${target.file}.\n` +
        `Pick another one, for example: ${APP_NAME} --alias ${suggestion}`,
    );
  }

  // Resolve where the write would land before asking: refusing after saying
  // yes would be a worse experience than refusing instead of asking.
  const destination = resolveRcTarget(target.file, env.home, line);

  env.write(`This will add to ${target.file}:\n\n${aliasBlock(name, target.shell)}\n`);

  if (env.assumeYes) {
    // `--yes` is the answer to the question, so there is no question — in a
    // terminal or in a script, which is where it is actually useful.
  } else if (!env.isTty) {
    // Piped with nobody to ask: show the line, change nothing, and say how to
    // mean it.
    env.write(
      `Not a terminal, so nothing was changed. Add the line yourself, ` +
        `or run again with --yes to apply it.\n`,
    );
    return 0;
  } else {
    const answer = (await env.prompt('Add it? (y/N) ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      env.write('Left your shell configuration alone.\n');
      return 0;
    }
  }

  appendAlias(destination, aliasBlock(name, target.shell), line);
  env.write(`Added. Open a new terminal, or run: source ${target.file}\n`);
  return 0;
}

/**
 * Where the block will actually be written.
 *
 * People keep dotfiles in a repo and symlink them, so a link is followed — but
 * only as far as their own home directory. A link that points outside it, or
 * at nothing at all, is refused rather than quietly turned into a new file in
 * somebody else's tree. A home directory that does not exist is never created:
 * if `$HOME` is wrong, inventing it is not the fix.
 */
export function assertUsableHome(home: string, line: string): void {
  const manual = `Add this line by hand instead: ${line}`;
  if (home === '' || !path.isAbsolute(home)) {
    throw new UserError(`Your home directory ($HOME=${JSON.stringify(home)}) is not an absolute path. ${manual}`);
  }
  const resolved = path.resolve(home);
  if (resolved === path.parse(resolved).root) {
    throw new UserError(`Your home directory ($HOME=${home}) is the whole filesystem, so nothing was changed. ${manual}`);
  }
}

export function resolveRcTarget(file: string, home: string, line: string): string {
  const manual = `Add this line by hand instead: ${line}`;

  let realHome: string;
  try {
    realHome = fs.realpathSync(home);
  } catch {
    throw new UserError(`Your home directory (${home}) is not there, so nothing was changed. ${manual}`);
  }

  let link: fs.Stats | undefined;
  try {
    link = fs.lstatSync(file);
  } catch {
    link = undefined;
  }

  let target: string;
  if (link?.isSymbolicLink() === true) {
    try {
      target = fs.realpathSync(file);
    } catch {
      throw new UserError(`${file} is a symbolic link pointing at nothing, so nothing was changed. ${manual}`);
    }
  } else if (link === undefined) {
    target = realpathOfNearestExisting(file);
  } else {
    target = fs.realpathSync(file);
  }

  const inside = path.relative(realHome, target);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new UserError(`${file} leads outside your home directory (to ${target}), so nothing was changed. ${manual}`);
  }
  return target;
}

/** Resolves the symlinks in whatever part of the path already exists. */
function realpathOfNearestExisting(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(realpathOfNearestExisting(parent), path.basename(target));
  }
}

/**
 * Appends the block, matching the file's own line endings and giving it the
 * newline it was missing, and creating the file — and only the file — when it
 * is not there yet. A file that cannot be written is one sentence and the exact
 * line to paste, never a stack trace.
 *
 * The file is opened once, and the same handle is read and written: reading the
 * path, deciding, and then writing to the path again would let whatever is
 * between those two moments decide where the write lands. `O_NOFOLLOW` is what
 * makes that guarantee real — the symlink policy was already settled by
 * {@link resolveRcTarget}, and a link that appears at this path afterwards is
 * refused instead of followed.
 */
export function appendAlias(file: string, block: string, line: string): void {
  const refuse = (code: string | undefined): never => {
    throw new UserError(`Could not write to ${file} (${code ?? 'unknown'}). Add this line by hand instead: ${line}`);
  };

  let fd: number;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Append, create if missing, never through a symbolic link.
    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (WRITE_REFUSALS.has(code ?? '')) refuse(code);
    throw err;
  }

  try {
    const size = fs.fstatSync(fd).size;
    let existing: string | null = null;
    if (size > 0) {
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, 0);
      existing = buffer.toString('utf8');
    }

    // Somebody's `.zshrc` written on Windows stays a CRLF file.
    const eol = existing !== null && existing.includes('\r\n') ? '\r\n' : '\n';
    const needsBreak = existing !== null && existing !== '' && !existing.endsWith('\n');
    const text = (needsBreak ? eol : '') + block.split('\n').join(eol);

    // O_APPEND: every write goes to the end, whatever else happened meanwhile.
    fs.writeSync(fd, text, null, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (WRITE_REFUSALS.has(code ?? '')) refuse(code);
    throw err;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* nothing left to do about it */
    }
  }
}

/** Not on Windows, where the last path component cannot be a symbolic link this way. */
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Refusals that are somebody's setup, not a bug: one sentence, never a stack. */
const WRITE_REFUSALS: ReadonlySet<string> = new Set([
  'EACCES',
  'EPERM',
  'EROFS',
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'ELOOP',
  'EMLINK',
]);
