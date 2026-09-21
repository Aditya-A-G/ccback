/**
 * The one definition of a session id, shared by the indexer, the resume command
 * builder and the web routes.
 *
 * A session id comes from a file name in the projects directory, so it is
 * attacker-controlled: a file called `x; echo PWNED; #.jsonl` would otherwise
 * end up inside a copyable shell command. Ids that do not match are never
 * indexed, which also guarantees the web UI can route to every result it shows.
 */

/** Deliberately narrow: what Claude Code actually writes, and nothing a shell reads. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidSessionId(value: string): boolean {
  return typeof value === 'string' && SESSION_ID_RE.test(value) && !value.includes('..');
}
