import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // better-sqlite3 is a native addon; forks keep each worker in a clean process.
    pool: 'forks',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One temp directory for the whole run, plus the before/after check that
    // nothing was written to the real ~/.ccfind.
    globalSetup: ['test/global-setup.ts'],
    // Runs in every worker before any test module is imported: HOME,
    // CCFIND_HOME and CCFIND_NO_MODEL are set there, so a module that resolves
    // a path at import time already sees the temp directories.
    setupFiles: ['test/setup-env.ts'],
    env: {
      // Anything a test spawns gets these too, and every spawn additionally
      // scrubs the caller's environment through `childEnv()`.
      CLAUDE_CONFIG_DIR: '/nonexistent-claude-config-dir-for-tests',
      // No test may load or download the real embedding model. Every test that
      // needs vectors injects the deterministic fake embedder.
      CCFIND_NO_MODEL: '1',
      NO_COLOR: '1',
    },
  },
});
