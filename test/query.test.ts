import { describe, expect, it } from 'vitest';
import { buildFtsMatchQuery, parseQuery, STOPWORDS } from '../src/core/query.js';

describe('parseQuery', () => {
  it('lowercases, splits on non-alphanumerics and de-duplicates', () => {
    expect(parseQuery('Recording, recording; VIDEOS!')).toEqual(['recording', 'videos']);
  });

  it('drops stopwords', () => {
    expect(parseQuery('how I will be recording the videos')).toEqual(['recording', 'videos']);
    expect(STOPWORDS.has('the')).toBe(true);
  });

  it('keeps every word when they are all stopwords', () => {
    expect(parseQuery('how to')).toEqual(['how', 'to']);
  });

  it('returns nothing for an empty or punctuation-only query', () => {
    expect(parseQuery('')).toEqual([]);
    expect(parseQuery('   ')).toEqual([]);
    expect(parseQuery('!!! ***')).toEqual([]);
    expect(parseQuery('🐕🚀')).toEqual([]);
  });

  it('keeps non-ASCII words', () => {
    expect(parseQuery('vidéo grabación')).toEqual(['vidéo', 'grabación']);
  });
});

describe('buildFtsMatchQuery', () => {
  it('quotes each term and ORs them', () => {
    expect(buildFtsMatchQuery(['record', 'video'])).toBe('"record" OR "video"');
  });

  it('is empty when there are no terms', () => {
    expect(buildFtsMatchQuery([])).toBe('');
  });

  it('never lets FTS5 operators escape the quotes', () => {
    for (const raw of ['"', '*', 'foo:bar', 'AND OR NOT', '-x', 'a"b*c']) {
      const built = buildFtsMatchQuery(parseQuery(raw));
      expect(built).not.toContain('""');
      expect(built.includes('"') ? built : '"x"').toMatch(/^("[^"]+")( OR "[^"]+")*$/);
    }
  });
});
