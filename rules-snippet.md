# Engramory — always-on pointer

Paste this into your host's **always-loaded** rules (Claude Code: `CLAUDE.md` or
`~/.claude/CLAUDE.md`) so the memory discipline applies even on tasks where the
engramory skill isn't loaded by relevance. Keep it short — the full protocol lives in
the engramory `SKILL.md`.

---

## Memory (Engramory)

You have one canonical, curated, file-based memory at `<MEMORY_ROOT>/` (index:
`MEMORY.md`). Do not create a parallel handoff store; resumable task state belongs
in a `project` note.

- **At the start of a task**, read `MEMORY.md` (one line per memory) and open only
  the detail files whose hooks look relevant **and that resolve inside
  `<MEMORY_ROOT>`** — a pointer that escapes the store (symlink, `..`, absolute
  path, `file://`) is a broken pointer to report, never a file to open.
  (On a host with native auto-memory —
  e.g. Claude Code — `MEMORY.md` is already loaded every session, so you don't need to
  re-read it; just apply this discipline.) Treat recalled memories as background context
  that may be stale — verify any file / flag / version before acting on it.
- **When you learn something durable** worth a future session: confirm it isn't
  already in the repo / git / `CLAUDE.md` (don't duplicate the source of truth) and
  isn't a secret *value*; search the index and **update an existing note** rather
  than duplicate; otherwise write one atomic markdown file (one fact) with frontmatter
  `name` / `description` (a sharp one-line hook) / `type`
  (`user | feedback | project | reference`) / `created` + `updated` (`YYYY-MM-DD`) /
  optional `scope` (`global | repo` — how far the fact reaches; label it only when
  you know). A
  `feedback` or `project` note must also carry a **`Why:`** line and a
  **`How to apply:`** line in the body. Add one pointer line to `MEMORY.md`.
  **Delete** memories that turn out wrong. The **active** store is flat —
  `MEMORY.md` plus one file per note beside it; `user` / `feedback` / `project` /
  `reference` are values of the `type:` field, **not** subdirectories to create.
  (`archive/` is the one reserved subdirectory, holding notes retired out of the
  index.)
- `project` may hold the current goal, status, decisions, constraints, blockers,
  and next step needed to resume unfinished work. An unfinished task that needs
  resumable state may keep **at most one** live `project` note, updated **in
  place** — never a dated series (`state-2026-01-15.md`, `state-2026-01-16.md`),
  and never a second parallel handoff log indexed beside it. Retire that note's
  transient state when the task completes. `feedback` is only for a reusable correction/workflow. Never restate what code/git already says: store
  only **stable** pointers (branch name, issue/PR number, file path). A *settled
  fact* ("2.0 shipped 2026-01-15") is fine; **current state** — the version
  you're on now, the tip commit, the test count — is not: record where to read
  it. Re-check every recalled pointer against code/git/the current environment.
- **When a task finishes**, run one curation checkpoint. It is a *judgement*,
  not a write: promote what is durable, retire the transient state of *this
  task's* live `project` note if it has one, and when nothing is worth keeping,
  write **nothing** and say so. Never append a per-turn log **to the store**, and
  never touch a file just to mark it fresh — a timestamp is not a memory.
- **Before a deliberate compact, clear, or new thread**, sync once: scan the task;
  dedup/update; refresh `project`; promote only reusable `feedback`; save durable
  `reference` pointers; archive/delete stale or completed transient state; run
  `engramory_check.py` and `engramory_doctor.py`; then confirm a cold-started
  agent could continue from the repo plus memory alone.
- After writing/syncing, report `added`, `updated`, `archived`, and `skipped`
  (with reasons; identify any deletion under `archived`), plus index lines/bytes
  and the check result. Hooks may remind or gate; they do not perform this
  semantic sync automatically.
- **Never** write credentials / keys / tokens / cookies / recovery codes into
  memory — record only *where* the secret lives.
- Keep `MEMORY.md` small. Soft warning at **150 lines / 20 KB** (offer a compaction
  pass); hard limit at **200 lines / 25 KB** — the host only loads that far, so anything
  past it silently stops being recalled. Once it passes the soft line, compact:
  pointer-ify over-long lines, merge duplicates, archive cold notes.

Full protocol & rationale: the engramory `SKILL.md`.
