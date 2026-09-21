/**
 * The reader's Markdown parser (feature 13).
 *
 * There is no DOM in this test environment, so the parser is a pure function in
 * its own static module and is tested directly. The rendering half lives in
 * app.js and is covered by the "never injects HTML" check in server.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { MAX_MARKDOWN_CHARS, parseInline, parseMarkdown } from '../../src/web/static/markdown.js';

const text = (value: string): { type: 'text'; text: string } => ({ type: 'text', text: value });

describe('block structure', () => {
  it('returns nothing for nothing', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown(undefined)).toEqual([]);
    expect(parseMarkdown(null)).toEqual([]);
    expect(parseMarkdown(42)).toEqual([]);
  });

  it('splits paragraphs on blank lines', () => {
    expect(parseMarkdown('first line\nstill first\n\nsecond')).toEqual([
      { type: 'paragraph', spans: [text('first line\nstill first')] },
      { type: 'paragraph', spans: [text('second')] },
    ]);
  });

  it('reads # headings with their level', () => {
    expect(parseMarkdown('# Title\n\n### Deeper')).toEqual([
      { type: 'heading', level: 1, spans: [text('Title')] },
      { type: 'heading', level: 3, spans: [text('Deeper')] },
    ]);
    // A hash with no space is just a hash.
    expect(parseMarkdown('#nothashtag')).toEqual([{ type: 'paragraph', spans: [text('#nothashtag')] }]);
  });

  it('reads unordered and ordered lists, including wrapped items', () => {
    expect(parseMarkdown('- one\n- two\n  continued')).toEqual([
      { type: 'list', ordered: false, items: [[text('one')], [text('two continued')]] },
    ]);
    expect(parseMarkdown('1. first\n2) second')).toEqual([
      { type: 'list', ordered: true, items: [[text('first')], [text('second')]] },
    ]);
    // Switching marker style starts a new list rather than mixing them.
    expect(parseMarkdown('- a\n1. b').map((token) => token.type)).toEqual(['list', 'list']);
  });

  it('keeps fenced code verbatim, markers and all, and keeps the info string', () => {
    expect(parseMarkdown('```js\nconst a = **1**;\n# not a heading\n```')).toEqual([
      { type: 'code', info: 'js', text: 'const a = **1**;\n# not a heading' },
    ]);
  });

  it('shows every character of an unclosed fence, as plain text', () => {
    const tokens = parseMarkdown('before\n\n```\nstill open **bold**\nand more');
    expect(tokens).toEqual([
      { type: 'paragraph', spans: [text('before')] },
      { type: 'plain', text: '```\nstill open **bold**\nand more' },
    ]);
  });

  it('falls back to verbatim text for anything enormous', () => {
    const huge = '*'.repeat(1024 * 1024);
    const started = Date.now();
    const tokens = parseMarkdown(huge);
    expect(tokens).toEqual([{ type: 'plain', text: huge }]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(huge.length).toBeGreaterThan(MAX_MARKDOWN_CHARS);
  });
});

describe('inline spans', () => {
  it('reads bold, italic and inline code', () => {
    expect(parseInline('a **b** c *d* e `f` g')).toEqual([
      text('a '),
      { type: 'strong', text: 'b' },
      text(' c '),
      { type: 'em', text: 'd' },
      text(' e '),
      { type: 'code', text: 'f' },
      text(' g'),
    ]);
  });

  it('leaves unmatched markers as literal characters', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([text('2 '), { type: 'em', text: ' 3 ' }, text(' 4')]);
    expect(parseInline('unclosed **bold')).toEqual([text('unclosed **bold')]);
    expect(parseInline('a `backtick')).toEqual([text('a `backtick')]);
    expect(parseInline('****')).toEqual([text('****')]);
  });

  it('keeps a link as label plus href, never as markup', () => {
    expect(parseInline('see [the docs](https://example.com/a) now')).toEqual([
      text('see '),
      { type: 'link', text: 'the docs', href: 'https://example.com/a' },
      text(' now'),
    ]);
  });

  it('treats a javascript: link as ordinary text to print', () => {
    const spans = parseInline('[x](javascript:alert(1))');
    // Whatever the parser decides, it is data: a label and an href string.
    for (const span of spans) {
      expect(['text', 'link', 'strong', 'em', 'code']).toContain(span.type);
      if (span.type === 'link') expect(span.href.startsWith('javascript:')).toBe(true);
    }
    // Every character survives, so the reader can show exactly what was written.
    const rebuilt = spans
      .map((span) => (span.type === 'link' ? `[${span.text}](${span.href})` : span.text))
      .join('');
    expect(rebuilt).toBe('[x](javascript:alert(1))');
  });

  it('never turns HTML into anything but text', () => {
    const hostile = '<img src=x onerror=alert(1)> and </script><script>alert(1)</script>';
    expect(parseInline(hostile)).toEqual([text(hostile)]);
    expect(parseMarkdown(hostile)).toEqual([{ type: 'paragraph', spans: [text(hostile)] }]);
  });

  it('stays fast on pathological input', () => {
    for (const hostile of ['['.repeat(90000) + ']', '*'.repeat(90000), '`'.repeat(90000), '['.repeat(45000) + '](x)']) {
      const started = Date.now();
      const tokens = parseMarkdown(hostile);
      expect(tokens.length).toBeGreaterThan(0);
      expect([hostile.slice(0, 3), Date.now() - started < 2000]).toEqual([hostile.slice(0, 3), true]);
    }
  });

  it('never loses or invents characters', () => {
    const samples = [
      'plain words',
      '**bold** and *italic* and `code`',
      'a [link](http://x.y) here',
      'trailing *',
      '] stray bracket (',
      'emoji 😀 and tabs\tinside',
    ];
    for (const sample of samples) {
      const rebuilt = parseInline(sample)
        .map((span) => {
          if (span.type === 'strong') return `**${span.text}**`;
          if (span.type === 'em') return `*${span.text}*`;
          if (span.type === 'code') return `\`${span.text}\``;
          if (span.type === 'link') return `[${span.text}](${span.href})`;
          return span.text;
        })
        .join('');
      expect([sample, rebuilt]).toEqual([sample, sample]);
    }
  });
});
