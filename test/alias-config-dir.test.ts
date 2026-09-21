/**
 * `--alias` and the two variables that move a shell's configuration.
 *
 * zsh reads `$ZDOTDIR/.zshrc` when `ZDOTDIR` is set and never looks at
 * `~/.zshrc`, so the alias used to be written to a file the shell would not
 * read — and the clash check read that same wrong file, so a name already
 * taken in the real one was reported as free. fish has the same shape of
 * problem with `XDG_CONFIG_HOME`, for `config.fish` and for the `functions/`
 * directory a name can be taken in.
 *
 * A variable pointing outside the home directory is nobody's invitation to
 * write there: that is the print-the-line path, with the reason said out loud.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type AliasEnv, detectShell, runAlias } from '../src/core/alias.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

interface Harness {
  env: AliasEnv;
  home: string;
  out: () => string;
}

function harness(overrides: Partial<AliasEnv> = {}): Harness {
  const home = tempDir('sf-alias-cfg-home-');
  const emptyPath = tempDir('sf-alias-cfg-path-');
  const written: string[] = [];
  const env: AliasEnv = {
    home,
    shell: '/bin/zsh',
    platform: 'darwin',
    pathEntries: [emptyPath],
    isTty: false,
    assumeYes: true,
    prompt: async () => 'y',
    write: (text: string) => written.push(text),
    ...overrides,
  };
  return { env, home, out: () => written.join('') };
}

const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

describe('zsh with ZDOTDIR', () => {
  it('writes the file zsh will actually read', async () => {
    const h = harness();
    const zdotdir = path.join(h.home, 'config', 'zsh');
    fs.mkdirSync(zdotdir, { recursive: true });
    h.env.zdotdir = zdotdir;

    expect(detectShell(h.env).file).toBe(path.join(zdotdir, '.zshrc'));
    expect(await runAlias('sf', h.env)).toBe(0);
    expect(read(path.join(zdotdir, '.zshrc'))).toContain('alias sf=ccfind');
    // And nothing at all in the file zsh is ignoring.
    expect(fs.existsSync(path.join(h.home, '.zshrc'))).toBe(false);
  });

  it('reads the clash out of that file, not out of ~/.zshrc', async () => {
    const h = harness();
    const zdotdir = path.join(h.home, 'zdot');
    fs.mkdirSync(zdotdir, { recursive: true });
    h.env.zdotdir = zdotdir;
    // The name is taken where zsh looks, and free where it does not.
    fs.writeFileSync(path.join(zdotdir, '.zshrc'), 'alias sf=/usr/bin/something\n');
    fs.writeFileSync(path.join(h.home, '.zshrc'), '# nothing here\n');

    await expect(runAlias('sf', h.env)).rejects.toThrow(/already defined/);
    expect(read(path.join(h.home, '.zshrc'))).toBe('# nothing here\n');
  });

  it('treats an empty ZDOTDIR as unset, the way zsh does', async () => {
    const h = harness({ zdotdir: '' });
    expect(detectShell(h.env).file).toBe(path.join(h.home, '.zshrc'));
    expect(await runAlias('sf', h.env)).toBe(0);
    expect(read(path.join(h.home, '.zshrc'))).toContain('alias sf=ccfind');
  });

  it('prints the line, and why, when ZDOTDIR is outside the home directory', async () => {
    const outside = tempDir('sf-alias-outside-');
    const h = harness({ zdotdir: outside });

    const target = detectShell(h.env);
    expect(target.file).toBe('');
    expect(target.reason).toContain('ZDOTDIR');

    expect(await runAlias('sf', h.env)).toBe(0);
    expect(h.out()).toContain('ZDOTDIR');
    expect(h.out()).toContain('outside your home directory');
    expect(h.out()).toContain('alias sf=ccfind');
    // Nothing written anywhere: not in the home directory, not out there.
    expect(fs.readdirSync(h.home)).toEqual([]);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('prints the line, and why, when ZDOTDIR is a relative path', async () => {
    const h = harness({ zdotdir: 'config/zsh' });
    expect(await runAlias('sf', h.env)).toBe(0);
    expect(h.out()).toContain('not an absolute path');
    expect(h.out()).toContain('alias sf=ccfind');
    expect(fs.readdirSync(h.home)).toEqual([]);
  });
});

describe('fish with XDG_CONFIG_HOME', () => {
  const fishEnv = (over: Partial<AliasEnv> = {}): Harness => harness({ shell: '/usr/local/bin/fish', ...over });

  it('writes the config.fish the user really has', async () => {
    const h = fishEnv();
    const xdg = path.join(h.home, '.dotfiles', 'config');
    fs.mkdirSync(xdg, { recursive: true });
    h.env.xdgConfigHome = xdg;

    expect(detectShell(h.env).file).toBe(path.join(xdg, 'fish', 'config.fish'));
    expect(await runAlias('sf', h.env)).toBe(0);
    expect(read(path.join(xdg, 'fish', 'config.fish'))).toContain('alias sf ccfind');
    expect(fs.existsSync(path.join(h.home, '.config', 'fish', 'config.fish'))).toBe(false);
  });

  it('finds a function file under the moved functions directory', async () => {
    const h = fishEnv();
    const xdg = path.join(h.home, 'xdg');
    const functions = path.join(xdg, 'fish', 'functions');
    fs.mkdirSync(functions, { recursive: true });
    fs.writeFileSync(path.join(functions, 'sf.fish'), 'function sf\n  ls\nend\n');
    h.env.xdgConfigHome = xdg;

    await expect(runAlias('sf', h.env)).rejects.toThrow(/already a fish function/);
    expect(fs.existsSync(path.join(xdg, 'fish', 'config.fish'))).toBe(false);
  });

  it('still uses ~/.config/fish when XDG_CONFIG_HOME is not set', async () => {
    const h = fishEnv();
    expect(await runAlias('sf', h.env)).toBe(0);
    expect(read(path.join(h.home, '.config', 'fish', 'config.fish'))).toContain('alias sf ccfind');
  });

  it('prints the line, and why, when XDG_CONFIG_HOME is outside the home directory', async () => {
    const outside = tempDir('sf-alias-xdg-outside-');
    const h = fishEnv({ xdgConfigHome: outside });

    expect(await runAlias('sf', h.env)).toBe(0);
    expect(h.out()).toContain('XDG_CONFIG_HOME');
    expect(h.out()).toContain('outside your home directory');
    // fish syntax for the line it hands over, not the POSIX one.
    expect(h.out()).toContain('alias sf ccfind');
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readdirSync(h.home)).toEqual([]);
  });
});
