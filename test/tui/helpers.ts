import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { IndexStatus, SessionResult, SyncResult } from '../../src/core/index.js';
import type { RunTuiOptions } from '../../src/tui/index.js';
import { runTui } from '../../src/tui/index.js';
import type { FullMessage, MatchSnippet, SemanticStatus, TuiDeps } from '../../src/tui/deps.js';

/** Frozen clock so relative ages are deterministic. */
export const NOW = Date.parse('2026-09-20T12:00:00.000Z');
export const HOME = '/Users/tester';

/** Exactly the bytes the listed terminals put on stdin. */
export const KEY = {
  escape: '\u001B',
  enter: '\r',
  tab: '\t',
  up: '\u001B[A',
  down: '\u001B[B',
  left: '\u001B[D',
  right: '\u001B[C',
  pageUp: '\u001B[5~',
  pageDown: '\u001B[6~',
  home: '\u001B[H',
  homeAlt: '\u001B[1~',
  end: '\u001B[F',
  endAlt: '\u001B[4~',
  /** The Delete key, forward delete. */
  del: '\u001B[3~',
  backspace: '\u007F',
  /** Option+Backspace on macOS terminals. */
  optBackspace: '\u001B\u007F',
  /** Option+← / Option+→ with "Esc+" profiles (Terminal.app, Ghostty). */
  escB: '\u001Bb',
  escF: '\u001Bf',
  /** Option+← / Option+→ with xterm-style profiles (iTerm2, kitty, VS Code). */
  altLeft: '\u001B[1;3D',
  altRight: '\u001B[1;3C',
  /** Ctrl+← / Ctrl+→ (Windows Terminal, VS Code, Linux terminals). */
  ctrlLeft: '\u001B[1;5D',
  ctrlRight: '\u001B[1;5C',
  /** Option+← / Option+→ with iTerm2 "meta" profiles. */
  metaLeft: '\u001B[1;9D',
  metaRight: '\u001B[1;9C',
  ctrlA: '\u0001',
  ctrlC: '\u0003',
  ctrlE: '\u0005',
  ctrlK: '\u000B',
  ctrlN: '\u000E',
  ctrlO: '\u000F',
  ctrlP: '\u0010',
  ctrlR: '\u0012',
  ctrlS: '\u0013',
  /** Cmd+Backspace, as macOS terminals send it. */
  ctrlU: '\u0015',
  ctrlW: '\u0017',
  ctrlY: '\u0019',
};

/** Bracketed paste, exactly as a terminal wraps it. */
export const paste = (text: string): string => `\u001B[200~${text}\u001B[201~`;

export const tick = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function makeResult(overrides: Partial<SessionResult> = {}): SessionResult {
  const sessionId = overrides.sessionId ?? 'sess-1';
  const cwd = overrides.cwd ?? `${HOME}/code/dashboard`;
  return {
    sessionId,
    title: 'Storyboards repos comparison',
    cwd,
    cwdExists: true,
    gitBranch: 'main',
    firstTs: '2026-09-10T09:00:00.000Z',
    lastTs: '2026-09-10T12:00:00.000Z',
    messageCount: 12,
    matchCount: 3,
    score: 1.5,
    sources: ['keyword'],
    modeUsed: 'keyword',
    snippet: {
      messageId: 101,
      role: 'user',
      ts: '2026-09-10T12:00:00.000Z',
      text: 'I can record with OBS, screen recording with my voice',
      highlights: [[6, 12]],
    },
    resumeCommand: `cd '${cwd}' && claude --resume '${sessionId}'`,
    ...overrides,
  };
}

export function makeMatch(overrides: Partial<MatchSnippet> = {}): MatchSnippet {
  return {
    messageId: 201,
    role: 'user',
    ts: '2026-09-10T12:00:00.000Z',
    text: 'I can record with OBS, screen recording with my voice',
    highlights: [[6, 12]],
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<FullMessage> = {}): FullMessage {
  return {
    messageId: 201,
    sessionId: 'sess-1',
    role: 'user',
    ts: '2026-09-10T12:00:00.000Z',
    text: 'I can record with OBS, screen recording with my voice and the video there.',
    ...overrides,
  };
}

export function makeSemanticStatus(overrides: Partial<SemanticStatus> = {}): SemanticStatus {
  return {
    enabled: false,
    runtimeInstalled: false,
    pendingChunks: 0,
    totalChunks: 0,
    downloadMb: 165,
    ...overrides,
  };
}

export function makeStatus(overrides: Partial<IndexStatus> = {}): IndexStatus {
  return {
    projectsDir: '/tmp/projects',
    projectsDirExists: true,
    projectsDirHint: null,
    dbPath: '/tmp/home/index.db',
    dbSizeBytes: 1024,
    sessions: 42,
    messages: 900,
    chunks: 300,
    chunksEmbedded: 0,
    embeddingModel: null,
    embeddingDims: null,
    transformersAvailable: true,
    availableModes: ['auto', 'keyword'],
    defaultEmbeddingModel: 'Xenova/all-MiniLM-L6-v2',
    semantic: makeSemanticStatus(),
    ...overrides,
  };
}

export function makeSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    scannedFiles: 3,
    indexedFiles: 0,
    skippedFiles: 3,
    removedFiles: 0,
    skippedSessions: 0,
    failedFiles: 0,
    sessions: 42,
    messages: 900,
    chunks: 300,
    durationMs: 3100,
    aborted: false,
    ...overrides,
  };
}

class FakeStdout extends EventEmitter {
  columns: number;
  rows: number;
  readonly frames: string[] = [];
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write = (frame: string): void => {
    this.frames.push(frame);
  };
  lastFrame = (): string => this.frames[this.frames.length - 1] ?? '';
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const value = this.data;
    this.data = null;
    return value;
  };
  send = (data: string): void => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };
}

export interface HarnessOptions extends Partial<RunTuiOptions> {
  columns?: number;
  rows?: number;
  deps?: Partial<TuiDeps>;
}

export interface Harness {
  exitCode: Promise<number>;
  frames: string[];
  lastFrame: () => string;
  /** Frame before the app unmounted (the final frame is blank). */
  liveFrame: () => string;
  send: (data: string, waitMs?: number) => Promise<void>;
  type: (text: string, waitMs?: number) => Promise<void>;
  resize: (columns: number, rows: number) => Promise<void>;
  out: string[];
  err: string[];
  restored: () => number;
  closed: () => number;
  spawned: { cwd: string; sessionId: string }[];
  copied: string[];
}

/**
 * Runs the real `runTui` against fake streams and injected dependencies:
 * nothing here spawns `claude`, touches the clipboard or reads `~/.claude`.
 */
export function startTui(options: HarnessOptions = {}): Harness {
  const { columns = 100, rows = 24, deps: depOverrides = {}, ...tuiOptions } = options;
  const stdout = new FakeStdout(columns, rows);
  const stdin = new FakeStdin();
  const out: string[] = [];
  const err: string[] = [];
  const spawned: { cwd: string; sessionId: string }[] = [];
  const copied: string[] = [];
  let restored = 0;
  let closed = 0;

  const deps: Partial<TuiDeps> = {
    search: () => [],
    recentSessions: () => [],
    sync: async () => makeSyncResult(),
    status: () => makeStatus(),
    sessionMatches: () => [],
    getMessage: () => null,
    // A keyword-only install by default: the picker must then say nothing at
    // all about smart search.
    semanticStatus: () => makeSemanticStatus(),
    enableSemantic: async () => {
      throw new Error('enableSemantic not stubbed');
    },
    topUpEmbeddings: async () => {
      throw new Error('topUpEmbeddings not stubbed');
    },
    spawnResume: async (request) => {
      spawned.push(request);
      return 0;
    },
    copyToClipboard: async (text) => {
      copied.push(text);
      return true;
    },
    now: () => NOW,
    homedir: () => HOME,
    debounceMs: 5,
    writeOut: (text) => {
      out.push(text);
    },
    writeErr: (text) => {
      err.push(text);
    },
    restoreStdin: () => {
      restored += 1;
    },
    closeIndex: () => {
      closed += 1;
    },
    render: (node) =>
      inkRender(node, {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }),
    ...depOverrides,
  };

  const exitCode = runTui({
    query: '',
    limit: 10,
    noSync: false,
    json: false,
    ...tuiOptions,
    deps,
  } as RunTuiOptions);

  const send = async (data: string, waitMs = 40): Promise<void> => {
    stdin.send(data);
    await tick(waitMs);
  };

  return {
    exitCode,
    frames: stdout.frames,
    lastFrame: stdout.lastFrame,
    liveFrame: () => {
      for (let i = stdout.frames.length - 1; i >= 0; i -= 1) {
        const frame = stdout.frames[i] ?? '';
        if (frame.trim() !== '') return frame;
      }
      return '';
    },
    send,
    type: async (text, waitMs = 30) => {
      for (const ch of text) await send(ch, waitMs);
    },
    resize: async (nextColumns, nextRows) => {
      stdout.columns = nextColumns;
      stdout.rows = nextRows;
      stdout.emit('resize');
      await tick();
    },
    out,
    err,
    restored: () => restored,
    closed: () => closed,
    spawned,
    copied,
  };
}

/**
 * Waits for the UI to stop changing rather than for a fixed number of
 * milliseconds. Startup does several awaits (status, sync, status, debounce),
 * so a fixed sleep is a race on a loaded machine.
 */
export async function settle(tui: Harness, minMs = 60, maxMs = 2000): Promise<void> {
  const started = Date.now();
  let previous = '';
  let stable = 0;
  for (;;) {
    await tick(20);
    const frame = tui.liveFrame();
    stable = frame === previous ? stable + 1 : 0;
    previous = frame;
    if (Date.now() - started >= minMs && stable >= 2) return;
    if (Date.now() - started >= maxMs) return;
  }
}

/** Longest visible line of a frame, ignoring ANSI styling. */
export function widestLine(frame: string): number {
  // eslint-disable-next-line no-control-regex
  const plain = frame.replace(/\u001B\[[0-9;]*m/g, '');
  return Math.max(0, ...plain.split('\n').map((line) => [...line].length));
}

/** A frame with its styling removed, for line-by-line assertions. */
export function plainFrame(frame: string): string {
  // eslint-disable-next-line no-control-regex
  return frame.replace(/\u001B\[[0-9;]*m/g, '');
}
