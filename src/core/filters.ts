import { UserError } from './errors.js';
import type { Role } from './types.js';

/** Narrowing applied to every search mode. */
export interface SearchFilters {
  /** Matches the folder itself or anything under it. `/a/b` never matches `/a/bc`. */
  cwdPrefix?: string | undefined;
  /** ISO date or datetime; a bare date means 00:00:00.000 UTC that day. */
  since?: string | undefined;
  /** ISO date or datetime; a bare date means 23:59:59.999 UTC that day. */
  until?: string | undefined;
  role?: Role | undefined;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Normalises `since`/`until` to comparable ISO strings. Throws UserError on junk. */
export function normalizeBound(value: string | undefined, edge: 'start' | 'end'): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (DATE_ONLY.test(value)) {
    return edge === 'start' ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new UserError(`Not a valid date: ${value}`);
  }
  return parsed.toISOString();
}

/** Strips a trailing slash so `/a/b/` and `/a/b` behave the same. */
export function normalizeCwdPrefix(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (value.length > 1 && value.endsWith('/')) return value.slice(0, -1);
  return value;
}

export interface FilterSql {
  /** SQL fragment starting with ` AND ` (or empty), using aliases `m` and `s`. */
  sql: string;
  params: unknown[];
}

/**
 * Builds the SQL for the filters. `cwdPrefix` uses substr() rather than LIKE so
 * that `_` and `%` in real paths cannot act as wildcards.
 */
export function buildFilterSql(filters: SearchFilters, messageAlias = 'm', sessionAlias = 's'): FilterSql {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const prefix = normalizeCwdPrefix(filters.cwdPrefix);
  if (prefix !== undefined) {
    clauses.push(`(${sessionAlias}.cwd = ? OR substr(${sessionAlias}.cwd, 1, ?) = ?)`);
    params.push(prefix, prefix.length + 1, `${prefix}/`);
  }

  const since = normalizeBound(filters.since, 'start');
  if (since !== undefined) {
    clauses.push(`${messageAlias}.ts >= ?`);
    params.push(since);
  }

  const until = normalizeBound(filters.until, 'end');
  if (until !== undefined) {
    clauses.push(`${messageAlias}.ts <= ?`);
    params.push(until);
  }

  if (filters.role !== undefined) {
    clauses.push(`${messageAlias}.role = ?`);
    params.push(filters.role);
  }

  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}
