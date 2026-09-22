# Changelog

## 0.1.0

- Search every Claude Code session by what was said in it, from the terminal picker, `--print`/`--json` output, or a local browser UI.
- Press Enter on a result to resume that session with `claude --resume` in the folder it belongs to.
- Keeps its own SQLite index of `~/.claude/projects`, updated incrementally on each run; the transcripts themselves are only ever read.
- Keyword search works everywhere; smart (semantic) search sets itself up in the background and improves ranking once its embeddings exist.
- Best match ranks by words and meaning with a small preference for recent activity; Ctrl+R cycles best match, newest first and oldest first, for the session list and the matches inside a session alike.
- Filters for folder, date range and role, plus `--sort best|recent|oldest`, `--stats`, `--reindex` and `--alias` for a short shell command.
