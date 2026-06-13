# Engramory — always-on pointer

Paste this into your host's **always-loaded** rules (Claude Code: `CLAUDE.md` or
`~/.claude/CLAUDE.md`) so the memory discipline applies even on tasks where the
engramory skill isn't loaded by relevance. Keep it short — the full protocol lives in
the engramory `SKILL.md`.

---

## Memory (Engramory)

You have a curated, file-based memory at `<MEMORY_ROOT>/` (index: `MEMORY.md`).

- **At the start of a task**, read `MEMORY.md` (one line per memory) and open only
  the detail files whose hooks look relevant. Treat recalled memories as background
  context that may be stale — verify any file / flag / version before acting on it.
- **When you learn something durable** worth a future session: confirm it isn't
  already in the repo / git / `CLAUDE.md` (don't duplicate the source of truth) and
  isn't a secret *value*; search the index and **update an existing note** rather
  than duplicate; otherwise write one atomic markdown file (one fact), typed
  `user | feedback | project | reference`, with a sharp one-line `description`, and
  add a single pointer line to `MEMORY.md`. **Delete** memories that turn out wrong.
- **Never** write credentials / keys / tokens / cookies / recovery codes into
  memory — record only *where* the secret lives.
- Keep `MEMORY.md` small (the host loads ~its first 200 lines / 25 KB). If it grows
  past that, compact: pointer-ify over-long lines, merge duplicates, archive cold
  notes.

Full protocol & rationale: the engramory `SKILL.md`.
