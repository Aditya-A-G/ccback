/**
 * `ccfind --alias [name]`.
 *
 * The published binaries stay `ccfind` and `ccf`; a short name is something
 * the user opts into, and only after we have proved it is free on their
 * machine. Nothing here may write to a real home directory, rewrite a file, or
 * accept a name a shell could read as syntax.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { type AliasEnv, runAlias } from '../src/core/alias.js';
import { isUserError } from '../src/core/errors.js';
import { childEnv, cleanupTempDirs, tempDir } from './helpers.js';

/** Windows cannot set these cases up; see each guarded test for why. */
const isWindows = process.platform === 'win32';

afterAll(cleanupTempDirs);

interface Harness {
  env: AliasEnv;
  home: string;
  out: () => string;
  asked: string[];
}

function harness(overrides: Partial<AliasEnv> & { answer?: string } = {}): Harness {
  const home = tempDir('sf-alias-home-');
  // An empty PATH by default: the machine has nothing that could clash.
  const emptyPath = tempDir('sf-alias-path-');
  const written: string[] = [];
  const asked: string[] = [];
  const env: AliasEnv = {
    home,
    shell: '/bin/zsh',
    platform: 'darwin',
    pathEntries: [emptyPath],
    isTty: true,
    assumeYes: false,
    prompt: async (question: string) => {
      asked.push(question);
      return overrides.answer ?? 'y';
    },
    write: (text: string) => written.push(text),
    ...overrides,
  };
  return { env, home, out: () => written.join(''), asked };
}

const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

describe('the name', () => {
  it('rejects anything a shell could read as syntax, and writes nothing', async () => {
    for (const bad of ['sf; rm -rf ~', 'two words', '-lead', 'Sf', 'sf$(whoami)', 'x'.repeat(17), '1sf', 'sf/../x']) {
      const h = harness();
      await expect(runAlias(bad, h.env)).rejects.toSatisfy(isUserError);
      expect(fs.readdirSync(h.home)).toEqual([]);
    }
  });

  it('accepts the shapes people actually want', async () => {
    for (const good of ['sf', 'ccf2', 'my-find', 'my_find']) {
      const h = harness({ assumeYes: true });
      expect(await runAlias(good, h.env)).toBe(0);
      expect(read(path.join(h.home, '.zshrc'))).toContain(`alias ${good}=ccfind`);
    }
  });
});

describe('the shell it writes for', () => {
  it('zsh: ~/.zshrc', async () => {
    const h = harness({ shell: '/bin/zsh', assumeYes: true });
    expect(await runAlias('sf', h.env)).toBe(0);
    expect(read(path.join(h.home, '.zshrc'))).toBe('\n# ccfind short command\nalias sf=ccfind\n');
  });

  it('bash on linux: ~/.bashrc', async () => {
    const h = harness({ shell: '/usr/bin/bash', platform: 'linux', assumeYes: true });
    fs.writeFileSync(path.join(h.home, '.bashrc'), '# mine\n');
    expect(await runAlias('sf', h.env)).toBe(0);
    expect(read(path.join(h.home, '.bashrc'))).toBe('# mine\n\n# ccfind short command\nalias sf=ccfind\n');
  });

  it('bash on macOS without a .bashrc: ~/.bash_profile', async () => {
    const h = harness({ shell: '/bin/bash', platform: 'darwin', assumeYes: true });
    expect(await runAlias('sf', h.env)).toBe(0);
    expect(fs.existsSync(path.join(h.home, '.bashrc'))).toBe(false);
    expect(read(path.join(h.home, '.bash_profile'))).toContain('alias sf=ccfind');
  });

  it('fish: ~/.config/fish/config.fish, in fish syntax', async () => {
    const h = harness({ shell: '/opt/homebrew/bin/fish', assumeYes: true });
    expect(await runAlias('sf', h.env)).toBe(0);
    expect(read(path.join(h.home, '.config', 'fish', 'config.fish'))).toContain('alias sf ccfind');
  });

  it('windows and unknown shells: prints the line, changes nothing', async () => {
    for (const env of [{ platform: 'win32' as const }, { shell: '/usr/bin/nu' }]) {
      const h = harness({ ...env, assumeYes: true });
      expect(await runAlias('sf', h.env)).toBe(0);
      expect(h.out()).toContain('Set-Alias sf ccfind');
      expect(fs.readdirSync(h.home)).toEqual([]);
    }
  });
});

describe('clashes', () => {
  it('refuses a name that is already a command on PATH, and says which', async () => {
    const binDir = tempDir('sf-alias-bin-');
    const existing = path.join(binDir, 'sf');
    fs.writeFileSync(existing, '#!/bin/sh\necho salesforce\n', { mode: 0o755 });

    const h = harness({ pathEntries: [binDir], assumeYes: true });
    await expect(runAlias('sf', h.env)).rejects.toThrow(existing);
    await expect(runAlias('sf', h.env)).rejects.toThrow(/already a command/);
    expect(fs.readdirSync(h.home)).toEqual([]);
  });

  it('ignores a file on PATH that is not executable', async () => {
    const binDir = tempDir('sf-alias-bin2-');
    fs.writeFileSync(path.join(binDir, 'sf'), 'just a text file\n', { mode: 0o644 });
    const h = harness({ pathEntries: [binDir], assumeYes: true });
    expect(await runAlias('sf', h.env)).toBe(0);
  });

  it('refuses a name the startup file already defines as an alias or function', async () => {
    for (const existing of ['alias sf="git status"\n', 'sf() { echo hi; }\n', 'function sf {\n  echo hi\n}\n']) {
      const h = harness({ assumeYes: true });
      fs.writeFileSync(path.join(h.home, '.zshrc'), existing);
      await expect(runAlias('sf', h.env)).rejects.toThrow(/already defined/);
      expect(read(path.join(h.home, '.zshrc'))).toBe(existing);
    }
  });
});

describe('running it twice', () => {
  it('says it is already set up and changes nothing', async () => {
    const h = harness({ assumeYes: true });
    expect(await runAlias('sf', h.env)).toBe(0);
    const after = read(path.join(h.home, '.zshrc'));

    expect(await runAlias('sf', h.env)).toBe(0);
    expect(read(path.join(h.home, '.zshrc'))).toBe(after);
    expect(h.out()).toContain('already set up');
  });
});

describe('consent', () => {
  it('shows exactly what will be added, to which file, and asks', async () => {
    const h = harness();
    expect(await runAlias('sf', h.env)).toBe(0);
    expect(h.out()).toContain(path.join(h.home, '.zshrc'));
    expect(h.out()).toContain('# ccfind short command');
    expect(h.out()).toContain('alias sf=ccfind');
    expect(h.asked).toEqual(['Add it? (y/N) ']);
    expect(h.out()).toContain('source ');
  });

  it('writes nothing when the answer is not yes', async () => {
    for (const answer of ['', 'n', 'no', 'maybe', '\n']) {
      const h = harness({ answer });
      expect(await runAlias('sf', h.env)).toBe(0);
      expect(fs.existsSync(path.join(h.home, '.zshrc'))).toBe(false);
      expect(h.out()).toContain('Left your shell configuration alone.');
    }
  });

  it('writes nothing when stdin is not a terminal, and never asks', async () => {
    const h = harness({ isTty: false });
    expect(await runAlias('sf', h.env)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(fs.existsSync(path.join(h.home, '.zshrc'))).toBe(false);
    expect(h.out()).toContain('alias sf=ccfind');
    expect(h.out()).toContain('nothing was changed');
    // And it says how to mean it, which is what --yes is for.
    expect(h.out()).toContain('run again with --yes to apply it');
  });

  it('--yes writes without asking, terminal or not', async () => {
    for (const isTty of [true, false]) {
      const h = harness({ isTty, assumeYes: true });
      expect(await runAlias('sf', h.env), String(isTty)).toBe(0);
      expect(h.asked).toEqual([]);
      expect(read(path.join(h.home, '.zshrc'))).toContain('alias sf=ccfind');
      expect(h.out()).toContain('Added.');
    }
  });

  it('--yes still runs every check: a taken name is refused, not written', async () => {
    const binDir = tempDir('sf-alias-yes-bin-');
    fs.writeFileSync(path.join(binDir, 'sf'), '#!/bin/sh\n', { mode: 0o755 });
    const h = harness({ isTty: false, assumeYes: true, pathEntries: [binDir] });
    await expect(runAlias('sf', h.env)).rejects.toSatisfy(isUserError);
    expect(fs.readdirSync(h.home)).toEqual([]);
  });

  it('creates a missing startup file only after consent', async () => {
    const declined = harness({ answer: 'n' });
    await runAlias('sf', declined.env);
    expect(fs.readdirSync(declined.home)).toEqual([]);

    const accepted = harness({ answer: 'y' });
    await runAlias('sf', accepted.env);
    expect(fs.existsSync(path.join(accepted.home, '.zshrc'))).toBe(true);
  });
});

describe('the file it appends to', () => {
  // Creating a symlink on Windows needs Developer Mode or elevation.
  it.skipIf(isWindows)('follows a symlinked rc file to its target instead of replacing the link', async () => {
    const h = harness({ assumeYes: true });
    // A dotfiles repo inside the home directory, which is where people keep one.
    // A link leading out of the home directory is refused; see alias-clash.test.ts.
    const dotfiles = path.join(h.home, 'dotfiles');
    fs.mkdirSync(dotfiles, { recursive: true });
    const real = path.join(dotfiles, 'zshrc');
    fs.writeFileSync(real, '# kept in a repo\n');
    fs.symlinkSync(real, path.join(h.home, '.zshrc'));

    expect(await runAlias('sf', h.env)).toBe(0);
    expect(fs.lstatSync(path.join(h.home, '.zshrc')).isSymbolicLink()).toBe(true);
    expect(read(real)).toBe('# kept in a repo\n\n# ccfind short command\nalias sf=ccfind\n');
  });

  it('appends, preserving the file, its order and its mode', async () => {
    const h = harness({ assumeYes: true });
    const rc = path.join(h.home, '.zshrc');
    const before = 'export PATH=/x:$PATH\nsetopt autocd\n';
    fs.writeFileSync(rc, before, { mode: 0o600 });

    expect(await runAlias('sf', h.env)).toBe(0);
    const after = read(rc);
    expect(after.startsWith(before)).toBe(true);
    expect(fs.statSync(rc).mode & 0o777).toBe(0o600);
  });
});

describe('through the command line', () => {
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

  it('a bare --alias uses the default name and, piped, only prints', () => {
    const home = tempDir('sf-alias-cli-');
    const result = spawnSync(process.execPath, [cliPath, '--alias'], {
      encoding: 'utf8',
      env: childEnv({
        HOME: home,
        USERPROFILE: home,
        SHELL: '/bin/zsh',
        PATH: tempDir('sf-alias-cli-path-'),
        CCFIND_HOME: home,
      }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('alias sf=ccfind');
    expect(fs.existsSync(path.join(home, '.zshrc'))).toBe(false);
  });

  it('--alias --yes writes the line even when piped', () => {
    const home = tempDir('sf-alias-cli-yes-');
    const result = spawnSync(process.execPath, [cliPath, '--alias', '--yes'], {
      encoding: 'utf8',
      env: childEnv({
        HOME: home,
        USERPROFILE: home,
        SHELL: '/bin/zsh',
        PATH: tempDir('sf-alias-cli-yes-path-'),
        CCFIND_HOME: home,
      }),
    });
    expect([result.status, result.stderr]).toEqual([0, result.stderr]);
    expect(fs.readFileSync(path.join(home, '.zshrc'), 'utf8')).toContain('alias sf=ccfind');
    expect(result.stdout).toContain('Added.');
  });

  it('an invalid name exits 2 with one line', () => {
    const home = tempDir('sf-alias-cli-bad-');
    const result = spawnSync(process.execPath, [cliPath, '--alias', 'sf; rm -rf ~'], {
      encoding: 'utf8',
      env: childEnv({ HOME: home, USERPROFILE: home, SHELL: '/bin/zsh', CCFIND_HOME: home }),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not a name a shell can use');
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
