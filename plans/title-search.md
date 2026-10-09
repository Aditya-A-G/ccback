# Title search (status: plan v3 after review round 2, nothing built)

## User moment

- **Job story:** when I remember a session by its name (an AI title like "Remotion launch video", or a name I gave it with `/rename`), I want to type that name into ccback and see the session at the top, so I can resume it without remembering the folder.
- **Step before:** `/rename` in Claude Code, or Claude Code generated an AI title. Days later, the user opens `ccback` or `ccb`.
- **Step after:** Enter, `cd` into the folder, and `claude --resume <id>`.
- **Familiar pattern:** Claude Code's `/resume` picker matches on the title (convention). The matched words are underlined in the name, like VS Code's Ctrl+P (convention).
- **What this removes or merges:** nothing new to learn. No flag, mode or setting.
- **Questions a stranger would ask, and where the answer appears:**
  - "why is this here when no message mentions my words?" Before: the session is never returned. After: the matched words are underlined in the title (TUI row, web card, `-p` line), and the line where the message count goes says `the title mentions this` (TUI preview header, web card, `-p`).
  - "is this the name I gave it?" Before: no, the custom name is ignored. After: yes, the same name `/resume` shows.
  - "I cleared the name, why does the old one show?" After: clearing it brings back the AI title, the same as Claude Code.
  - Upgrade moment, "why is ccback busy?" After: on the first open after updating, one line says `Reading session names (one time)…`. Measured: 2.2 s for 0.51 GB of indexed transcripts with a warm cache. It grows with history and is slower on a cold cache, and it never blocks searching.
- **Steps from first touch to first value:** today, a session known only by its name is often never found. Target: one search, with the session at #1 in keyword and default (auto/hybrid) mode for 2+ word queries. Explicit `--mode semantic` runs no keyword step, so it returns no title hits by design.

## Decisions (with reasons)

| # | Decision | Why | Evidence |
|---|---|---|---|
| D1 | Only the title currently shown is searchable. After a rename, the old AI title is not. | The user's call, 2026-10-09. | user |
| D2 | Title order: last `custom-title` > last `ai-title` > first user message (80 chars) > `(untitled session)`. Only records whose `sessionId` is missing or equals the file's session id count. A `custom-title` whose name is empty after cleaning clears the rename. | Claude Code 2.1.295 keys title records by `sessionId` (a file can carry another session's records), is last-wins, and deletes the sidecar on an empty name. Small difference from Claude Code: a name that is only control characters counts as cleared here, while Claude Code would show it. That's harmless. | data (binary) |
| D3 | The fallback title (first user message) is never indexed as a title. | That text is already a searchable message. | heuristic |
| D4 | Read the `.jsonl` only, never `<project>/<id>/custom-title.json`. | Claude Code writes the transcript line first. The sidecar is a cache and only differs when that append failed, which is logged and rare. | data (binary) |
| D5 | v1 is keyword titles only, with no title embeddings. | It avoids a vector table and model-change handling. Hybrid still shows title hits through D8. | hunch |
| D6 | When the role filter is set, titles are not searched. | A title belongs to no role. | heuristic |
| D7 | `--json` gets added fields `titleMatch: boolean` and `titleHighlights: [start,end][]`. Nothing is removed. | It doesn't break existing consumers. | convention |
| D8 | A **title hit** means the title contains every distinct query term (after the stopword and stemming rules shared with message search). Partial title matches count for nothing. **Pin** (2+ distinct query terms): in `relevance` sort, title hits rank above all other sessions in keyword and hybrid. Among themselves they keep their usual order. **Single-term query** (PENDING user confirmation): a title hit is not pinned and competes on its title score (D11). In `recent` sort, title hits are included and ordered by time. Explicit `--mode semantic`: no title hits. | If a title hit were just one OR term, "fix bug" would boost hundreds of titles (review #4). A score bonus alone gets lost in RRF, which uses rank only: a title-only hit at keyword #1 scores 0.0164, below a session ranked 40th in both lists at 0.020 (review #3). Pinning is the simplest rule that meets "at the top in one search". | data (RRF math) + hunch |
| D9 | The new wording goes in a shared label: `the title mentions this`. It's shown only when `titleMatch && matchCount === 0`. | It follows labels.ts, which avoids the word "match" because it over-promises. | convention |
| D11 | A title-only hit's score is `-bm25(titles_fts)`, so it has a real order, the recency tilt applies, and `--json` shows a real number. | ranking.ts:70 leaves a 0 score untilted, and ties fall to session id, which is arbitrary (review 2 #2). | data (code) |
| D10 | Existing indexes get a one-time title backfill, not a full re-parse. | A full re-parse rewrites every message and chunk id. That breaks open `?m=` links, churns ids under the background embed job, and shows a long "Indexing…" to someone who changed nothing (review #11). | heuristic |

## Build plan

1. **Shared title reader** (`src/core/parser.ts`):
   - A single function `resolveTitle(records, sessionId)` used by `parseSessionFile` and the backfill, so the two can never disagree.
   - It returns `{ title, titleSource: 'custom'|'ai'|'fallback'|'none' }`.
   - Apply D2, including the `sessionId` check, which also fixes today's `ai-title` read (parser.ts:140).
   - Run `customTitle` through `sanitizeLine`.
2. **Schema v4** (`src/core/db.ts`):
   - Add `sessions.title_source TEXT NOT NULL DEFAULT 'none'`.
   - Add a plain FTS5 table `titles_fts(session_id UNINDEXED, title)`, porter unicode61. It doesn't use external content or rowid coupling (review #12).
   - Triggers on `sessions`:
     - after insert: insert when `new.title_source IN ('custom','ai')`
     - after update, `WHEN old.title IS NOT new.title OR old.title_source IS NOT new.title_source`: `DELETE FROM titles_fts WHERE session_id = old.id`, then the same conditional insert
     - after delete: `DELETE … WHERE session_id = old.id`
   - Code comment: never run FTS5 `'rebuild'` on this table.
3. **Migration 3 to 4:**
   - Add the column, the table and the triggers, all inside the existing `BEGIN IMMEDIATE`.
   - Set meta `titles_backfilled = 0`. A missing flag (fresh index, or after `rebuildDatabase`, which drops meta) means done.
   - No file churn.
4. **Backfill** (core, runs at the start of an index pass while the flag is 0):
   - Iterate owners, not files: `SELECT s.id, f.path, f.mtime_ms, f.size FROM sessions s JOIN files f ON f.path = s.file_path`. This skips empty, duplicate and invalid files, and never lets a stale `indexed` row for a losing duplicate win (review 2 #5).
   - For each, `parseSessionFile(path, { sessionId: s.id })` with no `onMessage`. It's the shared reader, so it can never disagree with indexing.
   - Write in short per-batch transactions: `UPDATE sessions SET title, title_source` only if the file's current `mtime_ms` and `size` still equal the `files` row. Otherwise skip, because the next index pass re-parses it.
   - Claim nothing: no lock is held across file reads (better-sqlite3 transactions are synchronous, and a held write lock would push the other process past the 10 s busy timeout). Two processes opening at once may both run it. That's idempotent and only wastes CPU.
   - Set the flag to 1 in its own short transaction at the end. An interrupted backfill starts over next time.
   - Status line: `Reading session names (one time)…` in the CLI and TUI.
5. **Keyword search** (`src/core/keyword.ts`):
   - The title query is `SELECT s.id … FROM titles_fts t JOIN sessions s ON s.id = t.session_id WHERE titles_fts MATCH ?`.
   - Filters: cwd applies on `s`. since and until apply as `EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND <buildFilterSql since/until>)`. Skipped entirely under the role filter (D6).
   - Keep only rows with full term coverage. Compute it with a per-term check against `titles_fts`, the same approach as `termCoverage`.
   - Title-hit sessions not in the 500 message candidates are added. If `matchCount > 0`, the best message comes from `keywordMessageMatches(db, query, id, 1)`. If `matchCount === 0`, `snippet = null` (review #5, #10).
   - Return every title hit regardless of `limit` (the cut at keyword.ts:100 would otherwise drop title-only hits before the pin), plus the set of title-hit ids so ranking can pin them (D8).
6. **Ranking** (`src/core/search.ts`, `hybrid.ts`):
   - Inside `order()` (search.ts:186-189), before both cuts to `limit`: `relevance` = tilt, then a stable partition (pinned title hits first), then cut. `recent` = partition, then cut, then sort by time (today it cuts before sorting by time).
   - Hybrid merge: the keyword snippet wins only when it isn't null. `matchCount` = keyword's if > 0, otherwise semantic's (review #10).
   - `hydrate`: when the snippet is null and `titleMatch` is true, fall back to the first user message without highlights, instead of the last message (search.ts:250).
7. **Result shape** (`types.ts`): `titleMatch` and `titleHighlights`, computed on the sanitised stored title with FTS5 `highlight()`, using the same marker parsing as `parseSnippet`.
8. **Surfaces:**
   - **TUI:**
     - `formatRow` returns segments, not a string. Truncation becomes cell-aware and clips ranges at the ellipsis.
     - Title highlights use underline, a style distinct from the selected row's cyan bold.
     - The D9 label goes in `previewHeader` (app.tsx:847-861).
     - `openTranscript` passes no message id when `titleMatch && matchCount === 0` (app.tsx:537), but the preview still fetches by `messageId` (app.tsx:418-427).
   - **Web:**
     - The card title gets highlights, and the D9 label goes where the count goes (app.js:285).
     - The card link gets no `?m=` when `titleMatch && matchCount === 0` (app.js:270). The reader title is not highlighted, because the reader has no query.
     - The label duplicate in app.js:107 is updated to match.
   - **`-p`:** highlight by slicing ranges on the raw title first, then cleaning each piece, as `highlight()` does (cli.ts:793-805). This avoids offsets breaking when `field()` collapses spaces.
9. **Docs:**
   - README: one line saying titles, including `/rename` names, are searched.
   - CHANGELOG:
     - the feature
     - the one-time name read
     - **downgrade warning:** an older ccback refuses a v4 index, and deleting it loses the smart-search data, which then rebuilds in the background

## Tests (each is a real fixture, `CCBACK_HOME=$(mktemp -d)`)

**Title resolution**
- Rename, then rename again: only the latest name matches.
- Rename, then clear: the AI title matches again and the custom name doesn't.
- An AI title regenerated after a rename: the custom name still wins.
- A title record with a different `sessionId` in the file: ignored, for both `custom-title` and `ai-title`.
- Repeated title records at the end of the file: no change.
- Fallback-only session: never a title hit, so nothing is counted twice.

**Index lifecycle**
- A rename appended to an already-indexed file: the next pass picks it up, and the old name stops matching.
- A pruned session: its row is gone from `titles_fts`.

**Matching**
- A partial title match ("fix bug" against 50 titles containing "fix"): no title hits, and body ranking is unchanged from today.
- A hostile title (`"`, `NEAR`, `*`, `OR`, terminal escapes): plain text, printed inert.
- A query that is all stopwords, mixed case, or stemmed (`renaming` vs `rename`): same behaviour as message search.

**Ranking and modes**
- A full-coverage title-only hit is #1 in keyword mode and in hybrid while semantic returns 50 other sessions.
- More title hits than `limit`; `limit` = 1; `recent` with 15 title hits: no title hit is lost to an early cut.
- Single-term query "test" and all-stopword query "how to" against many matching titles: behaviour matches D8 as confirmed.
- A title-only hit has a non-zero score that the recency tilt changes.
- Explicit `--mode semantic`: no title hits and no crash.
- `recent` sort: title hits are ordered by time.
- A title hit whose matching messages fall outside the 500 candidates: no crash, a correct snippet, and `matchCount > 0`.

**Filters**
- Role filter: no title-only hits.
- cwd filter honoured.
- A since window that excludes all of a session's messages: the session is not returned.

**Surfaces**
- TUI: underline is visible on the selected and the unselected row, and is clipped correctly when the title is truncated, with wide characters.
- Web: a title-only card has no `?m=`.
- `-p`: a title with double spaces gets correct highlights.
- `--json` has both new fields.

**Migration and backfill**
- A real-shaped v3 index migrates to v4:
  - titles are correct, including `/rename` names
  - the embedding count is unchanged and nothing is re-embedded
  - message and chunk ids are unchanged
  - the flag is set to 1
- Backfill interrupted halfway, then run again: the result is correct.
- A file changed during the backfill: skipped there, then fixed by the index pass.
- TUI and web opening a v3 index at once: the migration runs once. The backfill may run in both, the result is correct, and neither hits the busy timeout.
- A stale `indexed` row for a duplicate that lost: its title never wins.
- Fresh index and rebuilt index: no backfill runs.

## Out of scope (v2 list)

- Title embeddings (D5).
- Reading the sidecar (D4).
- Renaming sessions from ccback. If built, it must write the same record with `sessionId`.
- Live refresh of an open picker after an outside rename.
- Partial-coverage title boosts, if real use shows full-coverage-only is too strict.
