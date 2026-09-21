/**
 * Types for the browser-side Markdown parser, so `npm run typecheck` covers
 * the tests that import it. The implementation is plain ES module JavaScript:
 * it ships to the browser as-is, with no build step.
 */

export type MarkdownSpan =
  | { type: 'text' | 'strong' | 'em' | 'code'; text: string }
  | { type: 'link'; text: string; href: string };

export type MarkdownToken =
  | { type: 'plain'; text: string }
  | { type: 'paragraph'; spans: MarkdownSpan[] }
  | { type: 'heading'; level: number; spans: MarkdownSpan[] }
  | { type: 'list'; ordered: boolean; items: MarkdownSpan[][] }
  /** `info` is the word after the opening fence (`js` in ```` ```js ````). */
  | { type: 'code'; info: string; text: string };

export declare const MAX_MARKDOWN_CHARS: number;
export declare const MAX_INLINE_SPANS: number;

export declare function parseMarkdown(text: unknown): MarkdownToken[];
export declare function parseInline(text: string): MarkdownSpan[];
