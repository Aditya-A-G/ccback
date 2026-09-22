/**
 * What `npm install -g ccback` actually puts on somebody's disk.
 *
 * Source maps and declaration maps point at a `../src` that is not shipped:
 * dead weight in the download, and a debugger's dead end. The tarball must
 * carry the tool, its licence and its readme, and nothing else — no sources,
 * no tests.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { childEnv } from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Skipped wholesale on Windows: `npm` there is `npm.cmd`, which `spawnSync`
 * cannot run without a shell, and the executable-bit check at the end is a
 * POSIX mode question that has no answer on NTFS. What the tarball contains
 * does not depend on the platform packing it, so Linux and macOS cover it.
 */
const isWindows = process.platform === 'win32';

let files: string[] = [];

beforeAll(() => {
  if (isWindows) return;
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--loglevel=error'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: childEnv({ npm_config_loglevel: 'error' }),
  });
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { files: { path: string }[] }[];
  files = parsed[0]!.files.map((entry) => entry.path.replace(/\\/g, '/'));
  expect(files.length).toBeGreaterThan(0);
}, 120_000);

describe('the published tarball', () => {
  it.skipIf(isWindows)('ships no source maps or declaration maps', () => {
    expect(files.filter((name) => name.endsWith('.map'))).toEqual([]);
  });

  it.skipIf(isWindows)('ships no sources and no tests', () => {
    expect(files.filter((name) => name.startsWith('src/'))).toEqual([]);
    expect(files.filter((name) => name.startsWith('test/'))).toEqual([]);
  });

  it.skipIf(isWindows)('ships the licence, the readme, the changelog, the CLI and the web page', () => {
    for (const required of [
      'LICENSE',
      'README.md',
      'CHANGELOG.md',
      'dist/cli.js',
      'dist/web/static/index.html',
    ]) {
      expect(files).toContain(required);
    }
  });

  it.skipIf(isWindows)('keeps the type declarations that make the core importable', () => {
    // `main`, `types` and `exports` all point here on purpose.
    expect(files).toContain('dist/core/index.d.ts');
  });

  it.skipIf(isWindows)('ships an executable CLI with a node shebang', () => {
    const cli = path.join(projectRoot, 'dist', 'cli.js');
    expect(fs.readFileSync(cli, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
    // npm links `bin` entries; they have to be runnable as they are shipped.
    expect(fs.statSync(cli).mode & 0o111).not.toBe(0);
  });
});
