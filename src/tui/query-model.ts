/**
 * The search box as a value: text plus a cursor position.
 *
 * Every edit is a pure function of the previous state, so line editing is unit
 * tested without a terminal. The cursor counts **code points**, never UTF-16
 * units, so a surrogate pair or an emoji is one step and is never split in half.
 */

/** Text plus the cursor offset, in code points, in `[0, length]`. */
export interface QueryState {
  text: string;
  cursor: number;
}

const chars = (text: string): string[] => [...text];

/** Builds a state, clamping the cursor into range. Defaults to end of line. */
export function makeQuery(text: string, cursor?: number): QueryState {
  const length = chars(text).length;
  const at = cursor === undefined ? length : Math.max(0, Math.min(length, Math.trunc(cursor)));
  return { text, cursor: at };
}

/** The empty search box. */
export const EMPTY_QUERY: QueryState = { text: '', cursor: 0 };

/** Cursor at the end, i.e. the state after typing `text`. */
export function queryLength(state: QueryState): number {
  return chars(state.text).length;
}

/**
 * What may be typed or pasted into the box: control characters are dropped and
 * newlines and tabs become single spaces, so a multi-line paste stays one line.
 */
export function cleanInsert(text: string): string {
  return text
    .replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/gu, ' ')
    .replace(/[\u0000-\u001F\u007F]/gu, '');
}

/** Inserts text at the cursor and leaves the cursor after it. */
export function insertText(state: QueryState, insert: string): QueryState {
  const clean = cleanInsert(insert);
  if (clean === '') return state;
  const list = chars(state.text);
  const added = chars(clean);
  const next = [...list.slice(0, state.cursor), ...added, ...list.slice(state.cursor)];
  return { text: next.join(''), cursor: state.cursor + added.length };
}

/** Deletes the code point before the cursor. */
export function backspace(state: QueryState): QueryState {
  if (state.cursor === 0) return state;
  const list = chars(state.text);
  const next = [...list.slice(0, state.cursor - 1), ...list.slice(state.cursor)];
  return { text: next.join(''), cursor: state.cursor - 1 };
}

/** Deletes the code point under the cursor (the Delete key). */
export function deleteForward(state: QueryState): QueryState {
  const list = chars(state.text);
  if (state.cursor >= list.length) return state;
  const next = [...list.slice(0, state.cursor), ...list.slice(state.cursor + 1)];
  return { text: next.join(''), cursor: state.cursor };
}

const isWordChar = (ch: string): boolean => /[\p{L}\p{N}_]/u.test(ch);

/** Start of the word before the cursor: skip separators, then word characters. */
export function wordStart(state: QueryState): number {
  const list = chars(state.text);
  let at = state.cursor;
  while (at > 0 && !isWordChar(list[at - 1] ?? '')) at -= 1;
  while (at > 0 && isWordChar(list[at - 1] ?? '')) at -= 1;
  return at;
}

/** End of the word after the cursor: skip separators, then word characters. */
export function wordEnd(state: QueryState): number {
  const list = chars(state.text);
  let at = state.cursor;
  while (at < list.length && !isWordChar(list[at] ?? '')) at += 1;
  while (at < list.length && isWordChar(list[at] ?? '')) at += 1;
  return at;
}

/** Option+Backspace / Ctrl+W: deletes the word before the cursor. */
export function deleteWordBackward(state: QueryState): QueryState {
  const start = wordStart(state);
  if (start === state.cursor) return state;
  const list = chars(state.text);
  const next = [...list.slice(0, start), ...list.slice(state.cursor)];
  return { text: next.join(''), cursor: start };
}

/** Ctrl+K: removes everything from the cursor to the end of the line. */
export function killToEnd(state: QueryState): QueryState {
  const list = chars(state.text);
  if (state.cursor >= list.length) return state;
  return { text: list.slice(0, state.cursor).join(''), cursor: state.cursor };
}

/** Ctrl+U (what macOS terminals send for Cmd+Backspace): clears to line start. */
export function clearToStart(state: QueryState): QueryState {
  if (state.cursor === 0) return state;
  const list = chars(state.text);
  return { text: list.slice(state.cursor).join(''), cursor: 0 };
}

export function moveLeft(state: QueryState): QueryState {
  return state.cursor === 0 ? state : { text: state.text, cursor: state.cursor - 1 };
}

export function moveRight(state: QueryState): QueryState {
  const length = queryLength(state);
  return state.cursor >= length ? state : { text: state.text, cursor: state.cursor + 1 };
}

export function moveWordLeft(state: QueryState): QueryState {
  return { text: state.text, cursor: wordStart(state) };
}

export function moveWordRight(state: QueryState): QueryState {
  return { text: state.text, cursor: wordEnd(state) };
}

export function moveLineStart(state: QueryState): QueryState {
  return { text: state.text, cursor: 0 };
}

export function moveLineEnd(state: QueryState): QueryState {
  return { text: state.text, cursor: queryLength(state) };
}
