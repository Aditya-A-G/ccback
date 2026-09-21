/**
 * The picker's one status line, when `--no-sync` was pointed at a folder the
 * index was not built from.
 *
 * The CLI has said this on stderr for a while; the picker took the same flags
 * and said nothing at all, so the results silently came from somewhere else.
 * It is a transient note like "copied": shown on start, gone on the first
 * keypress, and never a reason for the picker to refuse to open.
 */
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterAll, describe, expect, it } from 'vitest';
import { App } from '../src/tui/app.js';
import type { TuiDeps, TuiOptions } from '../src/tui/deps.js';
import type { IndexStatus, SyncResult } from '../src/core/index.js';
import { cleanupTempDirs } from './helpers.js';

afterAll(cleanupTempDirs);

const MISMATCH =
  '--no-sync: this index was built from /tmp/recorded, so these results are from there, not from /tmp/asked.';

const EMPTY_STATUS: IndexStatus = {
  projectsDir: '/tmp/recorded',
  indexedProjectsDir: '/tmp/recorded',
  projectsDirMatchesIndex: true,
  keywordOnly: null,
  projectsDirExists: true,
  projectsDirHint: null,
  dbPath: '/tmp/recorded/index.db',
  dbSizeBytes: 0,
  sessions: 1,
  messages: 1,
  chunks: 0,
  chunksEmbedded: 0,
  embeddingModel: null,
  embeddingDims: null,
  transformersAvailable: false,
  availableModes: ['auto', 'keyword'],
  defaultEmbeddingModel: 'none',
  semantic: { enabled: false, runtimeInstalled: false, pendingChunks: 0, totalChunks: 0, downloadMb: 0 },
};

const EMPTY_SYNC: SyncResult = {
  scannedFiles: 0,
  indexedFiles: 0,
  skippedFiles: 0,
  removedFiles: 0,
  skippedSessions: 0,
  failedFiles: 0,
  sessions: 0,
  messages: 0,
  chunks: 0,
  durationMs: 0,
  aborted: false,
};

/** Every dep faked: no index, no `claude`, no clipboard, no model. */
function deps(over: Partial<TuiDeps> = {}): TuiDeps {
  return {
    search: () => [],
    recentSessions: () => [],
    sync: async () => EMPTY_SYNC,
    status: () => EMPTY_STATUS,
    projectsDirMismatch: () => MISMATCH,
    sessionMatches: () => [],
    getMessage: () => null,
    semanticStatus: () => ({
      enabled: false,
      runtimeInstalled: false,
      pendingChunks: 0,
      totalChunks: 0,
      downloadMb: 0,
    }),
    enableSemantic: async () => undefined,
    topUpEmbeddings: async () => ({ embedded: 0 }),
    spawnResume: async () => 0,
    copyToClipboard: async () => true,
    now: () => Date.parse('2026-09-21T00:00:00.000Z'),
    homedir: () => '/tmp/home',
    debounceMs: 0,
    render: () => ({ waitUntilExit: async () => undefined, unmount: () => undefined }),
    writeOut: () => undefined,
    writeErr: () => undefined,
    restoreStdin: () => undefined,
    closeIndex: () => undefined,
    ...over,
  };
}

const options = (over: Partial<TuiOptions> = {}): TuiOptions => ({ query: '', noSync: true, ...over });

/** Ink renders on a timer; give the mount effect a couple of ticks to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('the picker with --no-sync and a mismatched --projects-dir', () => {
  it('shows the warning as its status line on start', async () => {
    const app = render(
      createElement(App, { options: options(), deps: deps(), onOutcome: () => undefined }),
    );
    try {
      await settle();
      // Truncated to the terminal width like every other status line, so only
      // the head of the sentence is on screen.
      expect(app.lastFrame()).toContain('--no-sync: this index was built from /tmp/recorded');
    } finally {
      app.unmount();
    }
  });

  it('clears it on the first keypress, like every other transient note', async () => {
    const app = render(
      createElement(App, { options: options(), deps: deps(), onOutcome: () => undefined }),
    );
    try {
      await settle();
      expect(app.lastFrame()).toContain('--no-sync');
      app.stdin.write('v');
      await settle();
      expect(app.lastFrame()).not.toContain('--no-sync');
    } finally {
      app.unmount();
    }
  });

  it('says nothing without --no-sync', async () => {
    const app = render(
      createElement(App, {
        options: options({ noSync: false }),
        deps: deps(),
        onOutcome: () => undefined,
      }),
    );
    try {
      await settle();
      expect(app.lastFrame()).not.toContain('--no-sync');
    } finally {
      app.unmount();
    }
  });

  it('still opens when the check itself throws', async () => {
    const app = render(
      createElement(App, {
        options: options(),
        deps: deps({
          projectsDirMismatch: () => {
            throw new Error('index is unreadable');
          },
        }),
        onOutcome: () => undefined,
      }),
    );
    try {
      await settle();
      expect(app.lastFrame()).not.toContain('index is unreadable');
      // The picker drew its prompt rather than dying on an advisory check.
      expect(app.lastFrame()?.length).toBeGreaterThan(0);
    } finally {
      app.unmount();
    }
  });

  it('shows nothing when there is no mismatch', async () => {
    const app = render(
      createElement(App, {
        options: options(),
        deps: deps({ projectsDirMismatch: () => null }),
        onOutcome: () => undefined,
      }),
    );
    try {
      await settle();
      expect(app.lastFrame()).not.toContain('--no-sync');
    } finally {
      app.unmount();
    }
  });
});
