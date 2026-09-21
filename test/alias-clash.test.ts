/**
 * `ccfind --alias` promises it checked that nothing on this machine already
 * answers to the name. The check has to be worth that sentence.
 *
 * Everything here runs against a temp home. Nothing ever touches a real shell
 * startup file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appendAlias, type AliasEnv, definedInFile, resolveRcTarget, runAlias, SHELL_BUILTINS } from '../src/core/alias.js';
import { isUserError } from '../src/core/errors.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

/** Windows cannot set these cases up; see each guarded test for why. */
const isWindows = process.platform === 'win32';

afterAll(cleanupTempDirs);

interface Harness {
  env: AliasEnv;
  home: string;
  out: () => string;
}

function harness(overrides: Partial<AliasEnv> & { answer?: string } = {}): Harness {
  const home = tempDir('ccfind-clash-home-');
  const emptyPath = tempDir('ccfind-clash-path-');
  const written: string[] = [];
  const env: AliasEnv = {
    home,
    shell: '/bin/zsh',
    platform: 'darwin',
    pathEntries: [emptyPath],
    isTty: true,
    assumeYes: true,
    prompt: async () => overrides.answer ?? 'y',
    write: (text: string) => written.push(text),
    ...overrides,
  };
  return { env, home, out: () => written.join('') };
}

const rc = (home: string): string => path.join(home, '.zshrc');

async function refuses(contents: string, name = 'sf'): Promise<string> {
  const h = harness();
  fs.writeFileSync(rc(h.home), contents);
  let message = '';
  try {
    await runAlias(name, h.env);
  } catch (err) {
    expect(isUserError(err)).toBe(true);
    message = (err as Error).message;
  }
  expect(message).not.toBe('');
  // Nothing was appended.
  expect(fs.readFileSync(rc(h.home), 'utf8')).toBe(contents);
  return message;
}

async function accepts(contents: string, name = 'sf'): Promise<string> {
  const h = harness();
  fs.writeFileSync(rc(h.home), contents);
  await expect(runAlias(name, h.env)).resolves.toBe(0);
  return fs.readFileSync(rc(h.home), 'utf8');
}

describe('definedInFile', () => {
  it('finds a name assigned anywhere on a multi-assignment alias line', () => {
    expect(definedInFile('alias ll=ls sf=/x\n', 'sf', 'zsh')).toBe(true);
    expect(definedInFile("alias ll='ls -l' sf=ccfind\n", 'sf', 'zsh')).toBe(true);
    expect(definedInFile('alias sf=x ll=ls\n', 'sf', 'zsh')).toBe(true);
  });

  it('sees through quoting and leading option flags', () => {
    expect(definedInFile("alias sf='ccfind --json'\n", 'sf', 'zsh')).toBe(true);
    expect(definedInFile('alias sf="ccfind"\n', 'sf', 'zsh')).toBe(true);
    expect(definedInFile('alias -g sf=x\n', 'sf', 'zsh')).toBe(true);
    expect(definedInFile('  alias   -g   sf=x\n', 'sf', 'zsh')).toBe(true);
  });

  it('is not fooled by the name appearing inside somebody else’s value', () => {
    expect(definedInFile("alias x='echo sf=y'\n", 'sf', 'zsh')).toBe(false);
    expect(definedInFile('# alias sf=ccfind\n', 'sf', 'zsh')).toBe(false);
    expect(definedInFile('alias sfx=y\n', 'sf', 'zsh')).toBe(false);
    expect(definedInFile('alias xsf=y\n', 'sf', 'zsh')).toBe(false);
  });

  it('does not count a line that is not valid shell', () => {
    // `alias  sf = ccfind` defines nothing; it is a syntax error waiting to happen.
    expect(definedInFile('alias  sf = ccfind\n', 'sf', 'zsh')).toBe(false);
  });

  it('finds shell functions in every spelling', () => {
    expect(definedInFile('sf() {\n  ccfind "$@"\n}\n', 'sf', 'zsh')).toBe(true);
    expect(definedInFile('sf ()\n{\n}\n', 'sf', 'zsh')).toBe(true);
    expect(definedInFile('function sf {\n}\n', 'sf', 'zsh')).toBe(true);
    expect(definedInFile('function sf() {\n}\n', 'sf', 'zsh')).toBe(true);
    expect(definedInFile('  function sf {\n}\n', 'sf', 'zsh')).toBe(true);
  });

  it('finds a definition after a semicolon', () => {
    expect(definedInFile('true; alias sf=x\n', 'sf', 'zsh')).toBe(true);
  });

  it('understands fish syntax', () => {
    expect(definedInFile('alias sf ccfind\n', 'sf', 'fish')).toBe(true);
    expect(definedInFile('alias sf=ccfind\n', 'sf', 'fish')).toBe(true);
    expect(definedInFile('abbr sf ccfind\n', 'sf', 'fish')).toBe(true);
    expect(definedInFile('abbr -a sf ccfind\n', 'sf', 'fish')).toBe(true);
    expect(definedInFile('abbr --position command sf ccfind\n', 'sf', 'fish')).toBe(true);
    expect(definedInFile('function sf --description x\n', 'sf', 'fish')).toBe(true);
    expect(definedInFile('abbr other sf\n', 'sf', 'fish')).toBe(false);
  });

  it('handles CRLF files', () => {
    expect(definedInFile('alias ll=ls sf=x\r\nexport PATH=x\r\n', 'sf', 'zsh')).toBe(true);
  });
});

describe('names the tool refuses outright', () => {
  it('refuses shell builtins and reserved words on every platform', async () => {
    for (const name of ['cd', 'test', 'time', 'echo', 'export', 'while', 'local', 'read', 'set']) {
      expect(SHELL_BUILTINS.has(name)).toBe(true);
      const h = harness({ platform: 'win32' });
      await expect(runAlias(name, h.env)).rejects.toSatisfy(isUserError);
      expect(fs.readdirSync(h.home)).toEqual([]);
    }
  });

  it('refuses its own command names', async () => {
    for (const name of ['ccfind', 'ccf']) {
      const h = harness();
      await expect(runAlias(name, h.env)).rejects.toSatisfy(isUserError);
      expect(fs.readdirSync(h.home)).toEqual([]);
    }
  });

  it('still allows a perfectly ordinary name', async () => {
    const h = harness();
    await expect(runAlias('sf', h.env)).resolves.toBe(0);
    expect(fs.readFileSync(rc(h.home), 'utf8')).toContain('alias sf=ccfind');
  });
});

describe('an existing definition in the startup file', () => {
  it('refuses a multi-assignment alias line', async () => {
    expect(await refuses('alias ll=ls sf=/usr/bin/x\n')).toContain('already defined');
  });

  it('refuses a quoted alias', async () => {
    expect(await refuses("alias sf='ls -l'\n")).toContain('already defined');
  });

  it('refuses a function', async () => {
    expect(await refuses('sf() {\n  echo hi\n}\n')).toContain('already defined');
  });

  it('appends after an unrelated line that merely mentions the name', async () => {
    expect(await accepts("alias x='echo sf=y'\n")).toContain('alias sf=ccfind');
  });
});

describe('fish', () => {
  function fishHarness(): Harness {
    return harness({ shell: '/usr/local/bin/fish' });
  }

  it('refuses when a fish function file already claims the name', async () => {
    const h = fishHarness();
    const functions = path.join(h.home, '.config', 'fish', 'functions');
    fs.mkdirSync(functions, { recursive: true });
    fs.writeFileSync(path.join(functions, 'sf.fish'), 'function sf\nend\n');
    await expect(runAlias('sf', h.env)).rejects.toSatisfy(isUserError);
    expect(fs.existsSync(path.join(h.home, '.config', 'fish', 'config.fish'))).toBe(false);
  });

  it('refuses an abbr in config.fish', async () => {
    const h = fishHarness();
    const config = path.join(h.home, '.config', 'fish', 'config.fish');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, 'abbr -a sf ccfind\n');
    await expect(runAlias('sf', h.env)).rejects.toSatisfy(isUserError);
  });

  it('writes fish syntax when the name is free', async () => {
    const h = fishHarness();
    await expect(runAlias('sf', h.env)).resolves.toBe(0);
    const config = path.join(h.home, '.config', 'fish', 'config.fish');
    expect(fs.readFileSync(config, 'utf8')).toContain('alias sf ccfind');
  });
});

describe('the file it writes to', () => {
  it('keeps CRLF line endings', async () => {
    const h = harness();
    fs.writeFileSync(rc(h.home), 'export A=1\r\nexport B=2\r\n');
    await runAlias('sf', h.env);
    const after = fs.readFileSync(rc(h.home), 'utf8');
    expect(after).toContain('\r\nalias sf=ccfind\r\n');
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('adds the missing newline when the file does not end in one', async () => {
    const h = harness();
    fs.writeFileSync(rc(h.home), 'export A=1');
    await runAlias('sf', h.env);
    const after = fs.readFileSync(rc(h.home), 'utf8');
    expect(after.startsWith('export A=1\n')).toBe(true);
    expect(after).toContain('alias sf=ccfind\n');
    // The original line is still its own line, not glued to a comment.
    expect(after.split('\n')[0]).toBe('export A=1');
  });

  // Windows needs Developer Mode or elevation to create a symlink at all, so
  // there is no way to set this case up there.
  it.skipIf(isWindows)('follows a symlink that stays inside the home directory', async () => {
    const h = harness();
    const real = path.join(h.home, 'dotfiles', 'zshrc');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '# mine\n');
    fs.symlinkSync(real, rc(h.home));

    await expect(runAlias('sf', h.env)).resolves.toBe(0);
    expect(fs.readFileSync(real, 'utf8')).toContain('alias sf=ccfind');
    expect(fs.lstatSync(rc(h.home)).isSymbolicLink()).toBe(true);
  });

  it.skipIf(isWindows)('refuses a symlink pointing outside the home directory', async () => {
    const h = harness();
    const outside = tempDir('ccfind-clash-outside-');
    const target = path.join(outside, 'zshrc');
    fs.writeFileSync(target, '# not mine\n');
    fs.symlinkSync(target, rc(h.home));

    await expect(runAlias('sf', h.env)).rejects.toSatisfy(isUserError);
    expect(fs.readFileSync(target, 'utf8')).toBe('# not mine\n');
  });

  it.skipIf(isWindows)('refuses a dangling symlink instead of creating the file through it', async () => {
    const h = harness();
    const missing = path.join(h.home, 'gone', 'zshrc');
    fs.symlinkSync(missing, rc(h.home));

    await expect(runAlias('sf', h.env)).rejects.toSatisfy(isUserError);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('never creates a missing home directory', async () => {
    const parent = tempDir('ccfind-clash-nohome-');
    const home = path.join(parent, 'not-created');
    const h = harness({ home });
    await expect(runAlias('sf', h.env)).rejects.toSatisfy(isUserError);
    expect(fs.existsSync(home)).toBe(false);
  });

  // chmod is a no-op for the write bit on Windows in the way this needs: a
  // 0o444 file is still writable through the ACL Node runs under.
  it.skipIf(isWindows)('turns a read-only startup file into one line naming the exact fix', async () => {
    const h = harness();
    fs.writeFileSync(rc(h.home), '# mine\n');
    fs.chmodSync(rc(h.home), 0o444);
    try {
      let message = '';
      try {
        await runAlias('sf', h.env);
      } catch (err) {
        expect(isUserError(err)).toBe(true);
        message = (err as Error).message;
      }
      expect(message.split('\n')).toHaveLength(1);
      expect(message).toContain('alias sf=ccfind');
      expect(fs.readFileSync(rc(h.home), 'utf8')).toBe('# mine\n');
    } finally {
      fs.chmodSync(rc(h.home), 0o644);
    }
  });
});

describe('behaviours that must not regress', () => {
  it('asks before writing', async () => {
    const asked: string[] = [];
    const h = harness({
      assumeYes: false,
      prompt: async (question: string) => {
        asked.push(question);
        return 'n';
      },
    });
    await expect(runAlias('sf', h.env)).resolves.toBe(0);
    expect(asked).toHaveLength(1);
    expect(fs.existsSync(rc(h.home))).toBe(false);
  });

  it('writes nothing when it is not a terminal', async () => {
    const h = harness({ isTty: false, assumeYes: false });
    await expect(runAlias('sf', h.env)).resolves.toBe(0);
    expect(fs.existsSync(rc(h.home))).toBe(false);
    expect(h.out()).toContain('alias sf=ccfind');
  });

  it('is idempotent', async () => {
    const h = harness();
    await runAlias('sf', h.env);
    const once = fs.readFileSync(rc(h.home), 'utf8');
    await runAlias('sf', h.env);
    expect(fs.readFileSync(rc(h.home), 'utf8')).toBe(once);
    expect(h.out()).toContain('Nothing to do');
  });
});

describe('a definition the old check could not see', () => {
  it('finds one written across a line continuation', () => {
    expect(definedInFile('alias \\\nsf=ls\n', 'sf', 'zsh')).toBe(true);
    expect(definedInFile('alias \\\r\nsf=ls\r\n', 'sf', 'zsh')).toBe(true);
    expect(definedInFile('alias ll=ls \\\n  sf=ccfind\n', 'sf', 'zsh')).toBe(true);
    // And still says no when the continuation is inside somebody's value.
    expect(definedInFile("alias x='echo \\\nsf=y'\n", 'sf', 'zsh')).toBe(false);
  });

  it('finds one after a control keyword or an opener', () => {
    for (const contents of [
      'if [ -n "$TERM" ]; then alias sf=x; fi\n',
      'if false; then true; else alias sf=x; fi\n',
      'if false; then true; elif true; then alias sf=x; fi\n',
      'for f in a b; do alias sf=x; done\n',
      'while true; do alias sf=x; done\n',
      '{ alias sf=x; }\n',
      '! alias sf=x\n',
      'true && alias sf=x\n',
      'false || alias sf=x\n',
      'if true; then function sf { echo hi; }; fi\n',
    ]) {
      expect(definedInFile(contents, 'sf', 'zsh'), contents).toBe(true);
    }
  });

  it('refuses to append to a startup file that defines the name behind a keyword', async () => {
    expect(await refuses('if [ -n "$TERM" ]; then alias sf=ls; fi\n')).toContain('already defined');
    expect(await refuses('alias \\\nsf=ls\n')).toContain('already defined');
  });
});

describe('a name that is taken outside any startup file', () => {
  const binDir = tempDir('ccfind-clash-realbin-');
  fs.writeFileSync(path.join(binDir, 'ls'), '#!/bin/sh\necho hi\n', { mode: 0o755 });

  it('is refused under an unknown shell and on Windows, not printed as advice', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const h = harness({
        platform,
        shell: platform === 'win32' ? undefined : '/usr/bin/nu',
        pathEntries: [binDir],
        pathExt: platform === 'win32' ? [''] : undefined,
      });
      await expect(runAlias('ls', h.env), platform).rejects.toSatisfy(isUserError);
      expect(h.out()).toBe('');
      expect(fs.readdirSync(h.home)).toEqual([]);
    }
  });

  it('refuses a shell builtin under an unknown shell too', async () => {
    const h = harness({ shell: '/usr/bin/nu' });
    await expect(runAlias('cd', h.env)).rejects.toSatisfy(isUserError);
    expect(h.out()).toBe('');
  });

  it('refuses the fish builtins a fish user would be broken by', async () => {
    for (const name of ['string', 'count', 'end', 'math', 'status', 'abbr', 'funcsave', 'contains', 'and', 'or']) {
      expect(SHELL_BUILTINS.has(name), name).toBe(true);
      const h = harness({ shell: '/usr/local/bin/fish' });
      await expect(runAlias(name, h.env), name).rejects.toSatisfy(isUserError);
      expect(fs.readdirSync(h.home)).toEqual([]);
    }
  });
});

describe('a home directory that is not one', () => {
  it('is refused in one line, and nothing is written', async () => {
    for (const home of ['/', '', 'relative/home', '.']) {
      const h = harness({ home });
      let message = '';
      try {
        await runAlias('sf', h.env);
      } catch (err) {
        expect(isUserError(err), home).toBe(true);
        message = (err as Error).message;
      }
      expect(message, `home=${JSON.stringify(home)}`).not.toBe('');
      expect(message.split('\n')).toHaveLength(1);
      expect(message).toContain('alias sf=ccfind');
    }
    expect(fs.existsSync('/.zshrc')).toBe(false);
  });
});

describe('the write itself', () => {
  it.skipIf(isWindows)('does not follow a symlink that appears after the target was resolved', async () => {
    const h = harness();
    const outside = tempDir('ccfind-clash-swap-');
    const stolen = path.join(outside, 'zshrc');
    fs.writeFileSync(stolen, '# not mine\n');

    // Exactly the race: the path is checked, and only then replaced by a link.
    const destination = resolveRcTarget(rc(h.home), h.home, 'alias sf=ccfind');
    fs.symlinkSync(stolen, destination);

    expect(() => appendAlias(destination, '\n# ccfind short command\nalias sf=ccfind\n', 'alias sf=ccfind')).toThrow(
      /Could not write to/,
    );
    expect(fs.readFileSync(stolen, 'utf8')).toBe('# not mine\n');
  });

  it('still creates the file and appends through the one handle', () => {
    const h = harness();
    const destination = resolveRcTarget(rc(h.home), h.home, 'alias sf=ccfind');
    appendAlias(destination, '\n# ccfind short command\nalias sf=ccfind\n', 'alias sf=ccfind');
    appendAlias(destination, '\n# second\n', 'alias sf=ccfind');
    const after = fs.readFileSync(destination, 'utf8');
    expect(after).toBe('\n# ccfind short command\nalias sf=ccfind\n\n# second\n');
  });
});
