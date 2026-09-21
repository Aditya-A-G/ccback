/**
 * Pure formatting helpers for the terminal UI.
 *
 * Everything here is string-in / string-out so the layout can be unit tested
 * without mounting Ink, and so every single-line element can be pre-truncated
 * to the terminal width (Ink wraps by default, which would push the footer off
 * screen on a narrow terminal).
 */

import { sanitizeLine } from '../core/sanitize.js';

/** The character used wherever text had to be cut. */
export const ELLIPSIS = '…';

/** Prompt in front of the search box. */
export const PROMPT = ' › ';

/** Row markers. Three cells wide either way, so columns never shift. */
export const ROW_MARKER_SELECTED = ' ▸ ';
export const ROW_MARKER = '   ';

/** Width of the age column: `now`, `12m`, `10d`, `3mo`, `2y` all fit. */
export const AGE_WIDTH = 4;

/** Indent of everything in the preview block. */
export const PREVIEW_INDENT = '   ';

/** Most rows shown for an empty query, and for a query with results. */
export const MAX_RECENT_ROWS = 5;
export const MAX_RESULT_ROWS = 8;

/**
 * Strips anything that would move the cursor, repaint the screen or lie about
 * its width, and folds `\n`/`\t` into spaces. Every single-line element of the
 * TUI goes through here, so a title carrying `ESC ] 0 ; … BEL` is inert and a
 * row is still exactly as wide as it claims.
 */
export function plain(text: string): string {
  return sanitizeLine(text);
}

/**
 * Cells one code point occupies in a terminal: 2 for the East Asian wide and
 * fullwidth blocks and for emoji, 0 for combining marks and variation
 * selectors, 1 for everything else.
 *
 * Deliberately a small table rather than a dependency: it covers the ranges a
 * transcript title realistically contains, and being wrong about an
 * unassigned code point costs one column, never a broken frame.
 */
export function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  // Combining marks (Mn/Me) and variation selectors sit on the previous glyph.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x0483 && codePoint <= 0x0489) ||
    (codePoint >= 0x0591 && codePoint <= 0x05bd) ||
    (codePoint >= 0x0610 && codePoint <= 0x061a) ||
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    (codePoint >= 0x0e31 && codePoint <= 0x0e3a) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20f0) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK radicals, Kangxi, punctuation
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // kana, Hangul compat, CJK squared
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK extension A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK unified ideographs
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) || // Yi
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // fullwidth forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x16fe0 && codePoint <= 0x1b2ff) || // Tangut, Nushu, kana supplement
    (codePoint >= 0x1f004 && codePoint <= 0x1f0cf) ||
    (codePoint >= 0x1f18e && codePoint <= 0x1f19a) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) || // emoji, symbols, faces
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK extensions B and later
  ) {
    return 2;
  }
  return 1;
}

/** Visible width in terminal cells of already-sanitised text. */
function cellWidth(text: string): number {
  let total = 0;
  for (const ch of text) total += charWidth(ch.codePointAt(0) ?? 0);
  return total;
}

/**
 * Cuts `text` to `width` *cells*, marking the cut with `…`. A wide glyph is
 * never split in half: if only one cell is left, it is dropped, and the caller's
 * padding fills the gap, so a row can be one cell short but never one too long.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  const safe = plain(text);
  if (cellWidth(safe) <= width) return safe;
  if (width === 1) return ELLIPSIS;
  let used = 0;
  let out = '';
  for (const ch of safe) {
    const next = charWidth(ch.codePointAt(0) ?? 0);
    if (used + next > width - 1) break;
    out += ch;
    used += next;
  }
  return `${out}${ELLIPSIS}`;
}

/**
 * Visible length in terminal cells. Wide CJK and emoji take two, combining
 * marks none, which is what keeps a row exactly as wide as it claims.
 */
export function displayLength(text: string): number {
  return cellWidth(plain(text));
}

/* ------------------------------------------------------------------ paths */

/** True for `C:\…`, `\\server\share` and anything else backslash-separated. */
export function isWindowsPath(pathLike: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(pathLike) || pathLike.includes('\\');
}

/** The separator a path is written with, so output matches the input style. */
export function pathSeparator(pathLike: string): string {
  return isWindowsPath(pathLike) && !pathLike.includes('/') ? '\\' : '/';
}

/** Non-empty path segments, for `/` and `\` alike. */
export function pathSegments(pathLike: string): string[] {
  return pathLike.split(/[\\/]+/).filter((segment) => segment !== '');
}

/**
 * Replaces a leading `$HOME` with `~`, on POSIX and on Windows
 * (`C:\Users\name\code` → `~\code`, matched case-insensitively there).
 */
export function shortenHome(cwd: string, home: string): string {
  if (home === '') return cwd;
  const root = home.replace(/[\\/]+$/, '');
  const head = cwd.slice(0, root.length);
  const sameHead =
    head === root || (isWindowsPath(cwd) && head.toLowerCase() === root.toLowerCase());
  if (!sameHead) return cwd;
  if (cwd.length === root.length) return '~';
  const next = cwd[root.length];
  if (next !== '/' && next !== '\\') return cwd;
  return `~${cwd.slice(root.length)}`;
}

/**
 * Middle-elides a path so it fits `width`, keeping the head and as many
 * trailing segments as possible: `/Users/me/code/app` → `~/…/app`.
 */
export function elideMiddle(pathLike: string, width: number): string {
  if (width <= 0) return '';
  if (displayLength(pathLike) <= width) return pathLike;

  const sep = pathSeparator(pathLike);
  const segments = pathLike.split(/[\\/]/);
  if (segments.length > 2) {
    const head = segments[0] === '' ? '' : segments[0]!;
    for (let keep = segments.length - 1; keep >= 1; keep -= 1) {
      const tail = segments.slice(segments.length - keep).join(sep);
      const candidate = `${head}${sep}${ELLIPSIS}${sep}${tail}`;
      if (displayLength(candidate) <= width) return candidate;
    }
  }

  // Even `head/…/last` is too wide: keep the end of the path, which is the
  // part that identifies the project.
  if (width === 1) return ELLIPSIS;
  return `${ELLIPSIS}${tail(pathLike, width - 1)}`;
}

/** `$HOME` as `~`, then middle-elided to `width`. */
export function shortenPath(cwd: string, home: string, width: number): string {
  return elideMiddle(shortenHome(cwd, home), width);
}

/**
 * One short label per folder: the last segment, with as many parent segments
 * added as it takes to tell two different folders apart
 * (`~/code/dashboard` and `~/work/dashboard` become `code/dashboard` and
 * `work/dashboard`). Computed over the whole result list, so a label never
 * changes while the user scrolls.
 */
export function folderLabels(cwds: string[]): Map<string, string> {
  const unique = [...new Set(cwds)];
  const segments = new Map(unique.map((cwd) => [cwd, pathSegments(cwd)]));
  const depth = new Map(unique.map((cwd) => [cwd, 1]));

  const labelOf = (cwd: string): string => {
    const parts = segments.get(cwd) ?? [];
    if (parts.length === 0) return plain(cwd) || '—';
    const take = Math.min(depth.get(cwd) ?? 1, parts.length);
    return parts.slice(parts.length - take).join(pathSeparator(cwd));
  };

  // Grow the colliding labels one parent at a time. Bounded by the deepest
  // path, and by a hard cap so a pathological input cannot spin.
  for (let round = 0; round < 16; round += 1) {
    const groups = new Map<string, string[]>();
    for (const cwd of unique) {
      const label = labelOf(cwd);
      const group = groups.get(label);
      if (group) group.push(cwd);
      else groups.set(label, [cwd]);
    }
    let grew = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const cwd of group) {
        const parts = segments.get(cwd) ?? [];
        const current = depth.get(cwd) ?? 1;
        if (current < parts.length) {
          depth.set(cwd, current + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }

  return new Map(unique.map((cwd) => [cwd, labelOf(cwd)]));
}

/* ------------------------------------------------------------------- time */

/** Compact age of an ISO timestamp: `now`, `12m`, `5h`, `10d`, `3mo`, `2y`. */
export function relativeAge(ts: string, nowMs: number): string {
  if (ts === '') return '—';
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** `Sep 10`, or `Sep 10 2025` when the year differs from today's. */
export function shortDate(ts: string, nowMs: number): string {
  if (ts === '') return '—';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '—';
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = date.getUTCDate();
  const base = `${month} ${day}`;
  return date.getUTCFullYear() === new Date(nowMs).getUTCFullYear() ? base : `${base} ${date.getUTCFullYear()}`;
}

/* --------------------------------------------------------------- snippets */

/** A run of snippet text that is either matched or not. */
export interface Segment {
  text: string;
  hit: boolean;
}

/**
 * Splits snippet text on its `[start, end)` highlight ranges. Ranges are
 * sorted, clamped and merged first, so malformed input can never drop text.
 * Whitespace is collapsed inside each segment, after slicing, so offsets stay
 * correct for snippets containing newlines.
 */
export function segmentHighlights(text: string, highlights: [number, number][]): Segment[] {
  const ranges = highlights
    .map(([start, end]): [number, number] => [
      Math.max(0, Math.min(text.length, start)),
      Math.max(0, Math.min(text.length, end)),
    ])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }

  const segments: Segment[] = [];
  // Slice first, clean each piece: cleaning the whole string first would move
  // the offsets the ranges point at.
  const push = (value: string, hit: boolean): void => {
    const collapsed = plain(value).replace(/\s+/g, ' ');
    if (collapsed !== '') segments.push({ text: collapsed, hit });
  };

  let cursor = 0;
  for (const [start, end] of merged) {
    push(text.slice(cursor, start), false);
    push(text.slice(start, end), true);
    cursor = end;
  }
  push(text.slice(cursor), false);
  return segments;
}

/** Cuts a segment list to `maxChars` visible characters, marking the cut. */
export function limitSegments(segments: Segment[], maxChars: number): Segment[] {
  if (maxChars <= 0) return [];
  const out: Segment[] = [];
  let used = 0;
  for (const segment of segments) {
    const length = displayLength(segment.text);
    if (used + length <= maxChars) {
      out.push(segment);
      used += length;
      continue;
    }
    const room = maxChars - used;
    if (room > 1) out.push({ text: truncate(segment.text, room), hit: segment.hit });
    else if (room === 1) out.push({ text: ELLIPSIS, hit: segment.hit });
    return out;
  }
  return out;
}

interface Cell {
  ch: string;
  hit: boolean;
  width: number;
}

function toCells(segments: Segment[]): Cell[] {
  const cells: Cell[] = [];
  for (const segment of segments) {
    for (const ch of plain(segment.text)) {
      cells.push({ ch, hit: segment.hit, width: charWidth(ch.codePointAt(0) ?? 0) });
    }
  }
  return cells;
}

function cellsToSegments(cells: Cell[]): Segment[] {
  const out: Segment[] = [];
  for (const cell of cells) {
    const last = out[out.length - 1];
    if (last && last.hit === cell.hit) last.text += cell.ch;
    else out.push({ text: cell.ch, hit: cell.hit });
  }
  return out;
}

/**
 * Word-wraps highlighted text to `width` cells and at most `maxLines` lines,
 * keeping the highlight runs intact. The last line is marked with `…` when
 * text had to be dropped.
 */
export function wrapSegments(segments: Segment[], width: number, maxLines: number): Segment[][] {
  if (width <= 0 || maxLines <= 0) return [];
  const cells = toCells(segments);
  const contentAfter = (from: number): boolean =>
    cells.slice(from).some((cell) => cell.ch !== ' ');

  const lines: Cell[][] = [];
  let line: Cell[] = [];
  let used = 0;
  let index = 0;
  let overflow = false;

  /** Ends the current line. False when there is no room for another one. */
  const newLine = (): boolean => {
    lines.push(line);
    line = [];
    used = 0;
    return lines.length < maxLines;
  };

  while (index < cells.length) {
    const cell = cells[index]!;
    if (cell.ch === ' ') {
      if (used > 0 && used + cell.width <= width) {
        line.push(cell);
        used += cell.width;
      } else if (used > 0 && !newLine()) {
        overflow = contentAfter(index + 1);
        break;
      }
      index += 1;
      continue;
    }

    let end = index;
    let wordWidth = 0;
    while (end < cells.length && cells[end]!.ch !== ' ') {
      wordWidth += cells[end]!.width;
      end += 1;
    }
    if (used > 0 && used + wordWidth > width && !newLine()) {
      overflow = true;
      break;
    }

    let stopped = false;
    for (let at = index; at < end; at += 1) {
      const next = cells[at]!;
      if (used + next.width > width && !newLine()) {
        overflow = true;
        stopped = true;
        break;
      }
      line.push(next);
      used += next.width;
    }
    if (stopped) break;
    index = end;
  }

  if (line.length > 0) {
    if (lines.length < maxLines) lines.push(line);
    else overflow = true;
  }

  const out = lines.slice(0, maxLines).map((row) => cellsToSegments(row));
  if (overflow && out.length > 0) {
    const last = [...out[out.length - 1]!];
    let lastWidth = last.reduce((total, segment) => total + displayLength(segment.text), 0);
    while (lastWidth + 1 > width && last.length > 0) {
      const tailSegment = last[last.length - 1]!;
      const shorter = [...tailSegment.text].slice(0, -1).join('');
      if (shorter === '') last.pop();
      else last[last.length - 1] = { text: shorter, hit: tailSegment.hit };
      lastWidth = last.reduce((total, segment) => total + displayLength(segment.text), 0);
    }
    out[out.length - 1] = [...last, { text: ELLIPSIS, hit: false }];
  }
  return out;
}

/**
 * A whole message, wrapped for the expanded view: the author's own line
 * breaks are kept (a blank line stays a blank line), each line is word-wrapped
 * to `width`, and the highlight ranges — which point into the untouched text —
 * are carried onto the right lines.
 */
export function wrapMessage(
  text: string,
  highlights: [number, number][],
  width: number,
): Segment[][] {
  if (width <= 0) return [];
  const out: Segment[][] = [];
  let offset = 0;
  // Split the raw text: `segmentHighlights` sanitises each slice, so the
  // highlight offsets keep pointing at the right characters.
  for (const rawLine of text.split('\n')) {
    const end = offset + rawLine.length;
    if (rawLine.trim() === '') {
      out.push([]);
    } else {
      // The line's own indentation is part of what it says; keep it, and hang
      // the wrapped continuations under it.
      const lead = /^[ \t]*/.exec(rawLine)?.[0] ?? '';
      const indent = lead.replace(/\t/g, '  ');
      const pad = displayLength(indent) < width - 1 ? indent : '';
      const body = rawLine.slice(lead.length);
      const bodyStart = offset + lead.length;
      const local = highlights
        .map(([start, stop]): [number, number] => [
          Math.max(start, bodyStart) - bodyStart,
          Math.min(stop, end) - bodyStart,
        ])
        .filter(([start, stop]) => stop > start);
      const wrapped = wrapSegments(
        segmentHighlights(body, local),
        Math.max(1, width - displayLength(pad)),
        500,
      );
      for (const line of wrapped) out.push(pad === '' ? line : [{ text: pad, hit: false }, ...line]);
    }
    offset = end + 1;
  }
  return out;
}

/**
 * Where the snippet sits inside the whole message, so the expanded view can
 * highlight and scroll to it. Tries the snippet text as a substring first
 * (exact, keeps multi-word matches), then each highlighted term on its own.
 * Returns `[]` when nothing can be located — a semantic snippet, for instance.
 */
export function locateHighlights(
  fullText: string,
  snippetText: string,
  snippetHighlights: [number, number][],
): [number, number][] {
  const withoutLead = snippetText.replace(/^[…\s]+/, '');
  const lead = snippetText.length - withoutLead.length;
  const core = withoutLead.replace(/[…\s]+$/, '');
  if (core !== '' && snippetHighlights.length > 0) {
    const offset = fullText.indexOf(core);
    if (offset >= 0) {
      const shifted = snippetHighlights
        .map(([start, end]): [number, number] => [offset + start - lead, offset + end - lead])
        .filter(([start, end]) => start >= 0 && end > start && end <= fullText.length);
      if (shifted.length > 0) return shifted;
    }
  }

  const terms = snippetHighlights
    .map(([start, end]) => snippetText.slice(start, end).trim())
    .filter((term) => term.length > 1);
  const found: [number, number][] = [];
  const haystack = fullText.toLowerCase();
  for (const term of terms) {
    const at = haystack.indexOf(term.toLowerCase());
    if (at >= 0) found.push([at, at + term.length]);
  }
  return found.sort((a, b) => a[0] - b[0]);
}

/* ------------------------------------------------------------------- rows */

export interface RowInput {
  selected: boolean;
  title: string;
  /** Short folder label, already disambiguated by {@link folderLabels}. */
  folder: string;
  age: string;
}

/** Explicit column widths for a row. Anything left out is computed from the width. */
export interface RowColumns {
  title?: number | undefined;
  folder?: number | undefined;
}

/** Two spaces between the title and the folder, so the columns read as columns. */
export const COLUMN_GAP = '  ';

/** How narrow and how wide the title column is allowed to get. */
export const TITLE_COLUMN_MIN = 28;
export const TITLE_COLUMN_MAX = 48;

/**
 * One list row, exactly `width` columns or fewer: marker, title, folder, age.
 * The columns are computed here rather than with flexbox so the width
 * invariant is unit testable.
 */
export function formatRow(row: RowInput, width: number, columns: number | RowColumns = {}): string {
  if (width <= 0) return '';
  const wanted: RowColumns = typeof columns === 'number' ? { folder: columns } : columns;
  const title = plain(row.title);
  const folder = plain(row.folder);
  const marker = row.selected ? ROW_MARKER_SELECTED : ROW_MARKER;
  const inner = width - marker.length;
  if (inner < 10) return truncate(`${marker}${title}`, width);

  // A fixed age column, right-aligned, so `1h` and `10d` line up down the list.
  const ageWidth = Math.min(AGE_WIDTH, inner);
  const age = padStart(truncate(row.age, ageWidth), ageWidth);
  const rest = inner - ageWidth - COLUMN_GAP.length - 1; // gaps: title→folder, folder→age
  if (rest < 12) return truncate(`${marker}${title}`, width);

  const wantedFolder = wanted.folder ?? Math.min(20, Math.floor(rest * 0.35));
  const folderCellWidth = Math.max(6, Math.min(wantedFolder, rest - 10));
  const room = rest - folderCellWidth;
  // Without an explicit title width the row fills the terminal, which is what
  // the width invariant is written against. With one, the table stays compact.
  const titleWidth = Math.max(1, Math.min(wanted.title ?? room, room));

  const titleCell = pad(truncate(title, titleWidth), titleWidth);
  const folderCell = pad(truncate(folder, folderCellWidth), folderCellWidth);
  return `${marker}${titleCell}${COLUMN_GAP}${folderCell} ${age}`;
}

/**
 * Width of the title column: as wide as the longest title on screen, within
 * bounds.
 *
 * Filling the terminal with a single column pushes the folder to the far right
 * edge, and a 73-cell gap between a 30-character title and its folder is not a
 * table, it is two lists that happen to share a line.
 */
export function titleColumnWidth(titles: string[]): number {
  const widest = Math.max(0, ...titles.map((title) => displayLength(plain(title))));
  return Math.max(TITLE_COLUMN_MIN, Math.min(widest, TITLE_COLUMN_MAX));
}

/** Width of the folder column: the widest label, within sane bounds. */
export function folderColumnWidth(labels: string[], width: number): number {
  const widest = Math.max(0, ...labels.map((label) => displayLength(label)));
  return Math.max(6, Math.min(widest, Math.max(6, Math.floor(width * 0.3))));
}

function pad(text: string, width: number): string {
  const missing = width - displayLength(text);
  return missing > 0 ? `${text}${' '.repeat(missing)}` : text;
}

function padStart(text: string, width: number): string {
  const missing = width - displayLength(text);
  return missing > 0 ? `${' '.repeat(missing)}${text}` : text;
}

/**
 * The scroll offset that keeps `selected` visible, given a window of
 * `visible` rows over `total` items. Never scrolls further than necessary.
 */
export function computeWindow(selected: number, total: number, visible: number, offset: number): number {
  if (total <= 0 || visible <= 0) return 0;
  const maxOffset = Math.max(0, total - visible);
  let next = Math.min(Math.max(0, offset), maxOffset);
  if (selected < next) next = selected;
  if (selected > next + visible - 1) next = selected - visible + 1;
  return Math.min(Math.max(0, next), maxOffset);
}

/* ----------------------------------------------------------------- layout */

export interface LayoutInput {
  rows: number;
  /** A query is being searched: up to 8 rows. Otherwise the recent list: 5. */
  hasQuery: boolean;
  /** The one status/progress line above the footer. */
  hasStatus: boolean;
  /** The `Recent` heading. */
  hasHeading: boolean;
}

export interface Heights {
  /** Rows available for the result list (the scroll window size). */
  listRows: number;
  /** Rows for the preview block; 0 hides it, blank line included. */
  previewRows: number;
}

/** Preview block: role/date header, two lines of text, the folder path. */
export const PREVIEW_ROWS = 4;

/**
 * Splits the terminal height between the list and the preview. Whitespace
 * only: one blank under the query line, one above the preview, one above the
 * footer, and one spare row (a frame exactly as tall as the terminal makes Ink
 * clear the scrollback when it unmounts).
 */
export function layoutHeights(input: LayoutInput): Heights {
  const chrome =
    1 /* query */ +
    1 /* blank */ +
    1 /* blank above footer */ +
    1 /* footer */ +
    1 /* spare */ +
    (input.hasStatus ? 1 : 0) +
    (input.hasHeading ? 1 : 0);
  const free = Math.max(1, input.rows - chrome);
  const maxList = input.hasQuery ? MAX_RESULT_ROWS : MAX_RECENT_ROWS;

  let listRows = Math.min(maxList, Math.max(1, free - PREVIEW_ROWS - 1));
  let previewRows = Math.max(0, Math.min(PREVIEW_ROWS, free - listRows - 1));
  if (previewRows < 2) {
    previewRows = 0;
    listRows = Math.min(maxList, Math.max(1, free));
  }
  return { listRows, previewRows };
}

/** Height of the scrollable message body in the expanded (Ctrl+E) view. */
export function expandedBodyRows(rows: number, hasStatus: boolean): number {
  const chrome =
    1 /* query */ +
    1 /* blank */ +
    1 /* the one row */ +
    1 /* blank */ +
    1 /* header */ +
    1 /* blank above footer */ +
    1 /* footer */ +
    1 /* spare */ +
    (hasStatus ? 1 : 0);
  return Math.max(1, rows - chrome);
}

/** Scroll offset that puts `line` comfortably on screen. */
export function scrollToLine(line: number, bodyRows: number, totalLines: number): number {
  const maxOffset = Math.max(0, totalLines - bodyRows);
  const wanted = line - Math.floor(bodyRows / 3);
  return Math.min(Math.max(0, wanted), maxOffset);
}

/* --------------------------------------------------------------- the line */

export interface QueryLineParts {
  prompt: string;
  before: string;
  /** One visible cell: a block at the end of the line, a bar inside it. */
  cursor: string;
  after: string;
}

/** Block at the end of the text, thin bar when the cursor sits inside it. */
export const CURSOR_END = '█';
export const CURSOR_INLINE = '▏';

/**
 * The search box: prompt, text and a cursor that is a *glyph*, not a colour,
 * so it is still visible with `NO_COLOR` or on a monochrome terminal. Scrolls
 * horizontally to keep the cursor in view; never wider than `width`.
 */
export function queryLineParts(text: string, cursor: number, width: number): QueryLineParts {
  const safe = plain(text);
  const chars = [...safe];
  const at = Math.max(0, Math.min(chars.length, cursor));
  const glyph = at >= chars.length ? CURSOR_END : CURSOR_INLINE;
  const prompt = width >= 6 ? PROMPT : ' ';
  const room = Math.max(0, width - displayLength(prompt) - 1);

  const before = chars.slice(0, at).join('');
  const after = chars.slice(at).join('');
  if (displayLength(before) + displayLength(after) <= room) {
    return { prompt, before, cursor: glyph, after };
  }

  const afterBudget = Math.min(displayLength(after), Math.max(0, Math.floor(room / 3)));
  const beforeShown = tail(before, Math.max(0, room - afterBudget));
  const afterShown = truncate(after, Math.max(0, room - displayLength(beforeShown)));
  return { prompt, before: beforeShown, cursor: glyph, after: afterShown };
}

/** The whole search box as one string, for tests and for narrow fallbacks. */
export function queryLine(text: string, cursor: number, width: number): string {
  const parts = queryLineParts(text, cursor, width);
  return `${parts.prompt}${parts.before}${parts.cursor}${parts.after}`;
}

/* --------------------------------------------------------------- footer */

export interface FooterHint {
  text: string;
  /** Lower survives longer: 1 is `⏎ resume`, 7 is the sort toggle. */
  priority: number;
}

/** Gap between footer hints. */
export const FOOTER_GAP = '   ';

/** Width the whole hint set is expected to survive at. */
export const FOOTER_FULL_WIDTH = 80;

/** What the picker is showing, as far as the footer is concerned. */
export interface FooterState {
  /** The expanded (^E) view rather than the list. */
  expanded: boolean;
  /** More than one match to step through. */
  hasMatches: boolean;
  /** Something is in the preview, so ^E has something to open. */
  hasPreview: boolean;
  /** The user has typed a query, so sorting means something. */
  hasQuery: boolean;
  /** A row is selected. */
  hasCurrent: boolean;
  /** The browser action is wired up. */
  canOpenBrowser: boolean;
  sort: 'relevance' | 'recent';
}

/**
 * Every hint the picker can show, in the order it shows them.
 *
 * The labels are short on purpose: the full set has to fit in 80 columns,
 * because a footer that silently drops `^R` at the most common terminal width
 * is a feature nobody ever finds. `^R` names the order it will switch *to* —
 * a button says what it does, not what is already true.
 */
export function footerHints(state: FooterState): FooterHint[] {
  const matches: FooterHint[] = state.hasMatches ? [{ text: '←→ matches', priority: 3 }] : [];
  const copy: FooterHint[] = state.hasCurrent ? [{ text: '^Y copy', priority: 4 }] : [];
  const browser: FooterHint[] =
    state.canOpenBrowser && state.hasCurrent ? [{ text: '^O web', priority: 5 }] : [];

  if (state.expanded) {
    return [
      { text: '⏎ resume', priority: 1 },
      ...matches,
      { text: '↑↓ scroll', priority: 3 },
      { text: '^E list', priority: 6 },
      ...copy,
      ...browser,
      { text: 'esc list', priority: 2 },
    ];
  }

  return [
    { text: '⏎ resume', priority: 1 },
    ...matches,
    ...(state.hasPreview ? [{ text: '^E full', priority: 6 }] : []),
    ...(state.hasQuery ? [{ text: `^R ${state.sort === 'relevance' ? 'recent' : 'best'}`, priority: 7 }] : []),
    ...copy,
    ...browser,
    { text: 'esc quit', priority: 2 },
  ];
}

/**
 * The footer, never wider than the terminal: hints are dropped lowest
 * priority first until the line fits. The order given is the order shown.
 */
export function fitFooter(hints: FooterHint[], width: number): string {
  const kept = [...hints];
  for (;;) {
    const line = ` ${kept.map((hint) => hint.text).join(FOOTER_GAP)}`;
    if (kept.length <= 1 || displayLength(line) <= width) return truncate(line, width);
    let worst = 0;
    for (let index = 1; index < kept.length; index += 1) {
      if (kept[index]!.priority > kept[worst]!.priority) worst = index;
    }
    kept.splice(worst, 1);
  }
}

/** The last `width` cells of `text`, never splitting a wide glyph. */
function tail(text: string, width: number): string {
  if (width <= 0) return '';
  const chars = [...text];
  let used = 0;
  let start = chars.length;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const next = charWidth(chars[i]!.codePointAt(0) ?? 0);
    if (used + next > width) break;
    used += next;
    start = i;
  }
  return chars.slice(start).join('');
}
