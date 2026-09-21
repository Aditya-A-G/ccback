import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionResult } from '../../src/core/index.js';
import { spawnResume, UserError } from '../../src/core/index.js';
import { defaultDeps } from '../../src/tui/deps.js';
import type { MatchSnippet, TuiSearchRequest } from '../../src/tui/deps.js';
import {
  HOME,
  KEY,
  makeMatch,
  makeMessage,
  makeResult,
  makeSemanticStatus,
  makeStatus,
  makeSyncResult,
  paste,
  plainFrame,
  settle,
  startTui,
  tick,
  widestLine,
} from './helpers.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const squash = (text: string): string => plainFrame(text).replace(/\s+/g, ' ');

function manyResults(count: number): SessionResult[] {
  return Array.from({ length: count }, (_, i) =>
    makeResult({
      sessionId: `sess-${i + 1}`,
      title: `Session ${String(i + 1).padStart(2, '0')}`,
      cwd: `${HOME}/code/project-${i + 1}`,
    }),
  );
}

function manyMatches(count: number): MatchSnippet[] {
  return Array.from({ length: count }, (_, i) =>
    makeMatch({
      messageId: 500 + i,
      text: `match number ${i + 1} about recording`,
      highlights: [[21 + String(i + 1).length, 30 + String(i + 1).length]],
    }),
  );
}

describe('the recent list', () => {
  it('shows at most five recent sessions under a Recent heading', async () => {
    const asked: number[] = [];
    const tui = startTui({
      deps: {
        recentSessions: (request) => {
          asked.push(request.limit);
          return manyResults(8);
        },
      },
    });
    await settle(tui);

    const frame = plainFrame(tui.liveFrame());
    expect(asked).toEqual([5]);
    expect(frame).toContain('Recent');
    const rows = frame.split('\n').filter((line) => /Session \d\d/.test(line));
    expect(rows).toHaveLength(5);
    expect(frame).toContain('Session 05');
    expect(frame).not.toContain('Session 06');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('shows the last folder segment in the row and the full path in the preview', async () => {
    const tui = startTui({
      deps: {
        recentSessions: () => [
          makeResult({ sessionId: 'a', cwd: `${HOME}/Documents/coding/personal/dashboard` }),
        ],
      },
    });
    await settle(tui);

    const frame = plainFrame(tui.liveFrame());
    const row = frame.split('\n').find((line) => line.includes('Storyboards'))!;
    expect(row).toContain('dashboard');
    expect(row).not.toContain('~/');
    expect(row).not.toContain('main'); // no git branch anywhere
    // The full path appears once, as the last line of the preview.
    expect(frame).toContain('~/Documents/coding/personal/dashboard');
    expect(squash(frame)).not.toContain('messages mention');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('disambiguates two folders that end with the same segment', async () => {
    const tui = startTui({
      deps: {
        recentSessions: () => [
          makeResult({ sessionId: 'a', title: 'First', cwd: `${HOME}/code/app` }),
          makeResult({ sessionId: 'b', title: 'Second', cwd: `${HOME}/work/app` }),
        ],
      },
    });
    await settle(tui);

    const frame = plainFrame(tui.liveFrame());
    expect(frame).toContain('code/app');
    expect(frame).toContain('work/app');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('has no mode switcher of any kind', async () => {
    const tui = startTui({ deps: { recentSessions: () => [makeResult()] } });
    await settle(tui);

    const frame = squash(tui.liveFrame());
    expect(frame).not.toContain('keyword');
    expect(frame).not.toContain('hybrid');
    expect(frame).not.toContain('semantic');
    expect(frame).not.toContain('Tab');
    expect(frame).not.toContain('⇥');
    // The only ▸ is the row marker, and it never sits next to a mode name.
    expect(frame).toContain('▸ Storyboards');

    // Tab does nothing at all, and types nothing.
    await tui.send(KEY.tab);
    expect(plainFrame(tui.liveFrame())).toContain(' › █');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});

describe('searching', () => {
  it('opens pre-filled, searches in auto mode and passes the filters through', async () => {
    const requests: TuiSearchRequest[] = [];
    const tui = startTui({
      query: 'recording videos',
      cwdPrefix: '/Users/tester/code',
      since: '2026-01-01',
      until: '2026-12-31',
      role: 'user',
      deps: {
        search: (request) => {
          requests.push(request);
          return [makeResult({ title: 'Recording setup' })];
        },
      },
    });
    await settle(tui);

    expect(requests[0]).toMatchObject({
      query: 'recording videos',
      mode: 'auto',
      sort: 'relevance',
      cwdPrefix: '/Users/tester/code',
      since: '2026-01-01',
      until: '2026-12-31',
      role: 'user',
    });
    expect(plainFrame(tui.liveFrame())).toContain('recording videos█');
    expect(plainFrame(tui.liveFrame())).toContain('Recording setup');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('searches as you type and discards a stale response', async () => {
    const pending: { query: string; resolve: (results: SessionResult[]) => void }[] = [];
    const tui = startTui({
      deps: {
        search: (request) =>
          new Promise<SessionResult[]>((resolve) => {
            pending.push({ query: request.query, resolve });
          }),
      },
    });
    await tick(60);

    await tui.send('a');
    await tui.send('b');
    expect(pending.map((p) => p.query)).toEqual(['a', 'ab']);

    pending[1]!.resolve([makeResult({ sessionId: 'new', title: 'NEWER RESULT' })]);
    await tick(40);
    pending[0]!.resolve([makeResult({ sessionId: 'old', title: 'STALE RESULT' })]);
    await tick(40);

    expect(plainFrame(tui.liveFrame())).toContain('NEWER RESULT');
    expect(plainFrame(tui.liveFrame())).not.toContain('STALE RESULT');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('types every printable key, including c, o, r and s', async () => {
    const queries: string[] = [];
    const tui = startTui({
      deps: {
        search: (request) => {
          queries.push(request.query);
          return [];
        },
      },
    });
    await tick(60);

    await tui.type('coors');
    expect(queries[queries.length - 1]).toBe('coors');
    expect(plainFrame(tui.liveFrame())).toContain('coors█');
    expect(tui.spawned).toEqual([]);
    expect(tui.copied).toEqual([]);

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('shows a clear state when nothing matches', async () => {
    const tui = startTui({ deps: { search: () => [] } });
    await tick(60);
    await tui.send('z');
    expect(plainFrame(tui.liveFrame())).toContain('No matching sessions.');
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('scrolls a long result list while keeping at most eight rows', async () => {
    const results = manyResults(12);
    const tui = startTui({ deps: { search: () => results } });
    await tick(60);
    await tui.send('s', 60);

    let frame = plainFrame(tui.liveFrame());
    expect(frame.split('\n').filter((line) => /Session \d\d/.test(line))).toHaveLength(8);
    expect(frame).toContain('▸ Session 01');
    expect(frame).not.toContain('Session 09');

    for (let i = 0; i < 8; i += 1) await tui.send(KEY.down, 25);
    frame = plainFrame(tui.liveFrame());
    expect(frame).toContain('▸ Session 09');
    expect(frame).not.toContain('Session 01');

    await tui.send(KEY.ctrlP, 25);
    expect(plainFrame(tui.liveFrame())).toContain('▸ Session 08');
    await tui.send(KEY.up, 25);
    expect(plainFrame(tui.liveFrame())).toContain('▸ Session 07');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});

describe('line editing in the search box', () => {
  const editor = () =>
    startTui({
      deps: { search: () => [], recentSessions: () => [] },
    });

  it('moves the cursor with ← → when there are no results to step through', async () => {
    const tui = editor();
    await tick(60);
    await tui.type('recording');
    await tui.send(KEY.left);
    await tui.send(KEY.left);
    await tui.send('X', 60);
    // The cursor glyph sits between the inserted X and the rest of the word.
    expect(plainFrame(tui.liveFrame())).toContain('recordiX▏ng');
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('jumps words with ESC-b / ESC-f, Option+arrows and Ctrl+arrows', async () => {
    const tui = editor();
    await tick(60);
    await tui.type('alpha beta');
    const line = (): string => plainFrame(tui.liveFrame()).split('\n')[0]!;

    await tui.send(KEY.escB, 50); // \x1bb
    expect(line()).toContain(' › alpha ▏beta');
    await tui.send(KEY.escB, 50);
    expect(line()).toContain(' › ▏alpha beta');
    await tui.send(KEY.escF, 50); // \x1bf
    expect(line()).toContain(' › alpha▏ beta');

    await tui.send(KEY.altLeft, 50); // \x1b[1;3D
    expect(line()).toContain(' › ▏alpha beta');
    await tui.send(KEY.ctrlRight, 50); // \x1b[1;5C
    expect(line()).toContain(' › alpha▏ beta');
    await tui.send(KEY.metaRight, 50); // \x1b[1;9C
    expect(line()).toContain(' › alpha beta█');
    await tui.send(KEY.metaLeft, 50); // \x1b[1;9D
    expect(line()).toContain(' › alpha ▏beta');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('jumps to line start and end with Ctrl+A, Home and End', async () => {
    const tui = editor();
    await tick(60);
    await tui.type('videos');
    const line = (): string => plainFrame(tui.liveFrame()).split('\n')[0]!;

    await tui.send(KEY.ctrlA, 50);
    expect(line()).toContain(' › ▏videos');
    await tui.send(KEY.end, 50); // \x1b[F
    expect(line()).toContain(' › videos█');
    await tui.send(KEY.home, 50); // \x1b[H
    expect(line()).toContain(' › ▏videos');
    await tui.send(KEY.endAlt, 50); // \x1b[4~
    expect(line()).toContain(' › videos█');
    await tui.send(KEY.homeAlt, 50); // \x1b[1~
    expect(line()).toContain(' › ▏videos');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('deletes a word backwards with Option+Backspace and with Ctrl+W', async () => {
    const tui = editor();
    await tick(60);
    await tui.type('recording videos today');

    await tui.send(KEY.optBackspace, 60);
    expect(plainFrame(tui.liveFrame())).toContain('recording videos █');
    expect(plainFrame(tui.liveFrame())).not.toContain('today');

    await tui.send(KEY.ctrlW, 60);
    expect(plainFrame(tui.liveFrame())).toContain('recording █');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('clears to the line start with Ctrl+U and kills to the end with Ctrl+K', async () => {
    const tui = editor();
    await tick(60);
    await tui.type('recording videos');

    await tui.send(KEY.escB); // cursor before "videos"
    await tui.send(KEY.ctrlU, 60);
    expect(plainFrame(tui.liveFrame())).toContain(' › ▏videos');

    await tui.send(KEY.ctrlK, 60);
    expect(plainFrame(tui.liveFrame())).toContain(' › █');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('forward-deletes with the Delete key and backspaces with Backspace', async () => {
    const tui = editor();
    await tick(60);
    await tui.type('abcd');
    await tui.send(KEY.left);
    await tui.send(KEY.left);
    expect(plainFrame(tui.liveFrame())).toContain(' › ab▏cd');
    await tui.send(KEY.del, 60); // \x1b[3~ deletes forward
    expect(plainFrame(tui.liveFrame())).toContain(' › ab▏d');
    await tui.send(KEY.backspace, 60);
    expect(plainFrame(tui.liveFrame())).toContain(' › a▏d');
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('pastes at the cursor, turning newlines into spaces', async () => {
    const queries: string[] = [];
    const tui = startTui({
      deps: {
        search: (request) => {
          queries.push(request.query);
          return [];
        },
      },
    });
    await tick(60);

    await tui.type('ab');
    await tui.send(KEY.left);
    await tui.send(paste('one\ntwo'), 80);
    expect(queries[queries.length - 1]).toBe('aone twob');
    expect(plainFrame(tui.liveFrame())).toContain('aone two▏b');

    // An unbracketed multi-character chunk behaves the same way.
    await tui.send('three four', 80);
    expect(queries[queries.length - 1]).toBe('aone twothree fourb');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('keeps Ctrl+S inert: no smart-search prompt, nothing typed', async () => {
    let enabled = 0;
    const tui = startTui({
      deps: {
        enableSemantic: async () => {
          enabled += 1;
        },
      },
    });
    await settle(tui);
    await tui.send(KEY.ctrlS, 60);

    expect(plainFrame(tui.liveFrame())).toContain(' › █');
    expect(squash(tui.liveFrame())).not.toContain('smart search');
    expect(enabled).toBe(0);

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});

describe('stepping through a session’s matches', () => {
  const withMatches = (matches: MatchSnippet[], results = [makeResult({ sessionId: 'a' })]) =>
    startTui({
      deps: {
        search: () => results,
        sessionMatches: () => matches,
      },
    });

  it('shows the match counter and walks it with ← →', async () => {
    const tui = withMatches(manyMatches(7));
    await tick(60);
    await tui.send('r', 80);

    expect(squash(tui.liveFrame())).toContain('match 1 of 7 ← →');
    expect(plainFrame(tui.liveFrame())).toContain('match number 1');

    await tui.send(KEY.right, 60);
    expect(squash(tui.liveFrame())).toContain('match 2 of 7 ← →');
    expect(plainFrame(tui.liveFrame())).toContain('match number 2');

    await tui.send(KEY.right, 60);
    await tui.send(KEY.left, 60);
    expect(squash(tui.liveFrame())).toContain('match 2 of 7');

    // The text cursor did not move: typing still appends.
    await tui.send('x', 80);
    expect(plainFrame(tui.liveFrame())).toContain('rx█');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('hides the arrows and the counter when a session has one match', async () => {
    const tui = withMatches([makeMatch({ text: 'the only match' })]);
    await tick(60);
    await tui.send('r', 80);

    const frame = squash(tui.liveFrame());
    expect(frame).toContain('the only match');
    expect(frame).not.toContain('match 1 of 1');
    expect(frame).not.toContain('← →');
    expect(frame).not.toContain('matches');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('resets to match 1 when the selected session changes', async () => {
    const tui = startTui({
      deps: {
        search: () => [makeResult({ sessionId: 'a' }), makeResult({ sessionId: 'b', title: 'Second' })],
        sessionMatches: ({ sessionId }) =>
          manyMatches(4).map((match) => ({ ...match, text: `${sessionId} ${match.text}` })),
      },
    });
    await tick(60);
    await tui.send('r', 80);
    await tui.send(KEY.right, 60);
    expect(squash(tui.liveFrame())).toContain('match 2 of 4');

    await tui.send(KEY.down, 80);
    expect(squash(tui.liveFrame())).toContain('match 1 of 4');
    expect(plainFrame(tui.liveFrame())).toContain('b match number 1');

    await tui.send(KEY.up, 80);
    expect(squash(tui.liveFrame())).toContain('match 1 of 4');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('caches matches per session and query, and asks once', async () => {
    const asked: string[] = [];
    const tui = startTui({
      deps: {
        search: () => [makeResult({ sessionId: 'a' }), makeResult({ sessionId: 'b', title: 'Second' })],
        sessionMatches: ({ sessionId, query }) => {
          asked.push(`${query}:${sessionId}`);
          return manyMatches(3);
        },
      },
    });
    await tick(60);
    await tui.send('r', 80);
    await tui.send(KEY.down, 80);
    await tui.send(KEY.up, 80);
    await tui.send(KEY.down, 80);

    expect(asked).toEqual(['r:a', 'r:b']);

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('discards matches that arrive after the user has moved on', async () => {
    const pending: { sessionId: string; resolve: (list: MatchSnippet[]) => void }[] = [];
    const tui = startTui({
      deps: {
        search: () => [makeResult({ sessionId: 'a' }), makeResult({ sessionId: 'b', title: 'Second' })],
        sessionMatches: ({ sessionId }) =>
          new Promise<MatchSnippet[]>((resolve) => {
            pending.push({ sessionId, resolve });
          }),
      },
    });
    await tick(60);
    await tui.send('r', 80);
    await tui.send(KEY.down, 80);
    expect(pending.map((p) => p.sessionId)).toEqual(['a', 'b']);

    pending[1]!.resolve([makeMatch({ text: 'B MATCH' })]);
    await tick(60);
    // The abandoned session answers late; its matches must not appear.
    pending[0]!.resolve(manyMatches(9).map((match) => ({ ...match, text: 'A MATCH' })));
    await tick(60);

    const frame = squash(tui.liveFrame());
    expect(frame).toContain('B MATCH');
    expect(frame).not.toContain('A MATCH');
    expect(frame).not.toContain('of 9');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('falls back to the search snippet when sessionMatches fails', async () => {
    const tui = startTui({
      deps: {
        search: () => [makeResult()],
        sessionMatches: () => {
          throw new Error('matches are unavailable');
        },
      },
    });
    await tick(60);
    await tui.send('r', 80);

    const frame = squash(tui.liveFrame());
    expect(frame).toContain('I can record with OBS');
    expect(frame).not.toContain('unavailable');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});

describe('the full message view', () => {
  const longText = Array.from({ length: 60 }, (_, i) => `line-${String(i + 1).padStart(2, '0')} of the message`).join(
    '\n',
  );

  const expandable = (overrides: Parameters<typeof startTui>[0] = {}) =>
    startTui({
      ...overrides,
      deps: {
        search: () => [makeResult({ sessionId: 'a' }), makeResult({ sessionId: 'b', title: 'Second session' })],
        sessionMatches: () => [
          makeMatch({ messageId: 301, text: 'line-40 of the message', highlights: [[0, 7]] }),
          makeMatch({ messageId: 302, text: 'another match' }),
        ],
        getMessage: (messageId) => makeMessage({ messageId, text: longText }),
        ...overrides.deps,
      },
    });

  it('collapses the list to one row and shows the message, scrolled to the match', async () => {
    const tui = expandable();
    await tick(60);
    await tui.send('r', 80);
    expect(plainFrame(tui.liveFrame())).toContain('Second session');

    await tui.send(KEY.ctrlE, 80);
    const frame = plainFrame(tui.liveFrame());
    expect(frame).not.toContain('Second session');
    expect(frame).toContain('▸ Storyboards');
    // Opened on the matched line rather than at the top.
    expect(frame).toContain('line-40');
    expect(frame).not.toContain('line-01');
    expect(squash(frame)).toContain('^E list');

    await tui.send(KEY.escape, 80);
    expect(plainFrame(tui.liveFrame())).toContain('Second session');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('scrolls with ↑↓ and PageUp/PageDown, and Ctrl+E returns to the list', async () => {
    const tui = expandable();
    await tick(60);
    await tui.send('r', 80);
    await tui.send(KEY.ctrlE, 80);

    const firstLine = (): string =>
      plainFrame(tui.liveFrame())
        .split('\n')
        .find((line) => line.includes('of the message'))!
        .trim();
    const started = firstLine();

    await tui.send(KEY.down, 60);
    expect(firstLine()).not.toBe(started);
    await tui.send(KEY.up, 60);
    expect(firstLine()).toBe(started);

    const lineNumber = (): number => Number(firstLine().slice(5, 7));
    const from = lineNumber();
    await tui.send(KEY.pageDown, 60);
    expect(lineNumber()).toBeGreaterThan(from);
    const afterPage = lineNumber();
    await tui.send(KEY.pageUp, 60);
    expect(lineNumber()).toBeLessThan(afterPage);

    // Scrolling stops at the top and at the bottom.
    for (let i = 0; i < 12; i += 1) await tui.send(KEY.pageUp, 15);
    expect(plainFrame(tui.liveFrame())).toContain('line-01');
    for (let i = 0; i < 12; i += 1) await tui.send(KEY.pageDown, 15);
    expect(plainFrame(tui.liveFrame())).toContain('line-60');

    await tui.send(KEY.ctrlE, 80);
    expect(plainFrame(tui.liveFrame())).toContain('Second session');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('still steps matches with ← → while expanded', async () => {
    const tui = expandable();
    await tick(60);
    await tui.send('r', 80);
    await tui.send(KEY.ctrlE, 80);
    expect(squash(tui.liveFrame())).toContain('match 1 of 2');

    await tui.send(KEY.right, 80);
    expect(squash(tui.liveFrame())).toContain('match 2 of 2');

    await tui.send(KEY.escape);
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('resumes straight from the expanded view', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-tui-cwd-'));
    tempDirs.push(workdir);
    const tui = startTui({
      deps: {
        search: () => [makeResult({ sessionId: 'sess-42', cwd: workdir })],
        sessionMatches: () => [makeMatch({ messageId: 301 })],
        getMessage: () => makeMessage({ messageId: 301, text: 'short message' }),
        spawnResume: async (request) => {
          tui.spawned.push(request);
          return 5;
        },
      },
    });
    await tick(60);
    await tui.send('r', 80);
    await tui.send(KEY.ctrlE, 80);
    await tui.send(KEY.enter, 40);

    expect(await tui.exitCode).toBe(5);
    expect(tui.spawned).toEqual([{ cwd: workdir, sessionId: 'sess-42' }]);
  });

  it('says so, instead of crashing, when the message cannot be read', async () => {
    const tui = expandable({
      deps: {
        getMessage: () => {
          throw new Error('message gone');
        },
      },
    });
    await tick(60);
    await tui.send('r', 80);
    await tui.send(KEY.ctrlE, 80);

    expect(squash(tui.liveFrame())).toContain('(message not available)');

    await tui.send(KEY.escape);
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});

describe('sort order', () => {
  it('toggles with Ctrl+R, re-queries and says which order it is in', async () => {
    const sorts: string[] = [];
    const tui = startTui({
      deps: {
        search: (request) => {
          sorts.push(request.sort);
          return [makeResult({ sessionId: 'a' }), makeResult({ sessionId: 'b', title: 'Second' })];
        },
      },
    });
    await tick(60);
    await tui.send('r', 80);
    expect(squash(tui.liveFrame())).toContain('^R recent');

    await tui.send(KEY.down, 60); // selection on the second session
    await tui.send(KEY.ctrlR, 100);
    expect(sorts[sorts.length - 1]).toBe('recent');
    // The label names the order it will switch to, not the one already in force.
    expect(squash(tui.liveFrame())).toContain('^R best');
    // The same session stays selected across the re-query.
    expect(plainFrame(tui.liveFrame())).toContain('▸ Second');

    await tui.send(KEY.ctrlR, 100);
    expect(sorts[sorts.length - 1]).toBe('relevance');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('honours the sort the caller asked for', async () => {
    const sorts: string[] = [];
    const tui = startTui({
      query: 'recording',
      sort: 'recent',
      deps: {
        search: (request) => {
          sorts.push(request.sort);
          return [makeResult()];
        },
      },
    });
    await settle(tui);
    expect(sorts[0]).toBe('recent');
    expect(squash(tui.liveFrame())).toContain('^R best');
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('offers no sort toggle while browsing recent sessions', async () => {
    const tui = startTui({ deps: { recentSessions: () => [makeResult()] } });
    await settle(tui);
    expect(squash(tui.liveFrame())).not.toContain('^R ');
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});

describe('smart search sets itself up', () => {
  it('says nothing at all when the runtime is not installed', async () => {
    let enabled = 0;
    let toppedUp = 0;
    const tui = startTui({
      deps: {
        recentSessions: () => [makeResult()],
        semanticStatus: () => makeSemanticStatus({ runtimeInstalled: false, pendingChunks: 900 }),
        enableSemantic: async () => {
          enabled += 1;
        },
        topUpEmbeddings: async () => {
          toppedUp += 1;
          return { embedded: 0 };
        },
      },
    });
    await settle(tui);

    expect(enabled + toppedUp).toBe(0);
    expect(squash(tui.liveFrame()).toLowerCase()).not.toContain('smart');
    expect(squash(tui.liveFrame())).not.toContain('MB');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('starts on its own on first run, shows progress, then silently re-queries', async () => {
    let searches = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tui = startTui({
      query: 'recording',
      deps: {
        search: () => {
          searches += 1;
          return [makeResult({ sessionId: 'a' }), makeResult({ sessionId: 'b', title: 'Second' })];
        },
        semanticStatus: () =>
          makeSemanticStatus({ enabled: false, runtimeInstalled: true, pendingChunks: 12807, totalChunks: 12807 }),
        enableSemantic: async ({ onProgress }) => {
          onProgress?.({ phase: 'model' });
          await tick(20);
          onProgress?.({ phase: 'embed', done: 1240, total: 12807 });
          await gate;
        },
      },
    });
    await settle(tui);

    expect(squash(tui.liveFrame())).toContain('Setting up smart search… 1240/12807');
    // Typing is never blocked by the background work.
    await tui.send(KEY.down, 60);
    expect(plainFrame(tui.liveFrame())).toContain('▸ Second');
    const before = searches;

    release();
    await settle(tui);
    expect(squash(tui.liveFrame())).not.toContain('Setting up smart search');
    expect(searches).toBeGreaterThan(before);
    // The user is left exactly where they were.
    expect(plainFrame(tui.liveFrame())).toContain('▸ Second');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('tops up quietly when smart search is already on', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enabled = 0;
    const tui = startTui({
      deps: {
        recentSessions: () => [makeResult()],
        semanticStatus: () => makeSemanticStatus({ enabled: true, runtimeInstalled: true, pendingChunks: 40 }),
        enableSemantic: async () => {
          enabled += 1;
        },
        topUpEmbeddings: async ({ onProgress }) => {
          onProgress?.({ phase: 'embed', done: 10, total: 40 });
          await gate;
          return { embedded: 40 };
        },
      },
    });
    await settle(tui);

    expect(squash(tui.liveFrame())).toContain('Updating smart search…');
    expect(squash(tui.liveFrame())).not.toContain('downloading model');
    expect(enabled).toBe(0);

    release();
    await settle(tui);
    expect(squash(tui.liveFrame())).not.toContain('Updating smart search');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('does nothing when there is nothing pending', async () => {
    let calls = 0;
    const tui = startTui({
      deps: {
        recentSessions: () => [makeResult()],
        semanticStatus: () => makeSemanticStatus({ enabled: true, runtimeInstalled: true, pendingChunks: 0 }),
        topUpEmbeddings: async () => {
          calls += 1;
          return { embedded: 0 };
        },
      },
    });
    await settle(tui);
    expect(calls).toBe(0);
    expect(squash(tui.liveFrame()).toLowerCase()).not.toContain('smart search');
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('reports a failure on one dim line and keeps working', async () => {
    const tui = startTui({
      deps: {
        recentSessions: () => [makeResult()],
        semanticStatus: () => makeSemanticStatus({ runtimeInstalled: true, pendingChunks: 10 }),
        enableSemantic: async () => {
          throw new Error('offline: model download failed');
        },
      },
    });
    await settle(tui);

    const frame = squash(tui.liveFrame());
    expect(frame).toContain('Smart search unavailable: offline: model download failed. Keyword search still works.');
    expect(plainFrame(tui.liveFrame())).toContain('Storyboards');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('aborts the background work on quit and still exits cleanly', async () => {
    let aborted = 0;
    const tui = startTui({
      deps: {
        recentSessions: () => [makeResult()],
        semanticStatus: () => makeSemanticStatus({ runtimeInstalled: true, pendingChunks: 99 }),
        enableSemantic: ({ signal }) =>
          new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => {
              aborted += 1;
              resolve();
            });
          }),
      },
    });
    await settle(tui);
    expect(squash(tui.liveFrame())).toContain('Setting up smart search');

    await tui.send(KEY.escape, 60);
    expect(await tui.exitCode).toBe(0);
    expect(aborted).toBe(1);
    expect(tui.restored()).toBe(1);
  });

  it('aborts the background work before resuming', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-tui-cwd-'));
    tempDirs.push(workdir);
    const order: string[] = [];
    const tui = startTui({
      deps: {
        recentSessions: () => [makeResult({ sessionId: 'sess-1', cwd: workdir })],
        semanticStatus: () => makeSemanticStatus({ enabled: true, runtimeInstalled: true, pendingChunks: 99 }),
        topUpEmbeddings: ({ signal }) =>
          new Promise<{ embedded: number }>((resolve) => {
            signal?.addEventListener('abort', () => {
              order.push('aborted');
              resolve({ embedded: 3 });
            });
          }),
        spawnResume: async (request) => {
          order.push('spawned');
          tui.spawned.push(request);
          return 0;
        },
      },
    });
    await settle(tui);
    await tui.send(KEY.enter, 60);

    expect(await tui.exitCode).toBe(0);
    expect(order).toEqual(['aborted', 'spawned']);
  });
});

describe('resume', () => {
  it('Enter resumes the selected session and resolves with the spawner exit code', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-tui-cwd-'));
    tempDirs.push(workdir);
    const result = makeResult({ sessionId: 'sess-42', cwd: workdir, cwdExists: true });
    const tui = startTui({
      deps: {
        recentSessions: () => [result],
        spawnResume: async (request) => {
          tui.spawned.push(request);
          return 7;
        },
      },
    });
    await settle(tui);
    await tui.send(KEY.enter, 40);

    expect(await tui.exitCode).toBe(7);
    expect(tui.spawned).toEqual([{ cwd: workdir, sessionId: 'sess-42' }]);
    expect(tui.restored()).toBe(1);
    expect(tui.closed()).toBe(1);
  });

  it('does not spawn when the folder is gone and says so', async () => {
    const result = makeResult({ cwd: '/gone/project', cwdExists: false });
    const tui = startTui({ deps: { recentSessions: () => [result] } });
    await settle(tui);

    await tui.send(KEY.enter);
    expect(tui.spawned).toEqual([]);
    const frame = squash(tui.liveFrame());
    expect(frame).toContain('Folder no longer exists: /gone/project');
    expect(frame).toContain('^Y');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
    expect(tui.spawned).toEqual([]);
  });

  it('prints the command instead of crashing when claude is not on PATH', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-tui-cwd-'));
    tempDirs.push(workdir);
    const result = makeResult({ sessionId: 'sess-9', cwd: workdir });
    const tui = startTui({
      deps: {
        recentSessions: () => [result],
        spawnResume: async () => {
          throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
        },
      },
    });
    await settle(tui);
    await tui.send(KEY.enter, 40);

    expect(await tui.exitCode).toBe(2);
    expect(tui.err.join('')).toContain('claude is not on your PATH');
    expect(tui.err.join('')).toContain(result.resumeCommand);
  });

  it('blames the folder, not the PATH, when the cwd vanished before the spawn', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-tui-gone-'));
    tempDirs.push(workdir);
    const result = makeResult({ sessionId: 'sess-10', cwd: workdir });
    const tui = startTui({
      deps: {
        recentSessions: () => [result],
        spawnResume: async () => {
          fs.rmSync(workdir, { recursive: true, force: true });
          throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
        },
      },
    });
    await settle(tui);
    await tui.send(KEY.enter, 40);

    expect(await tui.exitCode).toBe(2);
    const said = tui.err.join('');
    expect(said).toContain(`${workdir} no longer exists`);
    expect(said).toContain(result.resumeCommand);
    expect(said).not.toContain('PATH');
  });

  it('runs `claude --resume <id>` in the session folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-tui-'));
    tempDirs.push(dir);
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-tui-cwd-'));
    tempDirs.push(workdir);
    const outFile = path.join(dir, 'argv.txt');
    // A stand-in for the real `claude`, found through PATH exactly as the real
    // one would be. The real CLI is never launched.
    fs.writeFileSync(
      path.join(dir, 'claude'),
      `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > ${JSON.stringify(outFile)}\nexit 7\n`,
      { mode: 0o755 },
    );
    const previousPath = process.env['PATH'];
    process.env['PATH'] = `${dir}:${previousPath ?? ''}`;
    try {
      const code = await defaultDeps().spawnResume({ cwd: workdir, sessionId: 'abc-123' });
      expect(code).toBe(7);
      const recorded = fs.readFileSync(outFile, 'utf8').trim().split('\n');
      expect(recorded[0]).toBe(fs.realpathSync(workdir));
      expect(recorded.slice(1)).toEqual(['--resume', 'abc-123']);
    } finally {
      process.env['PATH'] = previousPath;
    }
    expect(typeof spawnResume).toBe('function');
  });
});

describe('clipboard and browser', () => {
  it('Ctrl+Y copies exactly the resume command', async () => {
    const result = makeResult({ sessionId: 'sess-5', cwd: "/tmp/it's here" });
    const tui = startTui({ deps: { recentSessions: () => [result] } });
    await settle(tui);

    await tui.send(KEY.ctrlY, 60);
    expect(tui.copied).toEqual([result.resumeCommand]);
    expect(plainFrame(tui.liveFrame())).toContain('copied');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
    expect(tui.out.join('')).toBe('');
  });

  it('falls back to printing the command when no clipboard tool exists', async () => {
    const result = makeResult();
    const tui = startTui({
      deps: { recentSessions: () => [result], copyToClipboard: async () => false },
    });
    await settle(tui);
    await tui.send(KEY.ctrlY, 60);
    expect(squash(tui.liveFrame())).toContain('No clipboard tool found');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
    expect(tui.out.join('')).toBe(`${result.resumeCommand}\n`);
  });

  it('Ctrl+O opens the transcript at the match being previewed', async () => {
    const asked: [string, number | undefined][] = [];
    const tui = startTui({
      openTranscript: async (sessionId, messageId) => {
        asked.push([sessionId, messageId]);
        return `http://127.0.0.1:4777/s/${sessionId}`;
      },
      deps: {
        search: () => [makeResult({ sessionId: 'sess-77' })],
        sessionMatches: () => manyMatches(3).map((m, i) => ({ ...m, messageId: 700 + i })),
      },
    });
    await tick(60);
    await tui.send('r', 80);
    await tui.send(KEY.right, 60);
    await tui.send(KEY.ctrlO, 80);

    expect(asked).toEqual([['sess-77', 701]]);
    expect(plainFrame(tui.liveFrame())).toContain('http://127.0.0.1:4777/s/sess-77');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});

describe('the footer', () => {
  it('shows only bindings that currently do something', async () => {
    const tui = startTui({
      openTranscript: async () => 'http://127.0.0.1:4777/s/a',
      deps: {
        recentSessions: () => [makeResult()],
        search: () => [makeResult()],
        sessionMatches: () => manyMatches(4),
      },
    });
    await settle(tui);

    // Browsing: no matches to step, no sort to change.
    let footer = squash(tui.liveFrame());
    expect(footer).toContain('⏎ resume');
    expect(footer).toContain('^Y copy');
    expect(footer).toContain('^O web');
    expect(footer).toContain('esc quit');
    expect(footer).not.toContain('matches');
    expect(footer).not.toContain('^R ');

    await tui.send('r', 100);
    footer = squash(tui.liveFrame());
    expect(footer).toContain('←→ matches');
    expect(footer).toContain('^E full');
    expect(footer).toContain('^R recent');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('hides the browser action when no opener is injected', async () => {
    const tui = startTui({ deps: { recentSessions: () => [makeResult()] } });
    await settle(tui);
    const footer = squash(tui.liveFrame());
    expect(footer).toContain('^Y copy');
    expect(footer).not.toContain('^O web');
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});

describe('startup and terminal size', () => {
  it('draws the box before the sync finishes and says nothing about timings', async () => {
    let releaseSync: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const tui = startTui({
      deps: {
        status: () => makeStatus({ sessions: 0 }),
        sync: async ({ onProgress }) => {
          onProgress?.({ phase: 'scan', current: 376, total: 0 });
          onProgress?.({ phase: 'index', current: 1, total: 376 });
          await gate;
          return makeSyncResult({ indexedFiles: 376, durationMs: 3100 });
        },
        recentSessions: () => [makeResult({ title: 'After the sync' })],
      },
    });
    await settle(tui);

    const during = plainFrame(tui.liveFrame());
    expect(during).toContain('Indexing 376 sessions…');
    expect(during).toContain('⏎ resume');

    releaseSync();
    await settle(tui);
    const after = plainFrame(tui.liveFrame());
    expect(after).not.toContain('Indexing');
    expect(after).not.toContain('done in');
    expect(after).toContain('After the sync');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('stays quiet when the sync indexes nothing', async () => {
    const tui = startTui({
      deps: {
        sync: async ({ onProgress }) => {
          onProgress?.({ phase: 'scan', current: 42, total: 0 });
          return makeSyncResult({ indexedFiles: 0, removedFiles: 0, durationMs: 40 });
        },
        recentSessions: () => [makeResult()],
      },
    });
    await settle(tui);
    expect(plainFrame(tui.liveFrame())).not.toContain('Indexing');
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('skips the sync with --no-sync', async () => {
    let syncs = 0;
    const tui = startTui({
      noSync: true,
      deps: {
        sync: async () => {
          syncs += 1;
          return makeSyncResult();
        },
        recentSessions: () => [makeResult()],
      },
    });
    await settle(tui);
    expect(syncs).toBe(0);
    expect(plainFrame(tui.liveFrame())).toContain('Storyboards repos comparison');
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  const longResults = () =>
    manyResults(10).map((result) => ({
      ...result,
      title: `${result.title} — a very long session title that will not fit`,
      cwd: `${HOME}/Documents/coding/personal/some/deeply/nested/project-folder-${result.sessionId}`,
    }));

  it('renders a 60x15 terminal without any line wider than the terminal', async () => {
    const tui = startTui({
      columns: 60,
      rows: 15,
      openTranscript: async () => 'http://127.0.0.1:4777/s/a',
      deps: {
        recentSessions: () => longResults(),
        search: () => longResults(),
        sessionMatches: () => manyMatches(6),
        getMessage: () => makeMessage({ text: 'a '.repeat(400) }),
        semanticStatus: () => makeSemanticStatus({ runtimeInstalled: true, pendingChunks: 10 }),
        enableSemantic: () => new Promise<void>(() => {}),
      },
    });
    await settle(tui);

    const check = (): void => {
      const frame = plainFrame(tui.liveFrame());
      expect(widestLine(frame)).toBeLessThanOrEqual(60);
      expect(frame.replace(/\n$/, '').split('\n').length).toBeLessThan(15);
    };
    check();
    await tui.send('recording videos', 80);
    check();
    await tui.send(KEY.ctrlE, 80);
    check();
    await tui.send(KEY.escape, 60);
    check();

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('renders a 40x10 terminal without any line wider than the terminal', async () => {
    const tui = startTui({
      columns: 40,
      rows: 10,
      openTranscript: async () => 'http://127.0.0.1:4777/s/a',
      deps: {
        recentSessions: () => longResults(),
        search: () => longResults(),
        sessionMatches: () => manyMatches(6),
        getMessage: () => makeMessage({ text: 'b '.repeat(400) }),
        semanticStatus: () => makeSemanticStatus({ runtimeInstalled: true, pendingChunks: 10 }),
        enableSemantic: () => new Promise<void>(() => {}),
      },
    });
    await settle(tui);

    const check = (): void => {
      const frame = plainFrame(tui.liveFrame());
      expect(widestLine(frame)).toBeLessThanOrEqual(40);
      expect(frame.replace(/\n$/, '').split('\n').length).toBeLessThan(10);
    };
    check();
    await tui.send('recording', 80);
    check();
    await tui.send(KEY.ctrlE, 80);
    check();

    await tui.send(KEY.escape, 60);
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('adapts to a terminal resize', async () => {
    const tui = startTui({
      columns: 100,
      rows: 24,
      deps: { recentSessions: () => manyResults(10) },
    });
    await settle(tui);
    expect(widestLine(plainFrame(tui.liveFrame()))).toBeLessThanOrEqual(100);

    await tui.resize(70, 16);
    await tick(40);
    const narrow = plainFrame(tui.liveFrame());
    expect(widestLine(narrow)).toBeLessThanOrEqual(70);
    expect(narrow.replace(/\n$/, '').split('\n').length).toBeLessThan(16);
    expect(narrow).toContain('Session 01');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});

describe('quitting', () => {
  it('Ctrl+C quits with code 0 and restores the terminal', async () => {
    const tui = startTui();
    await tick(60);
    await tui.send(KEY.ctrlC, 40);
    expect(await tui.exitCode).toBe(0);
    expect(tui.restored()).toBe(1);
  });

  it('restores the terminal and exits 1 when rendering throws', async () => {
    let restored = 0;
    const errors: string[] = [];
    const code = await startTui({
      deps: {
        render: () => {
          throw new Error('boom');
        },
        restoreStdin: () => {
          restored += 1;
        },
        writeErr: (text) => errors.push(text),
      },
    }).exitCode;
    expect(code).toBe(1);
    expect(restored).toBe(1);
    expect(errors.join('')).toContain('boom');
  });
});

/* ------------------------------------------------- adversarial review fixes */

/** ESC and BEL bytes that are not part of an SGR colour the UI wrote itself. */
function residualEscapes(frame: string): string[] {
  // eslint-disable-next-line no-control-regex
  const withoutSgr = frame.replace(/\u001B\[[0-9;]*m/g, '');
  // eslint-disable-next-line no-control-regex
  return withoutSgr.match(/[\u001B\u0007]/g) ?? [];
}

describe('hostile transcript text in the TUI', () => {
  const ESCAPES = '\u001B]0;PWNED\u0007\u001B[31mRED\u001B[0m';

  it('never writes a transcript escape sequence to the terminal', async () => {
    const tui = startTui({
      columns: 100,
      rows: 24,
      deps: {
        search: () => [
          makeResult({
            sessionId: 'esc-1',
            title: `${ESCAPES}title`,
            cwd: `/tmp/${ESCAPES}folder`,
            gitBranch: `${ESCAPES}branch`,
            snippet: {
              messageId: 1,
              role: 'user',
              ts: '2026-09-10T12:00:00.000Z',
              text: `before ${ESCAPES} after`,
              highlights: [[0, 6]],
            },
          }),
        ],
        sessionMatches: () => [makeMatch({ text: `match ${ESCAPES} here`, highlights: [[0, 5]] })],
        getMessage: () => makeMessage({ text: `full ${ESCAPES} message` }),
      },
    });
    await tick(60);
    await tui.send('r', 80);
    await tui.send(KEY.ctrlE, 80);

    for (const frame of tui.frames) {
      expect(residualEscapes(frame)).toEqual([]);
    }
    await tui.send(KEY.escape, 60);
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('keeps row width correct when a title lies about its size', async () => {
    const tui = startTui({
      columns: 80,
      rows: 20,
      deps: {
        recentSessions: () => [
          makeResult({ sessionId: 'a', title: `${ESCAPES}first${ESCAPES}`, cwd: '/tmp/a' }),
          makeResult({ sessionId: 'b', title: 'plain second title\nwith a newline\tand a tab', cwd: '/tmp/b' }),
        ],
      },
    });
    await settle(tui);

    const frame = plainFrame(tui.liveFrame());
    expect(widestLine(frame)).toBeLessThanOrEqual(80);
    const rows = frame.split('\n').filter((row) => row.includes('plain second title'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('plain second title with a newline');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});

describe('the TUI never resumes into the wrong folder', () => {
  it('refuses to spawn when the folder disappeared after the index was written', async () => {
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-tui-gone-'));
    fs.rmSync(gone, { recursive: true, force: true });
    const result = makeResult({ sessionId: 'sess-gone', cwd: gone, cwdExists: true });
    const tui = startTui({ deps: { recentSessions: () => [result] } });
    await settle(tui);
    await tui.send(KEY.enter, 40);

    expect(await tui.exitCode).toBe(2);
    expect(tui.spawned).toEqual([]);
    expect(tui.err.join('')).toContain('is not an existing folder');
    expect(tui.err.join('')).not.toContain('    at ');
  });

  it('refuses a relative cwd that somehow reached a result', async () => {
    const result = makeResult({ sessionId: 'sess-rel', cwd: '.', cwdExists: true });
    const tui = startTui({ deps: { recentSessions: () => [result] } });
    await settle(tui);
    await tui.send(KEY.enter, 40);

    expect(await tui.exitCode).toBe(2);
    expect(tui.spawned).toEqual([]);
  });
});

describe('a broken index is explained, not dumped', () => {
  it('prints one line and exits 2 without rendering anything', async () => {
    let rendered = 0;
    const tui = startTui({
      deps: {
        status: () => {
          throw new UserError(
            'The search index at /tmp/index.db is unusable (file is not a database). Delete /tmp/index.db and run again; it is rebuilt automatically.',
          );
        },
        render: () => {
          rendered += 1;
          throw new Error('should never render');
        },
      },
    });

    expect(await tui.exitCode).toBe(2);
    expect(rendered).toBe(0);
    const text = tui.err.join('');
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).toContain('Delete /tmp/index.db and run again');
    expect(text).not.toContain('    at ');
  });
});

describe('empty states say which emptiness it is', () => {
  it('shows the missing-transcripts sentence when the projects dir is gone', async () => {
    const hint =
      'No Claude Code transcripts found at /nope/projects. Point it at them with --projects-dir <path>, or set CLAUDE_CONFIG_DIR.';
    const tui = startTui({
      columns: 160,
      deps: {
        status: () =>
          makeStatus({ sessions: 0, projectsDir: '/nope/projects', projectsDirExists: false, projectsDirHint: hint }),
        sync: async () => {
          throw new UserError(hint);
        },
      },
    });
    await tick(150);

    const frame = squash(tui.liveFrame());
    expect(frame).toContain('No Claude Code transcripts found at /nope/projects');
    expect(frame).not.toContain('No matching sessions');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('says "No sessions yet" when the directory is there but empty', async () => {
    const tui = startTui({
      deps: {
        status: () => makeStatus({ sessions: 0 }),
        sync: async () => makeSyncResult({ scannedFiles: 0, skippedFiles: 0, sessions: 0 }),
      },
    });
    await tick(150);

    expect(squash(tui.liveFrame())).toContain('No sessions yet');
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});
