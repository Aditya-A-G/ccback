/**
 * Loaded into every worker before any test module, so no test can reach a real
 * home directory even by mistake.
 *
 * `HOME` and `CCFIND_HOME` both point inside this run's temp directory, the
 * embedding model is off, and the variables a developer may well have exported
 * in their own shell (`CCFIND_HOME`, `CCFIND_DEBUG`, `SHELL`) are replaced or
 * removed rather than inherited. Children spawned by a test get their own home
 * explicitly, through `childEnv()` in `helpers.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUN_HOME_ENV } from './real-home-guard.js';

const runHome =
  process.env[RUN_HOME_ENV] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ccfind-test-worker-'));

const home = path.join(runHome, `home-${process.pid}`);
const appHome = path.join(runHome, `app-${process.pid}`);
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(appHome, { recursive: true });

process.env[RUN_HOME_ENV] = runHome;
process.env['HOME'] = home;
// os.homedir() reads USERPROFILE on Windows and HOME everywhere else.
process.env['USERPROFILE'] = home;
process.env['CCFIND_HOME'] = appHome;
process.env['SESSION_FINDER_HOME'] = appHome;
process.env['CCFIND_NO_MODEL'] = '1';
process.env['CLAUDE_CONFIG_DIR'] = '/nonexistent-claude-config-dir-for-tests';
process.env['NO_COLOR'] = '1';
// A stack trace on stderr would break "one line, exit 2" assertions, and a
// login shell of the developer's choosing would decide which rc file the alias
// tests write to. Neither is the test suite's business.
delete process.env['CCFIND_DEBUG'];
delete process.env['SHELL'];
