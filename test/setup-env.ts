/**
 * Loaded into every worker before any test module, so no test can reach a real
 * home directory even by mistake.
 *
 * `HOME` and `CCBACK_HOME` both point inside this run's temp directory, the
 * embedding model is off, and the variables a developer may well have exported
 * in their own shell (`CCBACK_HOME`, `CCBACK_DEBUG`, `SHELL`) are replaced or
 * removed rather than inherited. Children spawned by a test get their own home
 * explicitly, through `childEnv()` in `helpers.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUN_HOME_ENV } from './real-home-guard.js';

const runHome =
  process.env[RUN_HOME_ENV] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ccback-test-worker-'));

const home = path.join(runHome, `home-${process.pid}`);
const appHome = path.join(runHome, `app-${process.pid}`);
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(appHome, { recursive: true });

process.env[RUN_HOME_ENV] = runHome;
process.env['HOME'] = home;
// os.homedir() reads USERPROFILE on Windows and HOME everywhere else.
process.env['USERPROFILE'] = home;
process.env['CCBACK_HOME'] = appHome;
process.env['CCBACK_NO_MODEL'] = '1';
process.env['CLAUDE_CONFIG_DIR'] = '/nonexistent-claude-config-dir-for-tests';
process.env['NO_COLOR'] = '1';
// A stack trace on stderr would break "one line, exit 2" assertions, and a
// login shell of the developer's choosing would decide which rc file the alias
// tests write to. Neither is the test suite's business.
delete process.env['CCBACK_DEBUG'];
delete process.env['SHELL'];
// Both move a shell's startup file, and keyword-only changes what the whole
// tool does: inheriting any of them would silently change what is tested.
delete process.env['ZDOTDIR'];
delete process.env['XDG_CONFIG_HOME'];
delete process.env['CCBACK_KEYWORD_ONLY'];
