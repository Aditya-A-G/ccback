/** A small English stopword list. Deliberately short: precision matters more than recall here. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'being', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'done',
  'for', 'from', 'get', 'got', 'had', 'has', 'have', 'he', 'her', 'here', 'him', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'just', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'over',
  'she', 'should', 'so', 'some', 'such',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'to', 'too',
  'up', 'us', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'will', 'with', 'would', 'you', 'your',
]);

/**
 * Turns a natural sentence into search terms: lowercase, split on
 * non-alphanumerics, drop stopwords, de-duplicate. If every word is a stopword
 * the words are kept, so `"how to"` still searches for something.
 */
export function parseQuery(raw: string): string[] {
  const words = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const unique = [...new Set(words)];
  const meaningful = unique.filter((w) => !STOPWORDS.has(w));
  return meaningful.length > 0 ? meaningful : unique;
}

/**
 * Builds an FTS5 MATCH expression. Every term is wrapped in double quotes so
 * user punctuation and FTS5 operators (`"`, `*`, `-`, `AND`, `NEAR`, `:`) can
 * never turn into a syntax error. Returns `''` when there is nothing to search.
 */
export function buildFtsMatchQuery(terms: string[]): string {
  const safe = terms.map(quoteTerm).filter((t) => t !== '');
  if (safe.length === 0) return '';
  return safe.join(' OR ');
}

/** Quotes one already-tokenised term for FTS5. */
export function quoteTerm(term: string): string {
  const cleaned = term.replace(/"/g, '');
  if (cleaned.length === 0) return '';
  return `"${cleaned}"`;
}
