import { describe, expect, it } from 'vitest';
import {
  computeWindow,
  displayLength,
  elideMiddle,
  expandedBodyRows,
  fitFooter,
  folderColumnWidth,
  folderLabels,
  formatRow,
  layoutHeights,
  limitSegments,
  locateHighlights,
  pathSegments,
  queryLine,
  queryLineParts,
  relativeAge,
  scrollToLine,
  segmentHighlights,
  shortDate,
  shortenHome,
  shortenPath,
  truncate,
  wrapMessage,
  wrapSegments,
} from '../../src/tui/format.js';

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const HOME = '/Users/tester';

describe('truncate', () => {
  it('leaves short text alone and marks cuts', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello world', 8)).toBe('hello w…');
    expect(displayLength(truncate('hello world', 8))).toBe(8);
    expect(truncate('hello', 1)).toBe('…');
    expect(truncate('hello', 0)).toBe('');
  });
});

describe('paths', () => {
  it('replaces $HOME with ~ on POSIX and on Windows', () => {
    expect(shortenHome(`${HOME}/code/dashboard`, HOME)).toBe('~/code/dashboard');
    expect(shortenHome(HOME, HOME)).toBe('~');
    expect(shortenHome('/tmp/my-cool-app', HOME)).toBe('/tmp/my-cool-app');
    // A sibling directory that merely starts with the same characters.
    expect(shortenHome('/Users/tester2/x', HOME)).toBe('/Users/tester2/x');
    expect(shortenHome('C:\\Users\\Tester\\code\\app', 'C:\\Users\\tester')).toBe('~\\code\\app');
    expect(shortenHome('C:\\Users\\other\\app', 'C:\\Users\\tester')).toBe('C:\\Users\\other\\app');
  });

  it('splits on both separators', () => {
    expect(pathSegments('/Users/tester/code/app')).toEqual(['Users', 'tester', 'code', 'app']);
    expect(pathSegments('C:\\Users\\tester\\app')).toEqual(['C:', 'Users', 'tester', 'app']);
  });

  it('middle-elides, keeping the head and the tail', () => {
    expect(elideMiddle('~/Documents/coding/personal/dashboard', 18)).toBe('~/…/dashboard');
    expect(elideMiddle('~/Documents/test', 20)).toBe('~/Documents/test');
    expect(displayLength(elideMiddle('/a/very/long/path/to/the/project', 14))).toBeLessThanOrEqual(14);
    expect(elideMiddle('~\\Documents\\coding\\personal\\dashboard', 18)).toBe('~\\…\\dashboard');
  });

  it('keeps the end of the path when even ~/…/last does not fit', () => {
    const out = elideMiddle('~/Documents/averyveryverylongprojectname', 12);
    expect(displayLength(out)).toBe(12);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('name')).toBe(true);
  });

  it('combines both for the preview path line', () => {
    expect(shortenPath(`${HOME}/Documents/coding/personal/dashboard`, HOME, 16)).toBe('~/…/dashboard');
  });
});

describe('folderLabels', () => {
  it('shows only the last segment when that is unambiguous', () => {
    const labels = folderLabels([`${HOME}/code/dashboard`, `${HOME}/Documents/test`]);
    expect(labels.get(`${HOME}/code/dashboard`)).toBe('dashboard');
    expect(labels.get(`${HOME}/Documents/test`)).toBe('test');
  });

  it('adds one parent when two different folders end the same way', () => {
    const labels = folderLabels([`${HOME}/code/app`, `${HOME}/work/app`, `${HOME}/code/other`]);
    expect(labels.get(`${HOME}/code/app`)).toBe('code/app');
    expect(labels.get(`${HOME}/work/app`)).toBe('work/app');
    expect(labels.get(`${HOME}/code/other`)).toBe('other');
  });

  it('keeps adding parents until the labels are really distinct', () => {
    const labels = folderLabels(['/a/x/y', '/b/x/y']);
    expect(labels.get('/a/x/y')).toBe('a/x/y');
    expect(labels.get('/b/x/y')).toBe('b/x/y');
  });

  it('gives the same folder one label however often it appears', () => {
    const labels = folderLabels([`${HOME}/code/app`, `${HOME}/code/app`]);
    expect(labels.get(`${HOME}/code/app`)).toBe('app');
    expect(labels.size).toBe(1);
  });

  it('labels Windows paths with backslashes', () => {
    const labels = folderLabels(['C:\\code\\app', 'D:\\work\\app']);
    expect(labels.get('C:\\code\\app')).toBe('code\\app');
    expect(labels.get('D:\\work\\app')).toBe('work\\app');
  });

  it('survives degenerate input', () => {
    const labels = folderLabels(['', '/']);
    expect(labels.get('')).toBe('—');
    expect(labels.get('/')).toBe('/');
  });
});

describe('relativeAge', () => {
  it('formats every bucket', () => {
    expect(relativeAge('2026-09-20T11:59:30.000Z', NOW)).toBe('now');
    expect(relativeAge('2026-09-20T11:30:00.000Z', NOW)).toBe('30m');
    expect(relativeAge('2026-09-20T07:00:00.000Z', NOW)).toBe('5h');
    expect(relativeAge('2026-09-10T12:00:00.000Z', NOW)).toBe('10d');
    expect(relativeAge('2026-06-20T12:00:00.000Z', NOW)).toBe('3mo');
    expect(relativeAge('2024-09-20T12:00:00.000Z', NOW)).toBe('2y');
  });

  it('never throws on junk', () => {
    expect(relativeAge('', NOW)).toBe('—');
    expect(relativeAge('not a date', NOW)).toBe('—');
    expect(relativeAge('2027-01-01T00:00:00.000Z', NOW)).toBe('now');
  });
});

describe('shortDate', () => {
  it('shows the year only when it differs', () => {
    expect(shortDate('2026-09-10T12:00:00.000Z', NOW)).toBe('Sep 10');
    expect(shortDate('2025-01-02T12:00:00.000Z', NOW)).toBe('Jan 2 2025');
    expect(shortDate('nonsense', NOW)).toBe('—');
  });
});

describe('segmentHighlights', () => {
  it('splits text on the highlight ranges', () => {
    expect(segmentHighlights('I can record with OBS', [[6, 12]])).toEqual([
      { text: 'I can ', hit: false },
      { text: 'record', hit: true },
      { text: ' with OBS', hit: false },
    ]);
  });

  it('keeps offsets correct across newlines and collapses whitespace after slicing', () => {
    const text = 'first line\n\nthen record here';
    const start = text.indexOf('record');
    const segments = segmentHighlights(text, [[start, start + 6]]);
    expect(segments).toEqual([
      { text: 'first line then ', hit: false },
      { text: 'record', hit: true },
      { text: ' here', hit: false },
    ]);
  });

  it('sorts, clamps and merges malformed ranges without losing text', () => {
    const segments = segmentHighlights('abcdef', [
      [4, 6],
      [0, 2],
      [1, 3],
      [5, 99],
      [3, 3],
      [-5, 1],
    ]);
    expect(segments.map((s) => s.text).join('')).toBe('abcdef');
  });
});

describe('limitSegments', () => {
  it('cuts the segment list to the available characters', () => {
    const segments = [
      { text: 'hello ', hit: false },
      { text: 'world', hit: true },
      { text: ' and more', hit: false },
    ];
    expect(limitSegments(segments, 100)).toEqual(segments);
    expect(limitSegments(segments, 9).map((s) => s.text).join('')).toBe('hello wo…');
    expect(limitSegments(segments, 0)).toEqual([]);
  });
});

describe('wrapSegments', () => {
  const text = 'I can record with OBS, screen recording with my voice, webcam and the video there';
  const segments = segmentHighlights(text, [[6, 12]]);

  it('wraps on word boundaries within the width', () => {
    const lines = wrapSegments(segments, 30, 4);
    for (const line of lines) {
      const width = line.reduce((total, segment) => total + displayLength(segment.text), 0);
      expect(width).toBeLessThanOrEqual(30);
    }
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.map((line) => line.map((s) => s.text).join('')).join(' ')).toContain('record');
  });

  it('keeps the highlight as its own segment', () => {
    const lines = wrapSegments(segments, 60, 3);
    const hits = lines.flat().filter((segment) => segment.hit);
    expect(hits.map((segment) => segment.text)).toEqual(['record']);
  });

  it('marks the cut when the text does not fit in maxLines', () => {
    const lines = wrapSegments(segments, 20, 1);
    expect(lines).toHaveLength(1);
    const line = lines[0]!.map((segment) => segment.text).join('');
    expect(line.endsWith('…')).toBe(true);
    expect(displayLength(line)).toBeLessThanOrEqual(20);
  });

  it('does not mark a cut when everything fitted', () => {
    const lines = wrapSegments([{ text: 'short enough', hit: false }], 40, 3);
    expect(lines.map((line) => line.map((s) => s.text).join(''))).toEqual(['short enough']);
  });

  it('hard-splits a word that is wider than the line', () => {
    const lines = wrapSegments([{ text: 'x'.repeat(25), hit: false }], 10, 4);
    for (const line of lines) {
      expect(line.reduce((total, s) => total + displayLength(s.text), 0)).toBeLessThanOrEqual(10);
    }
    expect(lines.length).toBeGreaterThan(1);
  });

  it('never exceeds the width with wide glyphs', () => {
    const wide = wrapSegments([{ text: '日本語のセッション記録について'.repeat(3), hit: false }], 11, 5);
    for (const line of wide) {
      expect(line.reduce((total, s) => total + displayLength(s.text), 0)).toBeLessThanOrEqual(11);
    }
  });

  it('returns nothing for a degenerate box', () => {
    expect(wrapSegments(segments, 0, 3)).toEqual([]);
    expect(wrapSegments(segments, 20, 0)).toEqual([]);
  });
});

describe('wrapMessage', () => {
  it('keeps the author’s line breaks, blank lines included', () => {
    const lines = wrapMessage('first line\n\nthird line', [], 40);
    expect(lines.map((line) => line.map((s) => s.text).join(''))).toEqual([
      'first line',
      '',
      'third line',
    ]);
  });

  it('wraps each line to the width and carries the highlights to the right line', () => {
    const text = 'short\nI can record with OBS and a webcam that is quite a long line';
    const start = text.indexOf('record');
    const lines = wrapMessage(text, [[start, start + 6]], 20);
    for (const line of lines) {
      expect(line.reduce((total, s) => total + displayLength(s.text), 0)).toBeLessThanOrEqual(20);
    }
    expect(lines[0]!.map((s) => s.text).join('')).toBe('short');
    const withHit = lines.findIndex((line) => line.some((segment) => segment.hit));
    expect(withHit).toBe(1);
    expect(lines[withHit]!.filter((s) => s.hit).map((s) => s.text)).toEqual(['record']);
  });

  it('keeps the indentation a message line was written with', () => {
    const lines = wrapMessage('plan:\n  step one\n\tstep two', [], 40);
    expect(lines.map((line) => line.map((s) => s.text).join(''))).toEqual([
      'plan:',
      '  step one',
      '  step two',
    ]);
  });

  it('never loses a line of a long message', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n');
    expect(wrapMessage(text, [], 30)).toHaveLength(40);
  });
});

describe('locateHighlights', () => {
  const full = 'Before the match. I can record with OBS, screen recording with my voice. After.';

  it('finds the snippet inside the whole message and shifts the offsets', () => {
    const snippet = '…I can record with OBS…';
    const ranges = locateHighlights(full, snippet, [[7, 13]]);
    expect(ranges).toHaveLength(1);
    expect(full.slice(ranges[0]![0], ranges[0]![1])).toBe('record');
  });

  it('falls back to finding the highlighted term', () => {
    const ranges = locateHighlights(full, 'completely different text with record in it', [[31, 37]]);
    expect(ranges).toHaveLength(1);
    expect(full.slice(ranges[0]![0], ranges[0]![1]).toLowerCase()).toBe('record');
  });

  it('gives up quietly when there is nothing to highlight', () => {
    expect(locateHighlights(full, 'a semantic snippet', [])).toEqual([]);
  });
});

describe('formatRow', () => {
  const row = {
    selected: true,
    title: 'Storyboards repos comparison',
    folder: 'dashboard',
    age: '10d',
  };

  it('never exceeds the width and shows all three columns', () => {
    for (const width of [120, 100, 80, 60, 40, 30, 20, 10, 4, 1]) {
      const line = formatRow(row, width);
      expect(displayLength(line), `width ${width}`).toBeLessThanOrEqual(width);
    }
    const line = formatRow(row, 60);
    expect(line.startsWith(' ▸ ')).toBe(true);
    expect(line).toContain('Storyboards');
    expect(line).toContain('dashboard');
    expect(line.trimEnd().endsWith('10d')).toBe(true);
  });

  it('marks the unselected rows with spaces, in the same columns', () => {
    const unselected = formatRow({ ...row, selected: false }, 60);
    expect(unselected.startsWith('   ')).toBe(true);
    expect(displayLength(unselected)).toBe(displayLength(formatRow(row, 60)));
  });

  it('lines the age column up down the list', () => {
    const lines = [
      formatRow({ ...row, age: '1h' }, 60, 10),
      formatRow({ ...row, age: '10d' }, 60, 10),
      formatRow({ ...row, age: 'now' }, 60, 10),
    ];
    const ends = lines.map((line) => line.length - line.trimEnd().length);
    expect(new Set(lines.map((line) => displayLength(line))).size).toBe(1);
    expect(ends).toEqual([0, 0, 0]);
    // Right-aligned in a fixed column: the ages end in the same cell.
    expect(lines.map((line) => line.slice(-4))).toEqual(['  1h', ' 10d', ' now']);
  });

  it('uses the folder column width it is given', () => {
    const line = formatRow({ ...row, folder: 'code/app' }, 80, 12);
    expect(line).toContain('code/app');
    expect(displayLength(line)).toBeLessThanOrEqual(80);
    expect(folderColumnWidth(['dashboard', 'code/app'], 100)).toBe(9);
    expect(folderColumnWidth(['a-very-long-folder-name-indeed'], 40)).toBe(12);
  });
});

describe('computeWindow', () => {
  it('keeps the selection visible while scrolling as little as possible', () => {
    expect(computeWindow(0, 20, 5, 0)).toBe(0);
    expect(computeWindow(4, 20, 5, 0)).toBe(0);
    expect(computeWindow(5, 20, 5, 0)).toBe(1);
    expect(computeWindow(19, 20, 5, 0)).toBe(15);
    expect(computeWindow(10, 20, 5, 15)).toBe(10);
    expect(computeWindow(14, 20, 5, 12)).toBe(12);
  });

  it('clamps to the end of the list and handles degenerate input', () => {
    expect(computeWindow(0, 3, 5, 4)).toBe(0);
    expect(computeWindow(0, 0, 5, 3)).toBe(0);
    expect(computeWindow(2, 20, 0, 0)).toBe(0);
  });
});

describe('layoutHeights', () => {
  it('caps the recent list at five rows and a searched list at eight', () => {
    expect(layoutHeights({ rows: 40, hasQuery: false, hasStatus: false, hasHeading: true }).listRows).toBe(5);
    expect(layoutHeights({ rows: 40, hasQuery: true, hasStatus: false, hasHeading: false }).listRows).toBe(8);
  });

  it('always leaves the frame shorter than the terminal', () => {
    for (const rows of [8, 10, 12, 15, 24, 40]) {
      for (const hasStatus of [false, true]) {
        for (const hasQuery of [false, true]) {
          const { listRows, previewRows } = layoutHeights({
            rows,
            hasQuery,
            hasStatus,
            hasHeading: !hasQuery,
          });
          expect(listRows).toBeGreaterThanOrEqual(1);
          const chrome =
            1 + 1 + 1 + 1 + (hasStatus ? 1 : 0) + (hasQuery ? 0 : 1) + (previewRows > 0 ? 1 : 0);
          expect([rows, hasStatus, hasQuery, listRows + previewRows + chrome]).toEqual([
            rows,
            hasStatus,
            hasQuery,
            Math.min(listRows + previewRows + chrome, rows - 1),
          ]);
        }
      }
    }
  });

  it('drops the preview rather than squeezing it onto a tiny terminal', () => {
    expect(layoutHeights({ rows: 8, hasQuery: true, hasStatus: true, hasHeading: false }).previewRows).toBe(0);
  });
});

describe('the expanded view geometry', () => {
  it('leaves a scrollable body and keeps the frame short', () => {
    expect(expandedBodyRows(24, false)).toBe(16);
    expect(expandedBodyRows(10, true)).toBe(1);
    expect(expandedBodyRows(8, false)).toBe(1);
  });

  it('scrolls so the matched line is on screen, without overscrolling', () => {
    expect(scrollToLine(0, 10, 100)).toBe(0);
    expect(scrollToLine(40, 10, 100)).toBe(37);
    expect(scrollToLine(99, 10, 100)).toBe(90);
    expect(scrollToLine(5, 10, 8)).toBe(0);
  });
});

describe('queryLineParts', () => {
  it('shows the query with a block cursor at the end', () => {
    const parts = queryLineParts('recording videos', 16, 60);
    expect(parts.prompt).toBe(' › ');
    expect(parts.before).toBe('recording videos');
    expect(parts.cursor).toBe('█');
    expect(parts.after).toBe('');
    expect(queryLine('recording videos', 16, 60)).toBe(' › recording videos█');
  });

  it('puts a visible glyph — not a colour — where the cursor sits inside the text', () => {
    const parts = queryLineParts('recording videos', 9, 60);
    expect(parts.before).toBe('recording');
    expect(parts.cursor).toBe('▏');
    expect(parts.after).toBe(' videos');
    expect(queryLine('recording videos', 9, 60)).toBe(' › recording▏ videos');
  });

  it('scrolls horizontally to keep the cursor visible, within the width', () => {
    for (const width of [20, 40, 60]) {
      for (const cursor of [0, 50, 120, 200]) {
        const line = queryLine('x'.repeat(200), cursor, width);
        expect([width, cursor, displayLength(line) <= width]).toEqual([width, cursor, true]);
        expect(line).toMatch(/[█▏]/u);
      }
    }
  });

  it('degrades gracefully on a tiny width', () => {
    expect(displayLength(queryLine('abc', 3, 6))).toBeLessThanOrEqual(6);
    expect(displayLength(queryLine('abc', 3, 2))).toBeLessThanOrEqual(2);
  });
});

describe('fitFooter', () => {
  const hints = [
    { text: '⏎ resume', priority: 1 },
    { text: 'tab matches', priority: 3 },
    { text: '^E full message', priority: 6 },
    { text: '^R sort: best match', priority: 7 },
    { text: '^Y copy', priority: 4 },
    { text: '^O browser', priority: 5 },
    { text: 'esc quit', priority: 2 },
  ];

  it('shows everything when it fits, in the order given', () => {
    const line = fitFooter(hints, 120);
    expect(line).toBe(
      ' ⏎ resume   tab matches   ^E full message   ^R sort: best match   ^Y copy   ^O browser   esc quit',
    );
  });

  it('drops the lowest-priority hints first and never overflows', () => {
    const narrow = fitFooter(hints, 60);
    expect(displayLength(narrow)).toBeLessThanOrEqual(60);
    expect(narrow).toContain('⏎ resume');
    expect(narrow).toContain('esc quit');
    expect(narrow).not.toContain('sort:');

    const tiny = fitFooter(hints, 24);
    expect(displayLength(tiny)).toBeLessThanOrEqual(24);
    expect(tiny).toContain('⏎ resume');
    expect(tiny).toContain('esc quit');

    for (const width of [10, 6, 3, 1]) {
      expect(displayLength(fitFooter(hints, width))).toBeLessThanOrEqual(width);
    }
  });
});

describe('width in terminal cells, not code points', () => {
  const CJK = '日本語のセッション記録について話した長いタイトル';
  const EMOJI = '😀😀😀 recording videos 🎥🎬';

  it('counts a wide glyph as two cells and a combining mark as none', () => {
    expect(displayLength('日')).toBe(2);
    expect(displayLength('ab')).toBe(2);
    expect(displayLength('😀')).toBe(2);
    expect(displayLength('é')).toBe(1); // e + combining acute
    expect(displayLength('😀️')).toBe(2); // variation selector adds nothing
  });

  it('truncates wide text without overflowing, and never splits a glyph', () => {
    for (const width of [1, 2, 3, 5, 8, 13, 21]) {
      for (const text of [CJK, EMOJI, `${CJK}${EMOJI}`]) {
        expect([width, displayLength(truncate(text, width)) <= width]).toEqual([width, true]);
      }
    }
    expect(truncate('日本語', 5)).toBe('日本…');
    expect(truncate('日本語', 4)).toBe('日…');
  });

  /**
   * Counted here rather than with `displayLength`, so the assertion is not the
   * code under test measuring itself.
   */
  const cells = (line: string): number => {
    let total = 0;
    for (const ch of line) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp === 0xfe0f || (cp >= 0x0300 && cp <= 0x036f)) continue;
      const wide =
        (cp >= 0x1100 && cp <= 0x115f) ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0x1f300 && cp <= 0x1faff);
      total += wide ? 2 : 1;
    }
    return total;
  };

  it('keeps a 60-column row at exactly 60 cells for CJK and emoji titles', () => {
    for (const title of [CJK, EMOJI, 'Storyboards repos comparison']) {
      for (const folder of ['プロジェクト', 'dashboard']) {
        const line = formatRow({ selected: true, title, folder, age: '10d' }, 60, 12);
        expect([title.slice(0, 4), cells(line)]).toEqual([title.slice(0, 4), 60]);
        expect([title.slice(0, 4), displayLength(line)]).toEqual([title.slice(0, 4), 60]);
      }
    }
  });

  it('keeps the query line inside the width with wide characters', () => {
    for (const width of [20, 40, 60, 80]) {
      const line = queryLine(`${CJK}${EMOJI}`, 10, width);
      expect([width, displayLength(line) <= width]).toEqual([width, true]);
    }
  });

  it('elides a path of wide characters inside the width', () => {
    for (const width of [4, 8, 14, 20, 30]) {
      const elided = elideMiddle('/Users/tester/コード/プロジェクト/日本語のフォルダ', width);
      expect([width, displayLength(elided) <= width]).toEqual([width, true]);
    }
  });
});
