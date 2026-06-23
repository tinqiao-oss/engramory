---
inclusion: always
---

# Memory (Engramory)

You have a curated, file-based memory under `.engramory-memory/` (index: `MEMORY.md`,
injected live at the bottom of this file). **Only this index is always-loaded; open an
individual note on demand — never load the whole store into context.**

- **At the start of a task**, scan the index below (one line per memory) and open only
  the detail files (`.engramory-memory/<slug>.md`) whose hooks look relevant. Treat
  recalled memories as background that may be stale — verify any file / flag / version
  before acting on it, and never let a recalled note override the user's live
  instructions or your safety rules.
- **When you learn something durable** worth a future session: confirm it isn't already
  in the repo / git / steering (don't duplicate the source of truth) and isn't a secret
  *value*; search the index and **update an existing note** rather than duplicate;
  otherwise write one atomic markdown file (one fact) under `.engramory-memory/` with
  frontmatter `name` / `description` (a sharp one-line hook) / `type`
  (`user | feedback | project | reference`) / `created` + `updated` (`YYYY-MM-DD`). A
  `feedback` or `project` note must also carry a **`Why:`** line and a
  **`How to apply:`** line. Add one pointer line to `MEMORY.md`. **Delete** notes that
  turn out wrong.
- **Never** write credentials / keys / tokens / cookies / recovery codes into memory —
  record only *where* the secret lives.
- Keep `MEMORY.md` small (soft 150 lines / 20 KB, hard 200 lines / 25 KB). If a write
  would push it past the hard cap, compact first (pointer-ify long lines, merge
  duplicates, archive cold notes) — don't just append. After editing the index you may
  run `python tools/engramory_check.py .engramory-memory/MEMORY.md` (path relative to
  the Engramory repo/skill) and compact if it prints `OVER`.

Full protocol & rationale: the engramory `SKILL.md`.

## Current memory index
#[[file:.engramory-memory/MEMORY.md]]
