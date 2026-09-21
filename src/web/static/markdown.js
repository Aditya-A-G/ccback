/*
 * A deliberately small Markdown *parser* for the transcript reader.
 *
 * It only produces data. Nothing here touches the DOM, so it cannot inject
 * anything; app.js turns these tokens into elements with createElement and
 * textContent. Anything it is unsure about comes back as plain text, which is
 * always a correct rendering of a transcript.
 *
 * Supported: paragraphs, # headings, - and 1. lists, ``` fenced code, `inline
 * code`, **bold**, *italic*, and [label](url) — links are rendered as text, not
 * as anchors, because a transcript URL is not something to make clickable.
 *
 * The invariant, enforced by a fuzz test: every non-whitespace character of the
 * input reaches the tokens, in order, except the syntax the renderer draws
 * instead of printing — the `#` of a heading, the `-`/`*`/`+` or `1.`/`1)` of a
 * list item, the ```/~~~ lines of a fence, the `*`/`**`/`` ` `` delimiters of
 * emphasis and inline code, and the `[](…)` punctuation of a link. A fence's
 * info string is kept on the token (`info`), not dropped, and a fence that
 * never closes degrades to one `plain` token holding the rest of the text.
 */

/** Longer than this is not prose; it is rendered verbatim instead of parsed. */
export const MAX_MARKDOWN_CHARS = 100000;

/** Beyond this a "paragraph" is pathological input; the rest stays literal. */
export const MAX_INLINE_SPANS = 500;

/** A URL longer than this is not a link anyone typed. */
const MAX_HREF = 2048;

/**
 * `text` -> tokens:
 *   { type: 'plain',     text }
 *   { type: 'paragraph', spans }
 *   { type: 'heading',   level, spans }
 *   { type: 'list',      ordered, items: spans[] }
 *   { type: 'code',      info, text }
 * spans:
 *   { type: 'text'|'strong'|'em'|'code', text }
 *   { type: 'link', text, href }
 */
export function parseMarkdown(text) {
  if (typeof text !== 'string' || text === '') return [];
  if (text.length > MAX_MARKDOWN_CHARS) return [{ type: 'plain', text }];
  try {
    return parseBlocks(text);
  } catch {
    // Any surprise degrades to exactly what the reader showed before.
    return [{ type: 'plain', text }];
  }
}

function parseBlocks(text) {
  const lines = text.split('\n');
  const tokens = [];
  let paragraph = [];
  let list = null;

  const closeParagraph = () => {
    if (paragraph.length === 0) return;
    tokens.push({ type: 'paragraph', spans: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  const closeList = () => {
    if (list === null) return;
    tokens.push({ type: 'list', ordered: list.ordered, items: list.items.map(parseInline) });
    list = null;
  };
  const closeAll = () => {
    closeParagraph();
    closeList();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // A fence opens a block only if the rest of its line cannot close one: what
    // follows ```/~~~ is an info string ("js"), never content, so "```npm i```"
    // is an inline code span and belongs to the paragraph path below.
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence && !/```|~~~/.test(fence[2])) {
      const marker = fence[1][0];
      const closer = marker === '`' ? /^\s{0,3}`{3,}\s*$/ : /^\s{0,3}~{3,}\s*$/;
      let close = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (closer.test(lines[j])) {
          close = j;
          break;
        }
      }
      closeAll();
      if (close === -1) {
        // Nothing closed it: rather than guess where the code ends, show the
        // rest exactly as written. Not one character is dropped.
        tokens.push({ type: 'plain', text: lines.slice(i).join('\n') });
        break;
      }
      tokens.push({ type: 'code', info: fence[2].trim(), text: lines.slice(i + 1, close).join('\n') });
      i = close;
      continue;
    }

    if (line.trim() === '') {
      closeAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeAll();
      tokens.push({ type: 'heading', level: heading[1].length, spans: parseInline(heading[2].trim()) });
      continue;
    }

    const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      closeParagraph();
      const ordered = bullet === null;
      const item = (bullet ? bullet[1] : numbered[1]).trim();
      if (list !== null && list.ordered !== ordered) closeList();
      if (list === null) list = { ordered, items: [] };
      list.items.push(item);
      continue;
    }

    if (list !== null) {
      // A wrapped continuation of the item above.
      list.items[list.items.length - 1] += ' ' + line.trim();
      continue;
    }

    paragraph.push(line);
  }

  closeAll();
  return tokens;
}

/**
 * Splits one block into styled runs. Single pass, no backtracking: a megabyte
 * of `*` costs a megabyte of work and produces literal asterisks.
 */
export function parseInline(text) {
  const spans = [];
  let buffer = '';
  let index = 0;

  const flush = () => {
    if (buffer !== '') {
      spans.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };
  const full = () => spans.length >= MAX_INLINE_SPANS;

  /**
   * `indexOf` with the previous answer remembered. Without this, a block of
   * 100 000 unmatched `[` would scan to the end 100 000 times; with it every
   * character is looked at a constant number of times.
   */
  const finder = (needle) => {
    let cached = -2;
    return (from) => {
      if (cached === -1) return -1;
      if (cached >= from) return cached;
      cached = text.indexOf(needle, from);
      return cached;
    };
  };
  /**
   * A backtick run closes only with a run of the same length, so "```npm i```"
   * is one code span and `` `a` `` inside it stays literal. Every run is found
   * once and linked to the next run of its length, which keeps a block of
   * 90 000 backticks linear.
   */
  const runs = [];
  const runAt = new Map();
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '`') continue;
    let length = 1;
    while (text[i + length] === '`') length += 1;
    runAt.set(i, runs.length);
    runs.push({ start: i, length, next: -1 });
    i += length - 1;
  }
  const lastOfLength = new Map();
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const seen = lastOfLength.get(runs[i].length);
    if (seen !== undefined) runs[i].next = seen;
    lastOfLength.set(runs[i].length, i);
  }

  const nextStrong = finder('**');
  const nextEm = finder('*');
  const nextBracket = finder(']');
  const nextParen = finder(')');

  while (index < text.length) {
    const ch = text[index];

    if (ch === '`' && !full()) {
      const run = runs[runAt.get(index)];
      const close = run.next === -1 ? undefined : runs[run.next];
      if (close !== undefined) {
        flush();
        spans.push({ type: 'code', text: text.slice(run.start + run.length, close.start) });
        index = close.start + close.length;
        continue;
      }
      // An opener with no partner is literal text, run and all.
      buffer += text.slice(run.start, run.start + run.length);
      index = run.start + run.length;
      continue;
    }

    if (ch === '*' && text[index + 1] === '*' && !full()) {
      const end = nextStrong(index + 2);
      if (end > index + 2) {
        flush();
        spans.push({ type: 'strong', text: text.slice(index + 2, end) });
        index = end + 2;
        continue;
      }
    }

    if (ch === '*' && !full()) {
      const end = nextEm(index + 1);
      if (end > index + 1) {
        flush();
        spans.push({ type: 'em', text: text.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    if (ch === '[' && !full()) {
      const close = nextBracket(index + 1);
      if (close !== -1 && text[close + 1] === '(') {
        const paren = nextParen(close + 2);
        const label = close > index ? text.slice(index + 1, close) : '';
        const href = paren !== -1 ? text.slice(close + 2, paren) : '';
        if (
          paren !== -1 &&
          href.length <= MAX_HREF &&
          label.indexOf('\n') === -1 &&
          href.indexOf('\n') === -1 &&
          href.indexOf(' ') === -1
        ) {
          flush();
          // The href is shown, never followed: `javascript:` is just letters here.
          spans.push({ type: 'link', text: label, href });
          index = paren + 1;
          continue;
        }
      }
    }

    buffer += ch;
    index += 1;
  }

  flush();
  return spans;
}
