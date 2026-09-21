/**
 * Wording shared by the CLI, the TUI and the web UI, so the same number never
 * gets two names.
 */

/**
 * How `SessionResult.matchCount` is allowed to be said.
 *
 * The number counts messages containing *any* of the query terms, so calling
 * it "matches" over-promises. "3 messages mention this" is true of an OR.
 */
export function matchCountLabel(count: number): string {
  return count === 1 ? '1 message mentions this' : `${count} messages mention this`;
}
