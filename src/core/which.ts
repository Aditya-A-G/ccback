import fs from 'node:fs';
import path from 'node:path';

export interface WhichOptions {
  /** Defaults to `PATH`, split for this platform. */
  pathEntries?: string[] | undefined;
  /** Windows executable extensions. Defaults to `PATHEXT`. */
  pathExt?: string[] | undefined;
  platform?: NodeJS.Platform | undefined;
}

const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];

/**
 * The first executable called `name` on `PATH`, or null.
 *
 * PATH is walked here rather than by asking a shell, so nothing in `name` can
 * ever be interpreted by one. On Windows this is also what makes it possible
 * to start `claude.cmd` without `shell: true`: the resolved path is passed to
 * `spawn` directly.
 */
export function whichSync(name: string, options: WhichOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const entries = options.pathEntries ?? (process.env['PATH'] ?? '').split(path.delimiter);
  const extensions =
    platform === 'win32'
      ? (options.pathExt ?? (process.env['PATHEXT'] ?? '').split(path.delimiter).filter(Boolean))
      : [''];
  const candidates = platform === 'win32' && extensions.length === 0 ? DEFAULT_PATHEXT : extensions;

  for (const entry of entries) {
    if (entry === '') continue;
    for (const ext of candidates) {
      const candidate = path.join(entry, `${name}${ext}`);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* not this one */
      }
    }
  }
  return null;
}
