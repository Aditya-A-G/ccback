/**
 * Key decoding for the picker.
 *
 * Ink's `useInput` is the transport: Ink 7 splits stdin into one event per key
 * (or one per paste) and `parse-keypress` already decodes the escape sequences
 * real terminals send, including the ones this picker needs:
 *
 * | what the user presses                  | bytes on stdin                     | decoded as            |
 * | -------------------------------------- | ---------------------------------- | --------------------- |
 * | Option+← / Option+→ (Esc+ profiles)    | `\x1bb` / `\x1bf`                  | meta + `b` / `f`      |
 * | Option+← / Option+→ (xterm profiles)   | `\x1b[1;3D` / `\x1b[1;3C`          | meta + left/right     |
 * | Ctrl+← / Ctrl+→ (Windows Terminal,     | `\x1b[1;5D` / `\x1b[1;5C`          | ctrl + left/right     |
 * |   VS Code, Linux terminals)            |                                    |                       |
 * | Option+← / Option+→ (iTerm2 meta)      | `\x1b[1;9D` / `\x1b[1;9C`          | meta + left/right     |
 * | Option+Backspace                       | `\x1b\x7f`                         | meta + backspace      |
 * | Cmd+Backspace (as macOS sends it)      | `\x15`                             | ctrl + `u`            |
 * | Home / End                             | `\x1b[H` `\x1bOH` `\x1b[1~`        | home / end            |
 * |                                        | `\x1b[F` `\x1bOF` `\x1b[4~` `[8~`  |                       |
 * | Delete (forward)                       | `\x1b[3~`                          | delete                |
 * | paste (bracketed or not)               | `\x1b[200~…\x1b[201~` or a chunk   | one multi-char input  |
 *
 * Anything Ink leaves undecoded still arrives as the raw sequence minus its
 * leading ESC, so {@link RAW_SEQUENCES} catches those too.
 *
 * **Ctrl+E is "full message", not end-of-line.** The expanded view needs a
 * always-available binding and Ctrl+E is the only free one; end-of-line is the
 * End key (`\x1b[F`, `\x1bOF`, `\x1b[4~`, `\x1b[8~`), which is also what
 * Cmd+→ sends in terminal profiles that map it to End. Where a terminal maps
 * Cmd+→ to something else, end-of-line is unsupported. Ctrl+A stays line start.
 */

/** The subset of Ink's `Key` this picker reads. */
export interface KeyFlags {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

/** What a keypress means to the picker, before any state is consulted. */
export type KeyAction =
  | { type: 'quit' }
  | { type: 'resume' }
  | { type: 'escape' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'wordLeft' }
  | { type: 'wordRight' }
  | { type: 'lineStart' }
  | { type: 'lineEnd' }
  | { type: 'pageUp' }
  | { type: 'pageDown' }
  | { type: 'backspace' }
  | { type: 'deleteForward' }
  | { type: 'deleteWordBack' }
  | { type: 'killToEnd' }
  | { type: 'clearToStart' }
  | { type: 'copy' }
  | { type: 'browser' }
  | { type: 'fullMessage' }
  | { type: 'sort' }
  | { type: 'insert'; text: string };

/** Escape sequences Ink may hand over undecoded, minus the leading ESC. */
export const RAW_SEQUENCES: Record<string, KeyAction> = {
  '[1;3D': { type: 'wordLeft' },
  '[1;5D': { type: 'wordLeft' },
  '[1;9D': { type: 'wordLeft' },
  '[1;3C': { type: 'wordRight' },
  '[1;5C': { type: 'wordRight' },
  '[1;9C': { type: 'wordRight' },
  '[H': { type: 'lineStart' },
  '[1~': { type: 'lineStart' },
  '[7~': { type: 'lineStart' },
  OH: { type: 'lineStart' },
  '[F': { type: 'lineEnd' },
  '[4~': { type: 'lineEnd' },
  '[8~': { type: 'lineEnd' },
  OF: { type: 'lineEnd' },
  '[3~': { type: 'deleteForward' },
  '[5~': { type: 'pageUp' },
  '[6~': { type: 'pageDown' },
};

/**
 * Maps one Ink keypress to a picker action, or null when nothing should
 * happen. Pure: the caller decides what an action means in the current view.
 */
export function classifyKey(input: string, key: Partial<KeyFlags>): KeyAction | null {
  // Ctrl+C always quits, before anything else can claim the keypress.
  if (key.ctrl && input === 'c') return { type: 'quit' };
  if (key.escape) return { type: 'escape' };
  if (key.return) return { type: 'resume' };

  // Backspace before Delete: Ink reports both, and every terminal sends a
  // plain backspace for the key above Return.
  if (key.backspace) return key.meta ? { type: 'deleteWordBack' } : { type: 'backspace' };
  if (key.delete) return { type: 'deleteForward' };

  if (key.ctrl) {
    switch (input) {
      case 'a':
        return { type: 'lineStart' };
      case 'e':
        return { type: 'fullMessage' };
      case 'k':
        return { type: 'killToEnd' };
      case 'u':
        return { type: 'clearToStart' };
      case 'w':
        return { type: 'deleteWordBack' };
      case 'y':
        return { type: 'copy' };
      case 'o':
        return { type: 'browser' };
      case 'r':
        return { type: 'sort' };
      case 'p':
        return { type: 'up' };
      case 'n':
        return { type: 'down' };
      case 'b':
        return { type: 'left' };
      case 'f':
        return { type: 'right' };
      default:
        break;
    }
    if (key.leftArrow) return { type: 'wordLeft' };
    if (key.rightArrow) return { type: 'wordRight' };
    // Unbound control keys (Ctrl+S among them) do nothing and type nothing.
    return null;
  }

  if (key.meta) {
    if (input === 'b' || key.leftArrow) return { type: 'wordLeft' };
    if (input === 'f' || key.rightArrow) return { type: 'wordRight' };
    if (input === '\u007F' || input === '\b') return { type: 'deleteWordBack' };
    return null;
  }

  if (key.leftArrow) return { type: 'left' };
  if (key.rightArrow) return { type: 'right' };
  if (key.upArrow) return { type: 'up' };
  if (key.downArrow) return { type: 'down' };
  if (key.pageUp) return { type: 'pageUp' };
  if (key.pageDown) return { type: 'pageDown' };
  if (key.home) return { type: 'lineStart' };
  if (key.end) return { type: 'lineEnd' };
  // Tab is deliberately unbound: search has one mode, so there is nothing to
  // cycle, and inserting a tab into the query would only be noise.
  if (key.tab) return null;

  if (input.length > 1) {
    const raw = RAW_SEQUENCES[input];
    if (raw) return raw;
  }
  if (input === '') return null;
  return { type: 'insert', text: input };
}
