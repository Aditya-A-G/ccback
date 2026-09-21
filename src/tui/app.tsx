import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { isUserError, NO_SESSIONS_YET } from '../core/index.js';
import type { IndexStatus, SessionResult } from '../core/index.js';
import type {
  FullMessage,
  MatchSnippet,
  SemanticProgress,
  SemanticStatus,
  SortOrder,
  TuiDeps,
  TuiOptions,
} from './deps.js';
import { classifyKey } from './keys.js';
import {
  backspace,
  clearToStart,
  deleteForward,
  deleteWordBackward,
  insertText,
  killToEnd,
  makeQuery,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveWordLeft,
  moveWordRight,
  type QueryState,
} from './query-model.js';
import {
  computeWindow,
  expandedBodyRows,
  fitFooter,
  folderColumnWidth,
  folderLabels,
  footerHints,
  formatRow,
  layoutHeights,
  locateHighlights,
  PREVIEW_INDENT,
  queryLineParts,
  relativeAge,
  scrollToLine,
  segmentHighlights,
  shortDate,
  shortenPath,
  titleColumnWidth,
  truncate,
  wrapMessage,
  wrapSegments,
  type FooterHint,
  type Segment,
} from './format.js';

/** What the user chose to do; acted on after Ink has unmounted. */
export type Outcome =
  | { kind: 'quit'; printCommand?: string | undefined }
  | { kind: 'resume'; sessionId: string; cwd: string; resumeCommand: string };

/** Minimum size the layout is designed for. */
export const MIN_COLUMNS = 40;
export const MIN_ROWS = 8;

/** Longest the picker waits for cancelled background work before exiting. */
export const BACKGROUND_SETTLE_MS = 1000;

/** Rows fetched when the caller did not ask for a particular number. */
export const DEFAULT_PICKER_LIMIT = 50;

/** Most matches of one session the picker steps through. */
export const MATCH_LIMIT = 50;

/** The one dim line that reports automatic smart-search setup. */
export const SMART_SETUP = 'Setting up smart search…';
export const SMART_UPDATE = 'Updating smart search…';

export interface AppProps {
  options: TuiOptions;
  deps: TuiDeps;
  openTranscript?: ((sessionId: string, messageId?: number) => Promise<string>) | undefined;
  onOutcome: (outcome: Outcome) => void;
}

export function App({ options, deps, openTranscript, onOutcome }: AppProps): React.JSX.Element {
  const { exit, waitUntilRenderFlush } = useApp();
  const windowSize = useWindowSize();
  const width = Math.max(MIN_COLUMNS, windowSize.columns);
  const rows = Math.max(MIN_ROWS, windowSize.rows);

  const [query, setQuery] = useState<QueryState>(() => makeQuery(options.query ?? ''));
  const [sort, setSort] = useState<SortOrder>(options.sort ?? 'relevance');
  const [results, setResults] = useState<SessionResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);
  /** Transient feedback: copied, errors, missing folder, opened URL. */
  const [notice, setNotice] = useState('');
  /** Shown only while a sync that actually indexes something is in flight. */
  const [indexingLine, setIndexingLine] = useState('');
  /** Automatic smart-search setup, or the one failure sentence. */
  const [smartLine, setSmartLine] = useState('');
  /** What to say instead of "No matching sessions." when there is nothing to search. */
  const [emptyHint, setEmptyHint] = useState('');
  /** Matches of the selected session, keyed by `query` + session id. */
  const [matchState, setMatchState] = useState<{ key: string; list: MatchSnippet[] } | null>(null);
  const [matchIndex, setMatchIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [fullMessage, setFullMessage] = useState<FullMessage | null>(null);
  /** Bumped to re-run the current search after background work improved it. */
  const [reloadToken, setReloadToken] = useState(0);

  const requestId = useRef(0);
  const matchRequestId = useRef(0);
  const matchCache = useRef(new Map<string, MatchSnippet[]>());
  const messageCache = useRef(new Map<number, FullMessage | null>());
  const indexStatus = useRef<IndexStatus | null>(null);
  const smartAbort = useRef<AbortController | null>(null);
  const smartTask = useRef<Promise<unknown> | null>(null);
  const printOnExit = useRef<string | undefined>(undefined);
  /** Session to keep selected across a silent re-query. */
  const keepSessionId = useRef<string | null>(null);
  /** The selected session id, readable from callbacks that outlive a render. */
  const selectedSessionId = useRef<string | null>(null);

  const queryText = query.text.trim();
  // `--limit` is the user saying how many rows they want; it is not a floor.
  const limit = Math.max(1, options.limit ?? DEFAULT_PICKER_LIMIT);

  // ---- search ------------------------------------------------------------

  const runSearch = useCallback(
    async (nextQuery: string, nextSort: SortOrder): Promise<void> => {
      const id = requestId.current + 1;
      requestId.current = id;
      setBusy(true);
      try {
        const trimmed = nextQuery.trim();
        const list =
          trimmed === ''
            ? await deps.recentSessions({ limit: 5, cwdPrefix: options.cwdPrefix })
            : await deps.search({
                query: nextQuery,
                mode: options.mode ?? 'auto',
                sort: nextSort,
                limit,
                cwdPrefix: options.cwdPrefix,
                since: options.since,
                until: options.until,
                role: options.role,
              });
        if (id !== requestId.current) return; // a newer request won
        setResults(list);
        const keep = keepSessionId.current;
        keepSessionId.current = null;
        const at = keep === null ? -1 : list.findIndex((result) => result.sessionId === keep);
        setSelected(at > 0 ? at : 0);
        setOffset(0);
        setBusy(false);
      } catch (err) {
        if (id !== requestId.current) return;
        setResults([]);
        setBusy(false);
        setNotice(oneLine(errorText(err)));
      }
    },
    [deps, limit, options.cwdPrefix, options.mode, options.role, options.since, options.until],
  );

  // ---- startup: draw first, then sync ------------------------------------

  /** "No sessions yet" and "no transcripts at all" are different problems. */
  const refreshEmptyHint = useCallback((status: IndexStatus | null): void => {
    if (!status) return;
    if (!status.projectsDirExists) {
      setEmptyHint(status.projectsDirHint ?? '');
      return;
    }
    setEmptyHint(status.sessions === 0 ? NO_SESSIONS_YET : '');
  }, []);

  /**
   * Smart search sets itself up, in the background, without ever asking. A
   * keyword-only install (no runtime) never hears about it.
   */
  const startSmartSearch = useCallback(
    (status: SemanticStatus): void => {
      if (!status.runtimeInstalled || status.pendingChunks <= 0) return;
      const firstRun = !status.enabled;
      const controller = new AbortController();
      smartAbort.current = controller;
      setSmartLine(firstRun ? SMART_SETUP : SMART_UPDATE);

      const onProgress = (progress: SemanticProgress): void => {
        if (controller.signal.aborted) return;
        if (!firstRun) {
          setSmartLine(SMART_UPDATE);
          return;
        }
        if (progress.phase === 'install') setSmartLine(`${SMART_SETUP} installing`);
        else if (progress.phase === 'model') setSmartLine(`${SMART_SETUP} downloading model`);
        else setSmartLine(`${SMART_SETUP} ${progress.done ?? 0}/${progress.total ?? 0}`);
      };

      const task = (async (): Promise<void> => {
        try {
          if (firstRun) await deps.enableSemantic({ onProgress, signal: controller.signal });
          else await deps.topUpEmbeddings({ onProgress, signal: controller.signal });
          if (controller.signal.aborted) return;
          setSmartLine('');
          matchCache.current.clear();
          // Silently make the answers better, keeping the user where they are.
          keepSessionId.current = selectedSessionId.current;
          setReloadToken((token) => token + 1);
        } catch (err) {
          if (controller.signal.aborted) {
            setSmartLine('');
            return;
          }
          setSmartLine(
            `Smart search unavailable: ${reason(errorText(err))} Keyword search still works.`,
          );
        } finally {
          if (smartAbort.current === controller) smartAbort.current = null;
        }
      })();
      smartTask.current = task;
    },
    [deps],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        indexStatus.current = await deps.status({ projectsDir: options.projectsDir });
        if (!cancelled) refreshEmptyHint(indexStatus.current);
      } catch {
        /* the index may not exist yet; sync creates it */
      }
      try {
        if (!options.noSync) {
          // The box is on screen before any indexing work starts.
          await waitUntilRenderFlush();
          await deps.sync({
            projectsDir: options.projectsDir,
            onProgress: (progress) => {
              if (cancelled) return;
              // Only a sync that is really indexing something says anything.
              if (progress.phase === 'index' && progress.total > 0) {
                setIndexingLine(`Indexing ${progress.total} sessions…`);
              }
            },
          });
          if (!cancelled) setIndexingLine('');
          try {
            indexStatus.current = await deps.status({ projectsDir: options.projectsDir });
            if (!cancelled) refreshEmptyHint(indexStatus.current);
          } catch {
            /* keep the status we already have */
          }
        }
      } catch (err) {
        if (!cancelled) {
          setIndexingLine('');
          // A missing transcript directory is an empty state, not an alarm.
          if (isUserError(err)) setEmptyHint(oneLine(errorText(err)));
          else setNotice(oneLine(errorText(err)));
        }
      }
      if (!cancelled) setReady(true);
      try {
        const smart = await deps.semanticStatus();
        if (!cancelled) startSmartSearch(smart);
      } catch {
        /* smart search is an optional extra: never say anything about it */
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    const handle = setTimeout(() => {
      void runSearch(query.text, sort);
    }, deps.debounceMs);
    return () => {
      clearTimeout(handle);
    };
  }, [query.text, sort, ready, reloadToken, deps.debounceMs, runSearch]);

  // ---- derived layout ----------------------------------------------------

  const current = results[selected];
  selectedSessionId.current = current?.sessionId ?? null;
  const statusText = notice !== '' ? notice : smartLine !== '' ? smartLine : indexingLine;
  const hasQuery = queryText !== '';
  const heights = layoutHeights({
    rows,
    hasQuery,
    hasStatus: statusText !== '',
    hasHeading: !hasQuery,
  });
  const listRows = heights.listRows;
  const previewRows = expanded ? 0 : heights.previewRows;
  const bodyRows = expandedBodyRows(rows, statusText !== '');

  useEffect(() => {
    setOffset((value) => computeWindow(selected, results.length, listRows, value));
  }, [selected, results.length, listRows]);

  // ---- matches of the selected session ------------------------------------

  const matchKey = current && hasQuery ? `${queryText}\u0000${current.sessionId}` : '';

  useEffect(() => {
    setMatchIndex(0);
    setScroll(0);
  }, [matchKey]);

  useEffect(() => {
    if (matchKey === '' || !current) return undefined;
    const cached = matchCache.current.get(matchKey);
    if (cached) {
      setMatchState({ key: matchKey, list: cached });
      return undefined;
    }
    let cancelled = false;
    const id = matchRequestId.current + 1;
    matchRequestId.current = id;
    void (async () => {
      try {
        const list = await deps.sessionMatches({
          sessionId: current.sessionId,
          query: queryText,
          // One more than the cap, so "exactly 50" is not reported as "50+".
          limit: MATCH_LIMIT + 1,
        });
        // A stale answer for a session the user has already left is dropped.
        if (cancelled || id !== matchRequestId.current) return;
        matchCache.current.set(matchKey, list);
        setMatchState({ key: matchKey, list });
      } catch {
        /* the preview falls back to the search snippet */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [matchKey, current, deps, queryText]);

  const matches = matchState && matchState.key === matchKey ? matchState.list : null;
  const fetchedMatches = matches?.length ?? 0;
  const matchTotal = Math.min(fetchedMatches, MATCH_LIMIT);
  /** The list was cut off, so the count shown is a floor, not a total. */
  const matchesCapped = fetchedMatches > MATCH_LIMIT;
  const safeMatchIndex = matchTotal === 0 ? 0 : Math.min(matchIndex, matchTotal - 1);
  const preview: MatchSnippet | null = useMemo(() => {
    if (matches && matches.length > 0) return matches[safeMatchIndex] ?? null;
    if (!current) return null;
    return {
      messageId: current.snippet.messageId,
      role: current.snippet.role,
      ts: current.snippet.ts,
      text: current.snippet.text,
      highlights: current.snippet.highlights,
    };
  }, [matches, safeMatchIndex, current]);

  // ---- the expanded (full message) view ------------------------------------

  useEffect(() => {
    if (!expanded || !preview) return undefined;
    const messageId = preview.messageId;
    const cached = messageCache.current.get(messageId);
    if (cached !== undefined) {
      setFullMessage(cached);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const message = await deps.getMessage(messageId);
        if (cancelled) return;
        messageCache.current.set(messageId, message);
        setFullMessage(message);
      } catch {
        if (!cancelled) setFullMessage(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, preview, deps]);

  const bodyLines = useMemo(() => {
    if (!expanded || !fullMessage || !preview) return [];
    const highlights = locateHighlights(fullMessage.text, preview.text, preview.highlights);
    // The author's own line breaks are part of the message: keep them.
    return wrapMessage(fullMessage.text, highlights, Math.max(1, width - PREVIEW_INDENT.length));
  }, [expanded, fullMessage, preview, width]);

  /** First highlighted line, so the expanded view opens on the match. */
  const highlightLine = useMemo(() => {
    const at = bodyLines.findIndex((line) => line.some((segment) => segment.hit));
    return at < 0 ? 0 : at;
  }, [bodyLines]);

  const openedAt = useRef<string>('');
  useEffect(() => {
    if (!expanded || bodyLines.length === 0) return;
    const token = `${fullMessage?.messageId ?? -1}:${bodyLines.length}`;
    if (openedAt.current === token) return;
    openedAt.current = token;
    setScroll(scrollToLine(highlightLine, bodyRows, bodyLines.length));
  }, [expanded, bodyLines, highlightLine, bodyRows, fullMessage]);

  useEffect(() => {
    if (!expanded) openedAt.current = '';
  }, [expanded]);

  // ---- actions -----------------------------------------------------------

  /** Stops background work and gives it a moment to leave its progress behind. */
  const finishBackground = useCallback(async (): Promise<void> => {
    const controller = smartAbort.current;
    const task = smartTask.current;
    smartAbort.current = null;
    smartTask.current = null;
    if (!controller && !task) return;
    controller?.abort();
    if (!task) return;
    await Promise.race([
      task.catch(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, BACKGROUND_SETTLE_MS);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  }, []);

  const quit = useCallback((): void => {
    void finishBackground().then(() => {
      onOutcome({ kind: 'quit', printCommand: printOnExit.current });
      exit();
    });
  }, [exit, finishBackground, onOutcome]);

  const activate = useCallback((): void => {
    const result = results[selected];
    if (!result) return;
    if (!result.cwdExists) {
      setNotice(
        `Folder no longer exists: ${result.cwd} — ^Y copies the command` +
          (openTranscript ? ', ^O opens the transcript' : ''),
      );
      return;
    }
    void finishBackground().then(() => {
      onOutcome({
        kind: 'resume',
        sessionId: result.sessionId,
        cwd: result.cwd,
        resumeCommand: result.resumeCommand,
      });
      exit();
    });
  }, [exit, finishBackground, onOutcome, openTranscript, results, selected]);

  const copy = useCallback(async (): Promise<void> => {
    const result = results[selected];
    if (!result) return;
    try {
      const copied = await deps.copyToClipboard(result.resumeCommand);
      if (copied) {
        setNotice('copied');
        return;
      }
    } catch {
      /* fall through to printing on exit */
    }
    printOnExit.current = result.resumeCommand;
    setNotice('No clipboard tool found — the command will be printed on exit.');
  }, [deps, results, selected]);

  const openInBrowser = useCallback(async (): Promise<void> => {
    if (!openTranscript) return;
    const result = results[selected];
    if (!result) return;
    setNotice('Opening in browser…');
    try {
      // The preview carries the message being read, so the reader jumps to it.
      const url = await openTranscript(result.sessionId, preview?.messageId);
      setNotice(`Transcript: ${url}`);
    } catch (err) {
      setNotice(oneLine(errorText(err)));
    }
  }, [openTranscript, preview, results, selected]);

  const move = useCallback(
    (delta: number): void => {
      setNotice('');
      setSelected((value) => {
        if (results.length === 0) return 0;
        return Math.min(Math.max(value + delta, 0), results.length - 1);
      });
    },
    [results.length],
  );

  const stepMatch = useCallback(
    (delta: number): void => {
      if (matchTotal <= 1) return;
      setNotice('');
      setMatchIndex((value) => Math.min(Math.max(value + delta, 0), matchTotal - 1));
      openedAt.current = '';
    },
    [matchTotal],
  );

  const scrollBy = useCallback(
    (delta: number): void => {
      setScroll((value) =>
        Math.min(Math.max(0, value + delta), Math.max(0, bodyLines.length - bodyRows)),
      );
    },
    [bodyLines.length, bodyRows],
  );

  // ---- input -------------------------------------------------------------

  /** ← and → walk the matches instead of the text when there are results. */
  const arrowsStepMatches = hasQuery && results.length > 0;

  useInput((input, key) => {
    const action = classifyKey(input, key);
    if (!action) return;

    switch (action.type) {
      case 'quit':
        quit();
        return;
      case 'escape':
        if (expanded) {
          setExpanded(false);
          return;
        }
        quit();
        return;
      case 'resume':
        activate();
        return;
      case 'up':
        if (expanded) scrollBy(-1);
        else move(-1);
        return;
      case 'down':
        if (expanded) scrollBy(1);
        else move(1);
        return;
      case 'pageUp':
        if (expanded) scrollBy(-bodyRows);
        else move(-listRows);
        return;
      case 'pageDown':
        if (expanded) scrollBy(bodyRows);
        else move(listRows);
        return;
      case 'left':
        if (expanded || arrowsStepMatches) stepMatch(-1);
        else setQuery(moveLeft);
        return;
      case 'right':
        if (expanded || arrowsStepMatches) stepMatch(1);
        else setQuery(moveRight);
        return;
      case 'wordLeft':
        setQuery(moveWordLeft);
        return;
      case 'wordRight':
        setQuery(moveWordRight);
        return;
      case 'lineStart':
        setQuery(moveLineStart);
        return;
      case 'lineEnd':
        setQuery(moveLineEnd);
        return;
      case 'backspace':
        setNotice('');
        setQuery(backspace);
        return;
      case 'deleteForward':
        setNotice('');
        setQuery(deleteForward);
        return;
      case 'deleteWordBack':
        setNotice('');
        setQuery(deleteWordBackward);
        return;
      case 'killToEnd':
        setNotice('');
        setQuery(killToEnd);
        return;
      case 'clearToStart':
        setNotice('');
        setQuery(clearToStart);
        return;
      case 'copy':
        void copy();
        return;
      case 'browser':
        void openInBrowser();
        return;
      case 'fullMessage':
        if (expanded) setExpanded(false);
        else if (preview) setExpanded(true);
        return;
      case 'sort':
        if (!hasQuery) return;
        setNotice('');
        keepSessionId.current = current?.sessionId ?? null;
        setSort((value) => (value === 'relevance' ? 'recent' : 'relevance'));
        return;
      case 'insert':
        setNotice('');
        setQuery((value) => insertText(value, action.text));
        return;
      default:
        return;
    }
  });

  // ---- render ------------------------------------------------------------

  const now = deps.now();
  const home = deps.homedir();
  const labels = useMemo(() => folderLabels(results.map((result) => result.cwd)), [results]);
  const columnWidth = useMemo(
    () => folderColumnWidth([...labels.values()], width),
    [labels, width],
  );
  // Measured over the whole result list, not just the rows on screen, for the
  // same reason the folder labels are: a column that resizes while you scroll
  // is harder to read than one that is a little wider than it needs to be.
  const titleWidth = useMemo(
    () => titleColumnWidth(results.map((result) => (result.title === '' ? result.sessionId : result.title))),
    [results],
  );
  const parts = queryLineParts(query.text, query.cursor, width);
  const visible = expanded && current ? [current] : results.slice(offset, offset + listRows);
  const visibleStart = expanded ? selected : offset;

  const hints: FooterHint[] = footerHints({
    expanded,
    hasMatches: matchTotal > 1,
    hasPreview: preview !== null,
    hasQuery,
    hasCurrent: current !== undefined,
    canOpenBrowser: openTranscript !== undefined,
    sort,
  });
  const footer = fitFooter(hints, width);

  const emptyLine = busy || !ready ? 'Searching…' : emptyHint !== '' ? emptyHint : 'No matching sessions.';
  const previewWidth = Math.max(1, width - PREVIEW_INDENT.length);

  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate">
        <Text dimColor>{parts.prompt}</Text>
        {parts.before}
        <Text bold>{parts.cursor}</Text>
        {parts.after}
      </Text>
      <Text> </Text>

      {!expanded && !hasQuery && results.length > 0 ? (
        <Text dimColor wrap="truncate">{`${PREVIEW_INDENT}Recent`}</Text>
      ) : null}

      {visible.length === 0 ? (
        <Text dimColor wrap="truncate">
          {truncate(`${PREVIEW_INDENT}${emptyLine}`, width)}
        </Text>
      ) : (
        visible.map((result, index) => {
          const isSelected = visibleStart + index === selected;
          return (
            <Text key={result.sessionId} wrap="truncate" color={isSelected ? 'cyan' : undefined} bold={isSelected}>
              {formatRow(
                {
                  selected: isSelected,
                  title: result.title === '' ? result.sessionId : result.title,
                  folder: labels.get(result.cwd) ?? result.cwd,
                  age: relativeAge(result.lastTs, now),
                },
                width,
                { title: titleWidth, folder: columnWidth },
              )}
            </Text>
          );
        })
      )}

      {expanded && preview ? (
        <>
          <Text> </Text>
          <Text dimColor wrap="truncate">
            {truncate(
              `${PREVIEW_INDENT}${previewHeader(preview, now, safeMatchIndex, matchTotal, matchesCapped)}`,
              width,
            )}
          </Text>
          {bodyLines.length === 0 ? (
            <Text dimColor wrap="truncate">{`${PREVIEW_INDENT}(message not available)`}</Text>
          ) : (
            bodyLines.slice(scroll, scroll + bodyRows).map((line, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <Text key={`body-${scroll + index}`} wrap="truncate">
                {PREVIEW_INDENT}
                {renderSegments(line)}
              </Text>
            ))
          )}
        </>
      ) : null}

      {!expanded && previewRows >= 2 && preview && current ? (
        <>
          <Text> </Text>
          <Text dimColor wrap="truncate">
            {truncate(
              `${PREVIEW_INDENT}${previewHeader(
                preview,
                now,
                safeMatchIndex,
                hasQuery ? matchTotal : 0,
                hasQuery && matchesCapped,
              )}`,
              width,
            )}
          </Text>
          {wrapSegments(
            segmentHighlights(preview.text, preview.highlights),
            previewWidth,
            Math.max(0, previewRows - 2),
          ).map((line, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <Text key={`preview-${index}`} wrap="truncate">
              {PREVIEW_INDENT}
              {renderSegments(line)}
            </Text>
          ))}
          <Text dimColor wrap="truncate">
            {truncate(
              `${PREVIEW_INDENT}${shortenPath(current.cwd, home, previewWidth - (current.cwdExists ? 0 : 10))}${
                current.cwdExists ? '' : ' (missing)'
              }`,
              width,
            )}
          </Text>
        </>
      ) : null}

      {statusText === '' ? null : (
        <Text dimColor wrap="truncate">
          {truncate(` ${statusText}`, width)}
        </Text>
      )}
      <Text> </Text>
      <Text dimColor wrap="truncate">
        {footer}
      </Text>
    </Box>
  );
}

function renderSegments(segments: Segment[]): React.JSX.Element[] {
  return segments.map((segment, index) => (
    // eslint-disable-next-line react/no-array-index-key
    <Text key={index} bold={segment.hit} color={segment.hit ? 'cyan' : undefined}>
      {segment.text}
    </Text>
  ));
}

/**
 * `You · Sep 10 · match 2 of 7  ← →` — the arrows only when they do something.
 *
 * `capped` makes it `50+`: the number is how many matches were *fetched*, and
 * printing a cap as though it were a count is a small lie that a user with 300
 * matching messages will notice.
 */
export function previewHeader(
  snippet: { role: string; ts: string },
  now: number,
  index: number,
  total: number,
  capped = false,
): string {
  const who = snippet.role === 'user' ? 'You' : 'Claude';
  const parts = [who, shortDate(snippet.ts, now)];
  if (total > 1) parts.push(`match ${index + 1} of ${total}${capped ? '+' : ''}  ← →`);
  return parts.join(' · ');
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function oneLine(text: string): string {
  return text.split('\n').join(' ');
}

/** One sentence, ending in a full stop, for the smart-search failure line. */
function reason(text: string): string {
  const line = oneLine(text).trim();
  return line.endsWith('.') ? line : `${line}.`;
}
