/**
 * The picker under keyword-only.
 *
 * `--keyword-only` used to change the search mode and nothing else: the picker
 * still asked where smart search stood, still started the background job on the
 * answer, and so still downloaded a 23 MB model for somebody who had said they
 * did not want one. It also asked for a session's matches without a mode, which
 * sends `sessionMatches` down the `auto` path and into the embedder on its own.
 *
 * So the assertion is not "the results are keyword results"; it is that the
 * picker never asks, never starts, and never says a word about it.
 */
import { describe, expect, it } from 'vitest';
import type { TuiMatchesRequest, TuiSearchRequest } from '../../src/tui/deps.js';
import { KEY, makeMatch, makeResult, makeSemanticStatus, plainFrame, settle, startTui, tick } from './helpers.js';

interface Calls {
  semanticStatus: number;
  enableSemantic: number;
  topUpEmbeddings: number;
  searches: TuiSearchRequest[];
  matches: TuiMatchesRequest[];
}

/** A picker whose index has work waiting: the normal path would start on it. */
function picker(over: { keywordOnly?: '--keyword-only' | 'CCFIND_KEYWORD_ONLY' | null; mode?: 'keyword' } = {}) {
  const calls: Calls = { semanticStatus: 0, enableSemantic: 0, topUpEmbeddings: 0, searches: [], matches: [] };
  const tui = startTui({
    query: 'recording',
    ...(over.mode === undefined ? {} : { mode: over.mode }),
    ...(over.keywordOnly === undefined ? {} : { keywordOnly: over.keywordOnly }),
    deps: {
      search: (request) => {
        calls.searches.push(request);
        return [makeResult({ sessionId: 'sess-1' })];
      },
      sessionMatches: (request) => {
        calls.matches.push(request);
        return [makeMatch()];
      },
      semanticStatus: () => {
        calls.semanticStatus += 1;
        // Installed, enabled and behind: the loudest possible invitation.
        return makeSemanticStatus({ runtimeInstalled: true, enabled: true, pendingChunks: 400, totalChunks: 900 });
      },
      enableSemantic: async () => {
        calls.enableSemantic += 1;
      },
      topUpEmbeddings: async () => {
        calls.topUpEmbeddings += 1;
        return { embedded: 0 };
      },
    },
  });
  return { tui, calls };
}

describe('the picker with keyword-only on', () => {
  for (const source of ['--keyword-only', 'CCFIND_KEYWORD_ONLY'] as const) {
    it(`asks nothing and starts nothing (${source})`, async () => {
      // No `mode` passed: keyword-only alone has to decide it, because
      // `runTui` is a public entry point and not only the CLI calls it.
      const { tui, calls } = picker({ keywordOnly: source });
      await settle(tui);
      // Long enough for the background task the normal path would have started.
      await tick(100);

      expect(calls.semanticStatus).toBe(0);
      expect(calls.enableSemantic).toBe(0);
      expect(calls.topUpEmbeddings).toBe(0);

      const frame = plainFrame(tui.liveFrame());
      expect(frame).not.toContain('Setting up smart search');
      expect(frame).not.toContain('Updating smart search');
      expect(frame).not.toContain('smart search');

      await tui.send(KEY.escape);
      expect(await tui.exitCode).toBe(0);
    });
  }

  it('asks for this session’s matches in the same mode it searched in', async () => {
    const { tui, calls } = picker({ keywordOnly: '--keyword-only' });
    await settle(tui);
    await tick(60);

    expect(calls.searches[0]?.mode).toBe('keyword');
    expect(calls.matches.length).toBeGreaterThan(0);
    // Left to default this is `auto`, which resolves to hybrid on an index
    // that holds embeddings — and loads a model to do it.
    expect(calls.matches[0]?.mode).toBe('keyword');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});

describe('the picker with smart search on', () => {
  it('still asks, and still starts the background top-up', async () => {
    const { tui, calls } = picker();
    await settle(tui);
    await tick(100);

    expect(calls.semanticStatus).toBe(1);
    expect(calls.topUpEmbeddings).toBe(1);
    expect(calls.searches[0]?.mode).toBe('auto');
    expect(calls.matches[0]?.mode).toBe('auto');

    await tui.send(KEY.escape);
    expect(await tui.exitCode).toBe(0);
  });
});
