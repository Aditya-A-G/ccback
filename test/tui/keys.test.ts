import { describe, expect, it } from 'vitest';
import { classifyKey, type KeyFlags } from '../../src/tui/keys.js';

const key = (flags: Partial<KeyFlags> = {}): Partial<KeyFlags> => flags;

describe('classifyKey', () => {
  it('maps the always-available bindings', () => {
    expect(classifyKey('c', key({ ctrl: true }))).toEqual({ type: 'quit' });
    expect(classifyKey('', key({ escape: true }))).toEqual({ type: 'escape' });
    expect(classifyKey('', key({ return: true }))).toEqual({ type: 'resume' });
    expect(classifyKey('y', key({ ctrl: true }))).toEqual({ type: 'copy' });
    expect(classifyKey('o', key({ ctrl: true }))).toEqual({ type: 'browser' });
    expect(classifyKey('r', key({ ctrl: true }))).toEqual({ type: 'sort' });
    expect(classifyKey('e', key({ ctrl: true }))).toEqual({ type: 'fullMessage' });
  });

  it('keeps Ctrl+S inert and binds Tab / Shift+Tab to the matches', () => {
    expect(classifyKey('s', key({ ctrl: true }))).toBeNull();
    expect(classifyKey('', key({ tab: true }))).toEqual({ type: 'nextMatch' });
    expect(classifyKey('', key({ tab: true, shift: true }))).toEqual({ type: 'prevMatch' });
    expect(classifyKey('[Z', key({}))).toEqual({ type: 'prevMatch' });
    expect(classifyKey('d', key({ ctrl: true }))).toBeNull();
  });

  it('maps line editing, including the keys Ctrl+E cannot have', () => {
    expect(classifyKey('a', key({ ctrl: true }))).toEqual({ type: 'lineStart' });
    expect(classifyKey('', key({ home: true }))).toEqual({ type: 'lineStart' });
    expect(classifyKey('', key({ end: true }))).toEqual({ type: 'lineEnd' });
    expect(classifyKey('k', key({ ctrl: true }))).toEqual({ type: 'killToEnd' });
    expect(classifyKey('u', key({ ctrl: true }))).toEqual({ type: 'clearToStart' });
    expect(classifyKey('w', key({ ctrl: true }))).toEqual({ type: 'deleteWordBack' });
    expect(classifyKey('', key({ backspace: true }))).toEqual({ type: 'backspace' });
    expect(classifyKey('', key({ backspace: true, meta: true }))).toEqual({ type: 'deleteWordBack' });
    expect(classifyKey('', key({ delete: true }))).toEqual({ type: 'deleteForward' });
  });

  it('maps the word-jump families every terminal sends', () => {
    // ESC-b / ESC-f (Terminal.app, Ghostty "Esc+" profiles)
    expect(classifyKey('b', key({ meta: true }))).toEqual({ type: 'wordLeft' });
    expect(classifyKey('f', key({ meta: true }))).toEqual({ type: 'wordRight' });
    // \x1b[1;3D / \x1b[1;9D (iTerm2, kitty, VS Code)
    expect(classifyKey('', key({ leftArrow: true, meta: true }))).toEqual({ type: 'wordLeft' });
    expect(classifyKey('', key({ rightArrow: true, meta: true }))).toEqual({ type: 'wordRight' });
    // \x1b[1;5D / \x1b[1;5C (Windows Terminal, Linux terminals)
    expect(classifyKey('', key({ leftArrow: true, ctrl: true }))).toEqual({ type: 'wordLeft' });
    expect(classifyKey('', key({ rightArrow: true, ctrl: true }))).toEqual({ type: 'wordRight' });
    // Meta+backspace that arrives as the raw byte rather than a flag.
    expect(classifyKey('\u007F', key({ meta: true }))).toEqual({ type: 'deleteWordBack' });
  });

  it('falls back to the raw sequence when Ink leaves one undecoded', () => {
    expect(classifyKey('[1;3D', key())).toEqual({ type: 'wordLeft' });
    expect(classifyKey('[1;5C', key())).toEqual({ type: 'wordRight' });
    expect(classifyKey('[H', key())).toEqual({ type: 'lineStart' });
    expect(classifyKey('[4~', key())).toEqual({ type: 'lineEnd' });
    expect(classifyKey('[3~', key())).toEqual({ type: 'deleteForward' });
    expect(classifyKey('[5~', key())).toEqual({ type: 'pageUp' });
    expect(classifyKey('[6~', key())).toEqual({ type: 'pageDown' });
  });

  it('types printable text, including a whole paste, and nothing else', () => {
    expect(classifyKey('r', key())).toEqual({ type: 'insert', text: 'r' });
    expect(classifyKey('c', key())).toEqual({ type: 'insert', text: 'c' });
    expect(classifyKey('recording videos', key())).toEqual({
      type: 'insert',
      text: 'recording videos',
    });
    expect(classifyKey('', key())).toBeNull();
  });

  it('never lets an unbound modifier combination reach the query', () => {
    expect(classifyKey('z', key({ ctrl: true }))).toBeNull();
    expect(classifyKey('q', key({ meta: true }))).toBeNull();
  });
});
