# Codex read-only reader

Wire **Codex** to *recall* from a memory store that **another agent owns and writes** —
most usefully, Claude Code's native auto-memory. Codex reads the index and opens the
notes it needs; it never writes. This is for the pattern where Claude Code is the primary
agent/curator and you hand delegated work (a review, a build task, a sub-agent run) to
Codex, and you want that Codex run grounded in the same project memory without
hand-feeding it every time.

This is a **read-only** host: it creates no store, adds no `.gitignore`, and installs no
write tools. It is additive and independent of the write `codex`/`openclaw` adapters — it
uses a distinct `AGENTS.md` marker, so a project can carry both.

## Why read-only (not a second writer)

Engramory assumes a **single writer / serialized writes** — the store has no locking, so
two agents writing the same index race and lose updates (`SKILL.md` §8). Claude Code stays
the sole writer and curator; Codex only reads. That keeps the memory coherent and under
one agent's judgement, and it means turning Codex loose on the store can't corrupt it.

## Quick start

Point it at an **existing** store — e.g. Claude Code's memory directory:

```sh
python tools/engramory_init.py codex-reader \
  --project-root ~/.codex \
  --memory-root ~/.claude/projects/<project>/memory
```

On Windows PowerShell:

```powershell
python tools\engramory_init.py codex-reader `
  --project-root $env:USERPROFILE\.codex `
  --memory-root $env:USERPROFILE\.claude\projects\<project>\memory
```

- `--project-root` is where the `AGENTS.md` lives. Use `~/.codex` to make the read-only
  recall rule apply to **every** Codex run, or a project directory to scope it to one repo.
- `--memory-root` **must** be an existing store (a directory containing `MEMORY.md`). The
  command refuses to run otherwise — it never creates a store. Find Claude Code's memory
  dir under `~/.claude/projects/<project-slug>/memory/`.

This adds one marked block to `AGENTS.md`:

```
<!-- BEGIN ENGRAMORY CODEX-READER -->
… read-only recall rules, pointing at your store …
<!-- END ENGRAMORY CODEX-READER -->
```

Re-running only replaces that block. If the same `AGENTS.md` already has a write `codex`
block, both are kept (distinct markers).

## What Codex is told

The rules (in `recall-snippet.md`) instruct Codex to: read `MEMORY.md` at the start of a
task, open only the relevant notes, treat recalled memory as fallible background to verify,
and **never create, edit, or delete anything in the store** — if it learns something
durable, surface it to the user instead of writing it.

## Reliability & privacy notes

- **No enforcement of the read-only rule.** This is instruction-level, not a hard guard —
  Codex *should* not write, and the rule says so plainly, but nothing physically blocks a
  file write. If you want a hard stop, run Codex under a read-only sandbox
  (`codex exec -s read-only`) for tasks that only need recall.
- **Data egress.** Codex sends what it reads to its model provider. If the store holds
  sensitive project detail, be deliberate about pointing Codex at it — scope `--memory-root`
  to a store (or a curated subset) you're comfortable sending off-machine.
- The deterministic index-size hook (`hooks/`) is Claude-Code-only and is a *writer*
  concern; it is irrelevant to a read-only reader.
