/**
 * Importing the CLI must not run the CLI.
 *
 * Tools and editors import modules to inspect them, so an `import` of
 * `dist/cli.js` must never sync or write an index: `main()` belongs to the
 * process entry point alone. "Entry point" has to survive the npm bin symlink
 * (`…/bin/ccback` -> `dist/cli.js`), or the installed command does nothing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childEnv, cleanupTempDirs, makeFixture } from './helpers.js';

/** Windows cannot set these cases up; see each guarded test for why. */
const isWindows = process.platform === 'win32';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');

const fixture = makeFixture();

beforeAll(() => {
  if (!fs.existsSync(cliPath)) throw new Error('dist/cli.js is missing. Run "npm run build" first.');
});

afterAll(cleanupTempDirs);

function env(): NodeJS.ProcessEnv {
  return childEnv({ CCBACK_HOME: fixture.home });
}

describe('entry point guard', () => {
  it('importing dist/cli.js runs nothing and writes no index', () => {
    const home = path.join(fixture.root, 'import-home');
    fs.mkdirSync(home, { recursive: true });
    const script = `import ${JSON.stringify(pathToFileURL(cliPath).href)};\nprocess.stdout.write('imported');\n`;
    const scriptPath = path.join(fixture.root, 'import-cli.mjs');
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: { ...env(), CCBACK_HOME: home },
    });

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('imported');
    expect(result.status).toBe(0);
    // A sync would have created the index database in the app home.
    expect(fs.readdirSync(home)).toEqual([]);
  });

  // npm uses a .cmd shim rather than a symlink on Windows, and creating one
  // needs Developer Mode or elevation there anyway.
  it.skipIf(isWindows)('still runs when invoked through a bin symlink, as npm installs it', () => {
    const binDir = path.join(fixture.root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, 'ccback');
    if (!fs.existsSync(link)) fs.symlinkSync(cliPath, link);

    const result = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8', env: env() });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('runs normally when executed directly', () => {
    const result = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8', env: env() });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
