import os from 'node:os';
import type { ReactElement } from 'react';
import { render as inkRender } from 'ink';
import type {
  IndexStatus,
  KeywordOnlySource,
  Role,
  SessionResult,
  SyncProgress,
  SyncResult,
} from '../core/index.js';
import {
  coreCloseIndex,
  coreEnableSemantic,
  coreGetMessage,
  coreProjectsDirMismatch,
  coreRecentSessions,
  coreSearch,
  coreSemanticStatus,
  coreSessionMatches,
  coreSpawnResume,
  coreStatus,
  coreSync,
  coreTopUpEmbeddings,
} from './core-bridge.js';
import { copyToClipboard } from './clipboard.js';

/**
 * How a search is run. The picker always asks for `auto` unless the caller
 * passed an explicit mode, so there is no mode switcher in the UI.
 */
export type TuiSearchMode = 'auto' | 'keyword' | 'semantic' | 'hybrid';

/** Best match first, or most recently used first. */
export type SortOrder = 'relevance' | 'recent';

/** One matching message of a session, as returned by `sessionMatches`. */
export interface MatchSnippet {
  messageId: number;
  role: Role;
  ts: string;
  text: string;
  highlights: [number, number][];
}

/** A whole message, as returned by `getMessage`. */
export interface FullMessage {
  messageId: number;
  sessionId: string;
  role: Role;
  ts: string;
  text: string;
}

/** What `semanticStatus()` says about smart search on this machine. */
export interface SemanticStatus {
  enabled: boolean;
  runtimeInstalled: boolean;
  pendingChunks: number;
  totalChunks: number;
  downloadMb: number;
}

/** Progress of `enableSemantic` / `topUpEmbeddings`. */
export interface SemanticProgress {
  phase: 'install' | 'model' | 'embed';
  done?: number | undefined;
  total?: number | undefined;
}

/** What the TUI asks the core for on every keystroke. */
export interface TuiSearchRequest {
  query: string;
  mode: TuiSearchMode;
  sort: SortOrder;
  limit: number;
  cwdPrefix?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  role?: 'user' | 'assistant' | undefined;
}

export interface TuiRecentRequest {
  limit: number;
  cwdPrefix?: string | undefined;
}

export interface TuiSyncRequest {
  projectsDir?: string | undefined;
  onProgress?: ((progress: SyncProgress) => void) | undefined;
}

export interface TuiMatchesRequest {
  sessionId: string;
  query: string;
  mode?: TuiSearchMode | undefined;
  limit?: number | undefined;
}

export interface TuiSemanticRequest {
  onProgress?: ((progress: SemanticProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/** The subset of an Ink instance `runTui` needs. */
export interface TuiRenderInstance {
  waitUntilExit: () => Promise<unknown>;
  unmount: () => void;
}

/** Options `runTui` understands. A superset of the CLI's common options. */
export interface TuiOptions {
  query: string;
  /** Overrides the picker's `auto` mode. */
  mode?: TuiSearchMode | undefined;
  /** Initial sort order; toggled with Ctrl+R. */
  sort?: SortOrder | undefined;
  limit?: number | undefined;
  cwdPrefix?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  role?: 'user' | 'assistant' | undefined;
  projectsDir?: string | undefined;
  noSync?: boolean | undefined;
  /**
   * Set when smart search is off for this run. The picker then never asks about
   * it, never starts it, and shows no line about it.
   */
  keywordOnly?: KeywordOnlySource | null | undefined;
  /** Accepted so the CLI can spread its common options; the picker ignores it. */
  json?: boolean | undefined;
}

/**
 * Everything the TUI touches outside itself. Real implementations are the
 * defaults; tests inject fakes so they never spawn `claude`, never write to
 * the clipboard and never read `~/.claude`.
 */
export interface TuiDeps {
  search: (request: TuiSearchRequest) => Promise<SessionResult[]> | SessionResult[];
  recentSessions: (request: TuiRecentRequest) => Promise<SessionResult[]> | SessionResult[];
  sync: (request: TuiSyncRequest) => Promise<SyncResult>;
  status: (request: { projectsDir?: string | undefined }) => Promise<IndexStatus> | IndexStatus;
  /**
   * The `--no-sync` sentence about a `--projects-dir` the index was not built
   * from, or null. Advisory only: the picker shows it and carries on.
   */
  projectsDirMismatch: (projectsDir?: string | undefined) => string | null;
  /** Every matching message of one session, for ← → stepping. */
  sessionMatches: (request: TuiMatchesRequest) => Promise<MatchSnippet[]> | MatchSnippet[];
  /** The whole message behind a match, for the expanded view. */
  getMessage: (messageId: number) => Promise<FullMessage | null> | FullMessage | null;
  /** Whether smart (semantic) search is on, and what it would cost to turn on. */
  semanticStatus: () => Promise<SemanticStatus> | SemanticStatus;
  /** Installs the runtime, downloads the model and indexes; cancellable. */
  enableSemantic: (request: TuiSemanticRequest) => Promise<void>;
  /** Embeds whatever is missing for already-enabled smart search. */
  topUpEmbeddings: (request: TuiSemanticRequest) => Promise<{ embedded: number }>;
  /** Runs `claude --resume <id>` in the session folder, resolving its exit code. */
  spawnResume: (request: { cwd: string; sessionId: string }) => Promise<number>;
  /** False when no clipboard tool exists. */
  copyToClipboard: (text: string) => Promise<boolean>;
  /** Injectable clock, used for relative ages. */
  now: () => number;
  homedir: () => string;
  /** Search-as-you-type debounce. */
  debounceMs: number;
  render: (node: ReactElement) => TuiRenderInstance;
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
  /** Hands the terminal back to a child process after Ink unmounts. */
  restoreStdin: () => void;
  /** Releases the SQLite handle before `claude` takes over for hours. */
  closeIndex: () => void;
}

/** Debounce used in production, per the spec. */
export const DEFAULT_DEBOUNCE_MS = 120;

/** Real implementations. `runTui` merges these with anything a caller injects. */
export function defaultDeps(): TuiDeps {
  return {
    search: (request) => coreSearch(request),
    recentSessions: (request) => coreRecentSessions(request),
    sync: (request) => coreSync(request),
    status: (request) => coreStatus(request),
    projectsDirMismatch: (projectsDir) => coreProjectsDirMismatch(projectsDir),
    sessionMatches: (request) => coreSessionMatches(request),
    getMessage: (messageId) => coreGetMessage(messageId),
    semanticStatus: () => coreSemanticStatus(),
    enableSemantic: (request) => coreEnableSemantic(request),
    topUpEmbeddings: (request) => coreTopUpEmbeddings(request),
    spawnResume: (request) => coreSpawnResume(request),
    copyToClipboard,
    now: () => Date.now(),
    homedir: () => os.homedir(),
    debounceMs: DEFAULT_DEBOUNCE_MS,
    render: (node) =>
      inkRender(node, {
        stdout: process.stdout,
        stdin: process.stdin,
        // The app handles Ctrl+C itself so it can restore the terminal first.
        exitOnCtrlC: false,
      }),
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
    restoreStdin: () => {
      const stdin = process.stdin;
      if (stdin.isTTY) {
        try {
          stdin.setRawMode(false);
        } catch {
          /* terminal already restored */
        }
      }
      stdin.pause();
    },
    closeIndex: coreCloseIndex,
  };
}
