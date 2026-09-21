# ccfind

Find any Claude Code session by what was said in it, see which folder it lived in, and jump straight back in.

Claude Code keeps every transcript under `~/.claude/projects`, but you remember sessions by topic, not by folder. The built-in `/resume` picker only matches the session title and first message. ccfind searches the full conversation text across every folder on your machine.

Everything runs locally. Nothing leaves your machine, and your Claude directory is only ever read.

Works on macOS, Linux and Windows. Needs Node 20 or newer.

## Install

```sh
npm install -g ccfind          # gives you `ccfind` and the short `ccf`
```

That pulls in the local embedding libraries too, about 140 MB on disk. If you would rather keep it small:

```sh
npm install -g ccfind --omit=optional    # keyword search only, a few MB
```

Want an even shorter command? `ccfind --alias` offers to add `alias sf=ccfind` to your shell startup file. Before it offers, it checks that `sf` is not a program on your `PATH`, not a shell builtin or reserved word (bash, zsh and fish alike), and not already an alias, abbreviation or function in your startup file — or, on fish, a file in `~/.config/fish/functions`. It shows you the exact block it would append — a blank line, a comment saying ccfind added it, and the alias — and, unless you pass `--yes`, asks before adding it. Nothing else in the file is touched, and it never follows a symlink out of your home directory. If it cannot write the file it prints the line for you to paste. Piped or scripted, it prints the line and changes nothing unless you pass `--yes`, which answers the question and skips it while still running every check. Pick your own name with `ccfind --alias qq`. Under a shell it does not know, and on Windows, it prints the line to add instead of guessing at a file.

## Use it

```sh
ccfind                       # the picker, most recent sessions first
ccfind recording videos      # the picker, pre-filled — Enter resumes that session
ccfind -w recording videos   # the same search in your browser
ccfind -p invoices --json    # plain results, for scripts and pipes
```

Words are always the search. Everything else is a flag, so `ccfind web project` looks for "web project". A word that is not a flag ccfind knows stays a word, even with a dash in front of it — `ccfind -p -weird` searches for "-weird" — and everything after `--` is search text, always.

In the picker:

| Key | Action |
| --- | --- |
| type | search as you type |
| ↑ ↓ / Ctrl+P Ctrl+N | move between sessions |
| ← → | step through this session's matches |
| Enter | resume the session in its original folder (`claude --resume <id>`) |
| Ctrl+Y | copy `cd '<folder>' && claude --resume '<id>'` |
| Ctrl+O | open the full transcript in the browser |
| Ctrl+E | show the whole message behind a snippet |
| Ctrl+R | switch between best match and most recent |
| Esc | quit |

Smart search needs no key: it sets itself up on its own, in the background.

## Smart search

Two things run at once: keyword search (SQLite FTS5, BM25, stemming) and semantic search, which matches by meaning — "video editing workflow" finds the session where you said "cut the clips and add captions". Results are merged, so you get both.

Smart search sets itself up on its own. The first time you open the picker or the browser UI, ccfind downloads a small embedding model (`all-MiniLM-L6-v2`, about 23 MB) and starts indexing meaning in the background. Keyword results are there from the first keystroke and quietly get better as it finishes; on a large history the first pass takes a few minutes. After that, a day of new conversation is a top-up of a few seconds, because unchanged text keeps the embeddings it already had.

If you installed with `--omit=optional`, none of that happens and nothing nags you about it: keyword search is the whole tool.

## Everything else

```
-w, --web              open the browser UI (a second run reuses the one already up)
-p, --print            plain results instead of the picker (automatic when piped)
    --json             machine-readable results
    --sort recent      order by last activity instead of best match
    --stats            what the index holds, and where
    --reindex [--full] update the index now; --full rebuilds it from scratch
    --keyword-only     skip smart search for this run
    --alias [name]     offer to add a short command to your shell
    --yes              with --alias: skip the question, still run every check
    --limit N   --cwd <path>   --since <date>   --until <date>   --role user|assistant
    --projects-dir <path>   --port N   --no-open   --no-sync
-h, --help             -v, --version
```

`-p` and `--json` never download anything: if the smart-search model is not on
this machine already, they answer with keyword results and say so in `modeUsed`.
`ccfind --reindex` is what sets smart search up from a terminal.

`--port 0` asks the operating system for any free port, and a busy port is
stepped past rather than refused. `--no-sync` skips the index update, so if you
also pass a `--projects-dir` other than the one the index was built from, it
says on stderr that the results come from the recorded folder — stdout stays
exactly what a pipeline expects. The picker shows the same sentence as its one
status line until you type, and the browser UI as a quiet line under the
results. Single-letter flags can be bundled: `-pw` is `-p -w`.

The browser UI has the same search, a folder and date filter, a best-match / most-recent switch, and a transcript reader with one button: copy the resume command.

## Where things live

- Transcripts: `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects` (override with `--projects-dir`). Read-only.
- Index, model cache and the running-server marker: `~/.ccfind` (override with `CCFIND_HOME`). Safe to delete; it is rebuilt on the next run.
- Subagent transcripts are not indexed.

## Privacy

The web UI binds to `127.0.0.1` only, rejects requests with a foreign `Host` header, sends no CORS headers, and serves a strict Content-Security-Policy. Transcript text is never rendered as HTML. The only network request ccfind ever makes is the one-time model download.

## Development

```sh
npm test            # vitest, no network, never touches your real ~/.claude
npm run typecheck
npm run build
```

See `SPEC.md` for the design.
