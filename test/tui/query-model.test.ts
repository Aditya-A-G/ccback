import { describe, expect, it } from 'vitest';
import {
  backspace,
  clearToStart,
  cleanInsert,
  deleteForward,
  deleteWordBackward,
  EMPTY_QUERY,
  insertText,
  killToEnd,
  makeQuery,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveWordLeft,
  moveWordRight,
  type QueryState,
} from '../../src/tui/query-model.js';

/** `record|ing videos` — the cursor is written as a bar. */
const at = (marked: string): QueryState => {
  const cursor = [...marked].indexOf('|');
  const text = marked.replace('|', '');
  return makeQuery(text, cursor);
};
const show = (state: QueryState): string => {
  const chars = [...state.text];
  return [...chars.slice(0, state.cursor), '|', ...chars.slice(state.cursor)].join('');
};

describe('the cursor', () => {
  it('starts at the end of a pre-filled query and clamps out-of-range asks', () => {
    expect(makeQuery('recording')).toEqual({ text: 'recording', cursor: 9 });
    expect(makeQuery('recording', 99)).toEqual({ text: 'recording', cursor: 9 });
    expect(makeQuery('recording', -4)).toEqual({ text: 'recording', cursor: 0 });
    expect(EMPTY_QUERY).toEqual({ text: '', cursor: 0 });
  });

  it('counts code points, never UTF-16 halves', () => {
    const state = makeQuery('a😀b');
    expect(state.cursor).toBe(3);
    expect(show(moveLeft(state))).toBe('a😀|b');
    expect(show(moveLeft(moveLeft(state)))).toBe('a|😀b');
    expect(backspace(makeQuery('a😀')).text).toBe('a');
  });

  it('moves left and right and stops at both ends', () => {
    expect(show(moveLeft(at('ab|c')))).toBe('a|bc');
    expect(show(moveLeft(at('|abc')))).toBe('|abc');
    expect(show(moveRight(at('ab|c')))).toBe('abc|');
    expect(show(moveRight(at('abc|')))).toBe('abc|');
  });

  it('jumps to line start and end (Ctrl+A, Home / End)', () => {
    expect(show(moveLineStart(at('recording vi|deos')))).toBe('|recording videos');
    expect(show(moveLineEnd(at('|recording videos')))).toBe('recording videos|');
  });

  it('jumps by words (Option+← / Option+→, ESC-b / ESC-f)', () => {
    expect(show(moveWordLeft(at('recording videos|')))).toBe('recording |videos');
    expect(show(moveWordLeft(at('recording |videos')))).toBe('|recording videos');
    expect(show(moveWordLeft(at('|recording')))).toBe('|recording');
    expect(show(moveWordRight(at('|recording videos')))).toBe('recording| videos');
    expect(show(moveWordRight(at('recording| videos')))).toBe('recording videos|');
    expect(show(moveWordRight(at('recording videos|')))).toBe('recording videos|');
    // Punctuation counts as a separator, not as a word.
    expect(show(moveWordLeft(at('a.b c|')))).toBe('a.b |c');
    expect(show(moveWordLeft(at('a.b |c')))).toBe('a.|b c');
  });
});

describe('typing and pasting', () => {
  it('inserts at the cursor, not at the end', () => {
    expect(show(insertText(at('recording |videos'), 'my ')))
      .toBe('recording my |videos');
    expect(insertText(EMPTY_QUERY, 'hi').text).toBe('hi');
  });

  it('turns a multi-line paste into one line and drops control characters', () => {
    expect(cleanInsert('first\nsecond')).toBe('first second');
    expect(cleanInsert('a\r\nb\tc')).toBe('a b c');
    expect(cleanInsert('bell\u0007and\u001Bescape')).toBe('bellandescape');
    const pasted = insertText(at('see |now'), 'one\ntwo\nthree ');
    expect(pasted.text).toBe('see one two three now');
    expect(show(pasted)).toBe('see one two three |now');
  });

  it('ignores an insert that cleans down to nothing', () => {
    const state = at('abc|');
    expect(insertText(state, '\u0000')).toBe(state);
  });
});

describe('deleting', () => {
  it('backspace removes the character before the cursor only', () => {
    expect(show(backspace(at('recording| videos')))).toBe('recordin| videos');
    expect(show(backspace(at('|videos')))).toBe('|videos');
  });

  it('the Delete key removes the character under the cursor', () => {
    expect(show(deleteForward(at('recor|ding')))).toBe('recor|ing');
    expect(show(deleteForward(at('recording|')))).toBe('recording|');
  });

  it('Option+Backspace and Ctrl+W delete the word before the cursor', () => {
    expect(show(deleteWordBackward(at('recording videos|')))).toBe('recording |');
    expect(show(deleteWordBackward(at('recording |')))).toBe('|');
    expect(show(deleteWordBackward(at('recording videos| today')))).toBe('recording | today');
    expect(show(deleteWordBackward(at('|videos')))).toBe('|videos');
  });

  it('Ctrl+K kills to the end of the line', () => {
    expect(show(killToEnd(at('recording |videos')))).toBe('recording |');
    expect(show(killToEnd(at('recording videos|')))).toBe('recording videos|');
  });

  it('Ctrl+U (Cmd+Backspace) clears to the start of the line', () => {
    expect(show(clearToStart(at('recording |videos')))).toBe('|videos');
    expect(show(clearToStart(at('|videos')))).toBe('|videos');
    expect(clearToStart(at('everything|')).text).toBe('');
  });
});
