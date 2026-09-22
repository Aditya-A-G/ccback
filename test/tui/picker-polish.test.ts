/**
 * How the picker holds together as the terminal gets wider.
 *
 * 1. The title column is capped, so the folder stays next to the title instead
 *    of drifting to the far edge with blank cells in between: one table, not
 *    two lists sharing a line.
 * 2. Footer hints are short enough to survive an 80- or 96-column terminal,
 *    which is where most people are, so the keys stay visible.
 * 3. "match 1 of 50" must be a real count, never the fetch limit read out as
 *    one; past the limit it says so with a `+`.
 */
import { describe, expect, it } from 'vitest';
import { MATCH_LIMIT, previewHeader } from '../../src/tui/app.js';
import {
  displayLength,
  fitFooter,
  footerHints,
  FOOTER_FULL_WIDTH,
  formatRow,
  nextOrder,
  TITLE_COLUMN_MAX,
  TITLE_COLUMN_MIN,
  titleColumnWidth,
} from '../../src/tui/format.js';
import type { MatchOrder } from '../../src/tui/deps.js';
import { KEY, makeMatch, makeResult, NOW, plainFrame, startTui, tick } from './helpers.js';

const squash = (text: string): string => plainFrame(text).replace(/\s+/g, ' ');

describe('the title column', () => {
  it('is as wide as the longest title, within bounds', () => {
    expect(titleColumnWidth(['short', 'a bit longer'])).toBe(TITLE_COLUMN_MIN);
    expect(titleColumnWidth(['x'.repeat(35)])).toBe(35);
    expect(titleColumnWidth(['x'.repeat(200)])).toBe(TITLE_COLUMN_MAX);
    expect(titleColumnWidth([])).toBe(TITLE_COLUMN_MIN);
  });

  it('puts the folder right after the title, not at the far edge', () => {
    const row = { selected: false, title: 'Storyboards repos comparison', folder: 'dashboard', age: '10d' };
    const line = formatRow(row, 96, { title: titleColumnWidth([row.title]), folder: 9 });

    const titleEnd = line.indexOf(row.title) + row.title.length;
    const folderStart = line.indexOf(row.folder);
    // Exactly the two-space column gap between them.
    expect(folderStart - titleEnd).toBe(2);
    expect(displayLength(line)).toBeLessThanOrEqual(96);
    // And the whole row is compact, not stretched to the terminal edge.
    expect(displayLength(line)).toBeLessThan(60);
  });

  it('still truncates properly on a narrow terminal', () => {
    const row = { selected: true, title: 'x'.repeat(80), folder: 'some/folder', age: '10d' };
    for (const width of [96, 80, 60, 50, 40, 30, 20, 10, 4, 1]) {
      const line = formatRow(row, width, { title: TITLE_COLUMN_MAX, folder: 11 });
      expect(displayLength(line), `width ${width}`).toBeLessThanOrEqual(width);
    }
    expect(formatRow(row, 50, { title: TITLE_COLUMN_MAX, folder: 11 })).toContain('…');
  });
});

describe('the footer', () => {
  const full = footerHints({
    expanded: false,
    hasMatches: true,
    hasPreview: true,
    hasQuery: true,
    hasCurrent: true,
    canOpenBrowser: true,
    order: 'best',
  });

  it('fits every hint, the order included, at 80 and 96 columns', () => {
    for (const width of [FOOTER_FULL_WIDTH, 96, 120]) {
      const line = fitFooter(full, width);
      expect(displayLength(line), `width ${width}`).toBeLessThanOrEqual(width);
      for (const hint of full) {
        expect(line, `width ${width}`).toContain(hint.text);
      }
    }
  });

  it('fits the expanded view too', () => {
    const expanded = footerHints({
      expanded: true,
      hasMatches: true,
      hasPreview: true,
      hasQuery: true,
      hasCurrent: true,
      canOpenBrowser: true,
      order: 'newest',
    });
    const line = fitFooter(expanded, FOOTER_FULL_WIDTH);
    for (const hint of expanded) expect(line).toContain(hint.text);
  });

  it('only starts dropping hints below 80 columns, and never overflows', () => {
    // Nothing is dropped at or above the width it is designed for.
    for (const width of [FOOTER_FULL_WIDTH, 81, 100]) {
      expect(fitFooter(full, width)).toContain('^R');
    }
    // Narrower than that, the order hint is the first to go.
    expect(fitFooter(full, 60)).not.toContain('^R');
    for (const width of [120, 96, 80, 70, 60, 40, 24, 10, 3, 1]) {
      expect(displayLength(fitFooter(full, width)), `width ${width}`).toBeLessThanOrEqual(width);
    }
  });

  it('names the order Ctrl+R will switch to, all the way round the cycle', () => {
    const state = {
      expanded: false,
      hasMatches: false,
      hasPreview: true,
      hasQuery: true,
      hasCurrent: true,
      canOpenBrowser: false,
    } as const;
    const hint = (order: MatchOrder): string | undefined =>
      footerHints({ ...state, order }).find((h) => h.text.startsWith('^R '))?.text;
    expect(hint('best')).toBe('^R newest');
    expect(hint('newest')).toBe('^R oldest');
    expect(hint('oldest')).toBe('^R best');
    // Three presses come back to where they started.
    expect(nextOrder(nextOrder(nextOrder('best')))).toBe('best');
  });

  it('keeps the longest order hint inside the 80-column footer', () => {
    for (const order of ['best', 'newest', 'oldest'] as const) {
      const hints = footerHints({
        expanded: false,
        hasMatches: true,
        hasPreview: true,
        hasQuery: true,
        hasCurrent: true,
        canOpenBrowser: true,
        order,
      });
      const line = fitFooter(hints, FOOTER_FULL_WIDTH);
      expect(displayLength(line), order).toBeLessThanOrEqual(FOOTER_FULL_WIDTH);
      for (const h of hints) expect(line, order).toContain(h.text);
    }
  });
});

describe('the match counter', () => {
  const snippet = { role: 'user', ts: '2026-09-10T12:00:00.000Z' };

  it('reads as a count when it is one', () => {
    expect(previewHeader(snippet, NOW, 0, 7)).toContain('match 1 of 7');
    expect(previewHeader(snippet, NOW, 0, 7)).not.toContain('+');
  });

  it('reads as a floor when the limit was hit', () => {
    expect(previewHeader(snippet, NOW, 0, MATCH_LIMIT, true)).toContain(`match 1 of ${MATCH_LIMIT}+`);
  });

  it('says 50+ in the picker when there are more than 50 matches', async () => {
    const tui = startTui({
      deps: {
        recentSessions: () => [makeResult()],
        search: () => [makeResult()],
        sessionMatches: () =>
          Array.from({ length: MATCH_LIMIT + 1 }, (_, i) =>
            makeMatch({ messageId: 900 + i, text: `match ${i + 1} about recording` }),
          ),
      },
    });
    await tick(60);
    await tui.send('r', 120);
    expect(squash(tui.liveFrame())).toContain(`match 1 of ${MATCH_LIMIT}+`);
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('says 50 exactly when there are exactly 50', async () => {
    const tui = startTui({
      deps: {
        recentSessions: () => [makeResult()],
        search: () => [makeResult()],
        sessionMatches: () =>
          Array.from({ length: MATCH_LIMIT }, (_, i) =>
            makeMatch({ messageId: 900 + i, text: `match ${i + 1} about recording` }),
          ),
      },
    });
    await tick(60);
    await tui.send('r', 120);
    const frame = squash(tui.liveFrame());
    expect(frame).toContain(`match 1 of ${MATCH_LIMIT}`);
    expect(frame).not.toContain(`${MATCH_LIMIT}+`);
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('asks for one more than the cap, so the cap can be detected', async () => {
    const limits: number[] = [];
    const tui = startTui({
      deps: {
        recentSessions: () => [makeResult()],
        search: () => [makeResult()],
        sessionMatches: (request) => {
          limits.push(request.limit ?? 0);
          return [makeMatch()];
        },
      },
    });
    await tick(60);
    await tui.send('r', 120);
    expect(limits[0]).toBe(MATCH_LIMIT + 1);
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});

describe('the picker honours --limit', () => {
  it('asks for exactly as many rows as the caller wanted', async () => {
    const limits: number[] = [];
    const tui = startTui({
      limit: 3,
      deps: {
        recentSessions: () => [makeResult()],
        search: (request) => {
          limits.push(request.limit ?? 0);
          return [makeResult()];
        },
      },
    });
    await tick(60);
    await tui.send('r', 120);
    expect(limits[0]).toBe(3);
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });

  it('keeps the recent list at five', async () => {
    const asked: number[] = [];
    const tui = startTui({
      limit: 3,
      deps: {
        recentSessions: (request) => {
          asked.push(request.limit ?? 0);
          return [makeResult()];
        },
      },
    });
    await tick(80);
    expect(asked[0]).toBe(5);
    expect(plainFrame(tui.liveFrame())).toContain('Recent');
    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});
