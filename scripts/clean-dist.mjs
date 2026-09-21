// Empties `dist/` before a build.
//
// tsc overwrites what it emits and deletes nothing, so files from an earlier
// configuration — source maps, declaration maps, modules that have since been
// renamed — linger and end up in the published tarball. Portable on purpose:
// no `rm -rf`, so the build works the same on Windows.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

rmSync(fileURLToPath(new URL('../dist', import.meta.url)), { recursive: true, force: true });
