/**
 * What `npm install -g ccfind` actually puts on somebody's disk.
 *
 * The tarball used to carry 84 source maps and declaration maps, every one of
 * them pointing at a `../src` that is not shipped: dead weight, and a
 * debugger's dead end. It must also never carry the test suite, the design
 * document, or anything else that is not the tool.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { childEnv } from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let files: string[] = [];

beforeAll(() => {
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
  it('ships no source maps or declaration maps', () => {
    expect(files.filter((name) => name.endsWith('.map'))).toEqual([]);
  });

  it('ships no sources, no tests and no design document', () => {
    expect(files.filter((name) => name.startsWith('src/'))).toEqual([]);
    expect(files.filter((name) => name.startsWith('test/'))).toEqual([]);
    expect(files.filter((name) => name.toUpperCase().includes('SPEC.MD'))).toEqual([]);
  });

  it('ships the licence, the readme, the CLI and the web page', () => {
    for (const required of ['LICENSE', 'README.md', 'dist/cli.js', 'dist/web/static/index.html']) {
      expect(files).toContain(required);
    }
  });

  it('keeps the type declarations that make the core importable', () => {
    // `main`, `types` and `exports` all point here on purpose.
    expect(files).toContain('dist/core/index.d.ts');
  });

  it('ships an executable CLI with a node shebang', () => {
    const cli = path.join(projectRoot, 'dist', 'cli.js');
    expect(fs.readFileSync(cli, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
    // npm links `bin` entries; they have to be runnable as they are shipped.
    expect(fs.statSync(cli).mode & 0o111).not.toBe(0);
  });
});
