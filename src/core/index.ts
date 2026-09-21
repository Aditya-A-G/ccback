/**
 * Public API of ccfind's core.
 *
 * Front ends (CLI, TUI, web server) import from here and from nowhere deeper.
 * Everything is synchronous SQLite except `search`, `sync` and `embedMissing`.
 *
 * ```ts
 * import { sync, search, buildResumeCommand } from 'ccfind';
 *
 * await sync({ projectsDir });                       // incremental, cheap
 * const hits = await search({ query: 'recording videos' });   // mode: 'auto'
 * console.log(hits[0]?.resumeCommand);
 * ```
 */

export {
  APP_HOME_ENV,
  APP_NAME,
  LEGACY_APP_HOME_ENV,
  missingProjectsDirMessage,
  NO_SESSIONS_YET,
  projectsDirExists,
  resolveAppHome,
  resolveIndexPath,
  resolveModelCacheDir,
  resolveProjectsDir,
  resolveWebInstancePath,
  shortenHomePath,
} from './paths.js';

export { UserError, isUserError } from './errors.js';

export { matchCountLabel } from './labels.js';

export { hasControlCharacters, sanitizeLine, sanitizeText } from './sanitize.js';

export { isValidSessionId, SESSION_ID_RE } from './session-id.js';

export type { InterruptOutcome, SignalTarget, WithInterruptOptions } from './interrupt.js';
export { SIGINT_EXIT_CODE, withInterrupt } from './interrupt.js';

export type { Db } from './db.js';
export {
  asIndexError,
  BUSY_TIMEOUT_MS,
  closeSharedDatabases,
  corruptIndexMessage,
  getSharedDatabase,
  openDatabase,
  rebuildDatabase,
  SCHEMA_VERSION,
} from './db.js';

export type { ParsedMessage, ParsedSessionMeta, ParseOptions } from './parser.js';
export {
  cleanMessageText,
  extractText,
  isHarnessNoise,
  parseSessionFile,
  readSessionFile,
  sessionIdFromPath,
  stripSystemReminders,
} from './parser.js';

export type { FileState, SyncOptions, SyncProgress, SyncResult } from './indexer.js';
export { listSessionFiles, syncIndex } from './indexer.js';

export { buildFtsMatchQuery, parseQuery, STOPWORDS } from './query.js';

export type { SearchFilters } from './filters.js';
export { normalizeBound, normalizeCwdPrefix } from './filters.js';

export { chunkHash } from './hash.js';

export type { KeywordSearchOptions, MessageMatch } from './keyword.js';
export { keywordMessageMatches, keywordSearch, parseSnippet } from './keyword.js';

export type { CreateEmbedderOptions, Embedder } from './embedder.js';
export {
  clearModelCache,
  createDefaultEmbedder,
  DEFAULT_MODEL_DIMS,
  DEFAULT_MODEL_ID,
  INSTALL_HINT,
  isModelReady,
  isTransformersAvailable,
  markModelReady,
  modelCacheDirFor,
  modelMarkerPath,
  TRANSFORMERS_PACKAGE,
} from './embedder.js';

export type { EmbedMissingOptions, EmbedMissingResult, EmbedProgress, SemanticSearchOptions } from './semantic.js';
export {
  chunkText,
  hasEmbeddings,
  invalidateVectorCache,
  NO_EMBEDDINGS_HINT,
  semanticMessageMatches,
  semanticSearch,
} from './semantic.js';

export type { FusedSession, RankedList } from './hybrid.js';
export { reciprocalRankFusion, RRF_K } from './hybrid.js';

export type { AliasEnv, AliasShell, ShellTarget } from './alias.js';
export { ALIAS_NAME_RE, aliasBlock, aliasLine, DEFAULT_ALIAS, detectShell, runAlias } from './alias.js';

export type { WhichOptions } from './which.js';
export { whichSync } from './which.js';

export type { SpawnResumeOptions } from './resume.js';
export { buildResumeCommand, shellQuote, spawnResume } from './resume.js';

export type { IndexAccessOptions, RecentSessionsOptions, SearchOptions } from './search.js';
export { recentSessions, resolveAutoMode, search } from './search.js';

export type { FullMessage, GetMessageOptions, SessionMatchesOptions } from './matches.js';
export { DEFAULT_SESSION_MATCH_LIMIT, getMessage, sessionMatches } from './matches.js';

export type {
  EnableSemanticOptions,
  SemanticPhase,
  SemanticProgress,
  SemanticStatus,
  SemanticStatusOptions,
  TopUpResult,
} from './smart.js';
export {
  enableSemantic,
  MODEL_DOWNLOAD_MB,
  SEMANTIC_DOWNLOAD_MB,
  semanticStatus,
  topUpEmbeddings,
} from './smart.js';

export type {
  EmbedApiOptions,
  FolderInfo,
  GetSessionOptions,
  IndexStatus,
  SessionTranscript,
  SyncApiOptions,
} from './api.js';
export { embedMissing, getSession, indexedProjectsDir, listFolders, status, sync } from './api.js';

export type {
  IndexedMessage,
  MatchSnippet,
  MatchSource,
  RankedSession,
  ResolvedSearchMode,
  Role,
  SearchMode,
  SessionMeta,
  SessionResult,
  Snippet,
  SortOrder,
} from './types.js';
