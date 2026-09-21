/**
 * The only file in `src/tui` that talks to the real core.
 *
 * The picker depends on core functions that were added alongside this round
 * (`sessionMatches`, `getMessage`, `semanticStatus`, `enableSemantic`,
 * `topUpEmbeddings`) plus the `mode: 'auto'` / `sort` arguments of `search`.
 * Everything else in the TUI goes through the injectable {@link TuiDeps}, so
 * the rest of the app — and every test — is independent of the core.
 *
 * Keeping the imports here also means one file to look at when the core API
 * moves, and one place where a missing export shows up.
 */
import {
  closeSharedDatabases,
  enableSemantic,
  getMessage,
  projectsDirMismatch,
  recentSessions,
  search,
  semanticStatus,
  sessionMatches,
  spawnResume,
  status,
  sync,
  topUpEmbeddings,
} from '../core/index.js';
import type { IndexStatus, SessionResult, SyncResult } from '../core/index.js';
import type {
  FullMessage,
  MatchSnippet,
  SemanticStatus,
  TuiMatchesRequest,
  TuiRecentRequest,
  TuiSearchRequest,
  TuiSemanticRequest,
  TuiSyncRequest,
} from './deps.js';

/** Core exports the picker depends on, named for the record. */
export const CORE_EXPORTS_USED = [
  'search',
  'recentSessions',
  'sync',
  'status',
  'projectsDirMismatch',
  'spawnResume',
  'closeSharedDatabases',
  'sessionMatches',
  'getMessage',
  'semanticStatus',
  'enableSemantic',
  'topUpEmbeddings',
] as const;

export function coreSearch(request: TuiSearchRequest): Promise<SessionResult[]> {
  return search(request);
}

export function coreRecentSessions(request: TuiRecentRequest): SessionResult[] {
  return recentSessions(request);
}

export function coreSync(request: TuiSyncRequest): Promise<SyncResult> {
  return sync(request);
}

export function coreStatus(request: { projectsDir?: string | undefined }): IndexStatus | Promise<IndexStatus> {
  return status(request);
}

export function coreProjectsDirMismatch(projectsDir?: string | undefined): string | null {
  return projectsDirMismatch(projectsDir);
}

export function coreSpawnResume(request: { cwd: string; sessionId: string }): Promise<number> {
  return spawnResume(request);
}

export function coreCloseIndex(): void {
  closeSharedDatabases();
}

export function coreSessionMatches(request: TuiMatchesRequest): Promise<MatchSnippet[]> {
  return sessionMatches(request);
}

export function coreGetMessage(messageId: number): FullMessage | null {
  return getMessage(messageId);
}

export function coreSemanticStatus(): SemanticStatus {
  return semanticStatus();
}

export function coreEnableSemantic(request: TuiSemanticRequest): Promise<void> {
  return enableSemantic(request);
}

export function coreTopUpEmbeddings(request: TuiSemanticRequest): Promise<{ embedded: number }> {
  return topUpEmbeddings(request);
}
