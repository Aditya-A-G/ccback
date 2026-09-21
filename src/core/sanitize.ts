/**
 * Transcript text is hostile input.
 *
 * A session title or message can contain ESC, OSC and BEL sequences. Printed
 * raw they would move the cursor, repaint colours, break the TUI's column
 * arithmetic, and — with OSC 52 — write the user's clipboard. Every transcript
 * string that ends up on a screen — message text, title, cwd, git branch,
 * uuid — goes through {@link sanitizeText} or {@link sanitizeLine} at the
 * parser boundary, before insert, so the FTS offsets that highlight ranges
 * index into stay correct. Timestamps are the one field stored raw, and they
 * are never printed raw: they are parsed into a date, or shown as `—`. Front
 * ends sanitise again on the way out as defence in depth.
 */

/**
 * Control (`Cc`) and format (`Cf`) characters. `\n` and `\t` are kept: they are
 * real content in a transcript and every front end knows how to fold them.
 *
 * Known consequence: `Cf` includes U+200D ZERO WIDTH JOINER, so a joined emoji
 * such as 👨‍👩‍👧 is stored as its component glyphs.
 */
const CONTROL_RE = /[\p{Cc}\p{Cf}]/gu;

/** A high or low surrogate without its partner: invalid UTF-16 that breaks widths. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The three line breaks that are not `\n`: NEL (U+0085), LINE SEPARATOR
 * (U+2028) and PARAGRAPH SEPARATOR (U+2029). Terminals and browsers disagree
 * about them — some start a new line, and U+2028 ends a statement in older
 * JavaScript — so they become plain spaces everywhere, which is also what
 * makes a "single line" field genuinely single-line.
 */
const LINE_BREAK_RE = new RegExp('[\u0085\u2028\u2029]', 'g');

/**
 * Removes control and format characters (keeping `\n` and `\t`) and lone
 * surrogates, and turns the exotic line breaks into spaces.
 */
export function sanitizeText(value: string): string {
  if (value === '') return '';
  return value
    .replace(LINE_BREAK_RE, ' ')
    .replace(CONTROL_RE, (ch) => (ch === '\n' || ch === '\t' ? ch : ''))
    .replace(LONE_SURROGATE_RE, '');
}

/**
 * {@link sanitizeText} for a field that must stay on one line: newlines and
 * tabs become single spaces, so a title containing `\n` cannot push a row.
 */
export function sanitizeLine(value: string): string {
  return sanitizeText(value).replace(/[\n\t]+/g, ' ');
}

/** True when `value` carries anything {@link sanitizeText} would strip. */
export function hasControlCharacters(value: string): boolean {
  return sanitizeText(value) !== value;
}
