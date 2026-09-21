/**
 * The reader must never lose a character (second review, must-fix 1).
 *
 * A fence marker with text on the same line used to swallow that text:
 * "```npm i```" came back as an empty code block. The invariant enforced here
 * is the general one: every non-whitespace character of the input shows up, in
 * order, in the text of the tokens, apart from the punctuation the renderer
 * deliberately consumes (listed in `ALLOWED_SKIP`, and in the header of
 * markdown.js).
 */
import { describe, expect, it } from 'vitest';
import type { MarkdownToken } from '../../src/web/static/markdown.js';
import { parseMarkdown } from '../../src/web/static/markdown.js';

const text = (value: string): { type: 'text'; text: string } => ({ type: 'text', text: value });

/** Everything the tokens still carry, in reading order. */
function tokenText(tokens: MarkdownToken[]): string {
  const out: string[] = [];
  const spans = (list: { type: string; text: string; href?: string }[]): void => {
    for (const span of list) out.push(span.type === 'link' ? `${span.text}${span.href ?? ''}` : span.text);
  };
  for (const token of tokens) {
    if (token.type === 'plain') out.push(token.text);
    else if (token.type === 'code') out.push(token.info ?? '', token.text);
    else if (token.type === 'list') for (const item of token.items) spans(item);
    else spans(token.spans);
  }
  return out.join('\n');
}

/** Syntax the renderer is allowed to eat: emphasis, fences, list and link punctuation. */
const ALLOWED_SKIP = new Set([...'#-*+`~.()[]0123456789']);

/**
 * Checks the invariant and returns the first character that went missing,
 * or `null` when nothing did.
 */
function lostCharacter(input: string, tokens: MarkdownToken[]): string | null {
  const wanted = [...input].filter((ch) => !/\s/u.test(ch));
  const got = [...tokenText(tokens)].filter((ch) => !/\s/u.test(ch));
  let j = 0;
  for (const ch of wanted) {
    if (j < got.length && got[j] === ch) {
      j += 1;
      continue;
    }
    if (ALLOWED_SKIP.has(ch)) continue;
    return ch;
  }
  // Nothing invented either: every output character was matched.
  return j === got.length ? null : `extra:${got[j]!}`;
}

function check(input: string): void {
  const lost = lostCharacter(input, parseMarkdown(input));
  expect([JSON.stringify(input), lost]).toEqual([JSON.stringify(input), null]);
}

describe('a fence marker with text on the same line', () => {
  it('reads an inline same-line fence as inline code', () => {
    expect(parseMarkdown('```npm i```')).toEqual([
      { type: 'paragraph', spans: [{ type: 'code', text: 'npm i' }] },
    ]);
    // `~` is not an inline delimiter here, so the tilde form stays literal —
    // the point is that "abc" is still on screen.
    expect(parseMarkdown('~~~abc~~~')).toEqual([{ type: 'paragraph', spans: [text('~~~abc~~~')] }]);
    expect(parseMarkdown('run ```npm i``` first')).toEqual([
      { type: 'paragraph', spans: [text('run '), { type: 'code', text: 'npm i' }, text(' first')] },
    ]);
  });

  it('keeps an info string on the token instead of dropping it', () => {
    expect(parseMarkdown('```js\nconst a = 1;\n```')).toEqual([
      { type: 'code', info: 'js', text: 'const a = 1;' },
    ]);
    expect(parseMarkdown('```\nplain\n```')).toEqual([{ type: 'code', info: '', text: 'plain' }]);
  });

  it('falls back to plain text when the fence never closes', () => {
    expect(parseMarkdown('before\n\n```sh\nstill open **bold**\nand more')).toEqual([
      { type: 'paragraph', spans: [text('before')] },
      { type: 'plain', text: '```sh\nstill open **bold**\nand more' },
    ]);
  });

  it('loses nothing on the samples that used to lose characters', () => {
    for (const sample of [
      '```npm i```',
      '~~~abc~~~',
      '``` npm i ```',
      '```js```',
      '```js\ncode\n```',
      '```unclosed info\nbody',
      '~~~~~~',
      '```',
      '~~~x',
      'text\n```sh\nls\n```\nmore text',
      '````npm i````',
      '```a``b```',
    ]) {
      check(sample);
    }
  });
});

/** Deterministic, so a failure can always be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  ...'`~*_#-+=[]()<>!\\|"\'.,:;/ \tabxyz019',
  '\n',
  '\n\n',
  '```',
  '~~~',
  '**',
  '](',
  '😀',
  'é',
];

const HOSTILE = [
  '<img src=x onerror=alert(1)> and </script><script>alert(1)</script>',
  '[x](javascript:alert(1))',
  '2 * 3 * 4',
  'unclosed **bold',
  'a `backtick',
  '****',
  '] stray bracket (',
  'emoji 😀 and tabs\tinside',
  '- one\n- two\n  continued',
  '1. first\n2) second',
  '# Title\n\n### Deeper',
  '#nothashtag',
  'first line\nstill first\n\nsecond',
  '['.repeat(9000) + ']',
  '*'.repeat(9000),
  '`'.repeat(9000),
  '['.repeat(4500) + '](x)',
  '```'.repeat(500),
];

describe('no character is ever dropped (fuzz)', () => {
  it('holds for 5000 random markdown-ish inputs', () => {
    const random = mulberry32(20260920);
    const failures: string[] = [];
    for (let run = 0; run < 5000; run += 1) {
      const length = 1 + Math.floor(random() * 24);
      let input = '';
      for (let i = 0; i < length; i += 1) {
        input += ALPHABET[Math.floor(random() * ALPHABET.length)]!;
      }
      const lost = lostCharacter(input, parseMarkdown(input));
      if (lost !== null && failures.length < 5) failures.push(`${JSON.stringify(input)} lost ${lost}`);
      else if (lost !== null) failures.push('…');
    }
    expect(failures).toEqual([]);
  });

  it('holds for the hostile samples, and stays fast', () => {
    const started = Date.now();
    for (const sample of HOSTILE) check(sample);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
