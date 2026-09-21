// Finishes the build: static assets next to the compiled server (tsc only
// emits .js), and the executable bit on the CLI (tsc does not set one, and the
// tarball ships exactly what is on disk).
import { chmodSync, cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = new URL('../src/web/static', import.meta.url);
const to = new URL('../dist/web/static', import.meta.url);
if (existsSync(from)) cpSync(from, to, { recursive: true });

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
if (existsSync(cli)) chmodSync(cli, 0o755);
