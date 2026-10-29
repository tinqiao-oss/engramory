# Read-only reader (any host)

Wire **any agent** to *recall* from a memory store that **another agent owns and writes** —
most usefully, Claude Code's native auto-memory. The reader reads the index and opens the
notes it needs; it never writes. Use it when one agent is the primary curator and you hand
delegated work (a review, a build task, a sub-agent run) to a second agent, and want that
run grounded in the same project memory without hand-feeding it.

This generalizes the pattern to **one writer, N readers**. The store is plain markdown, so
any agent that can read files can read it; the read-only recall rule is host-agnostic text.
The only per-host difference is **which always-loaded rules file** it goes in.

## Why read-only (the single-writer invariant)

Engramory assumes a **single writer / serialized writes** — the store has no locking, so two
agents writing the same index race and lose updates (`SKILL.md` §8). One designated writer
(e.g. Claude Code, which also has the deterministic index-size hook) stays the curator; every
reader only reads. You can attach many readers safely; you must not attach a second writer.

## Quick start

Point a reader at an **existing** store — e.g. Claude Code's memory directory:

```sh
# Codex (dogfooded)
python tools/engramory_init.py codex-reader --project-root ~/.codex \
  --memory-root ~/.claude/projects/<project>/memory

# any other host — same shape, different rules file:
python tools/engramory_init.py cursor-reader --project-root /path/to/repo \
  --memory-root ~/.claude/projects/<project>/memory
```

- `--project-root` is where the host's rules file lives (e.g. `~/.codex` for a global Codex
  `AGENTS.md`, or a repo for a project-scoped rule). It must be **outside** the store.
- `--memory-root` **must** be an existing store (a directory with `MEMORY.md`). The reader
  never creates one and refuses otherwise.

## Supported reader hosts

The [host wiring and verification table](../../PORTING.md#read-only-host-wiring)
is maintained in PORTING.md, including the Cline / Windsurf directory fallback.
Only `codex-reader` and `dsh-reader` have real-host verification here; the installer
labels the other wirings unverified.

## What the reader is told

The rules (in [`reader-snippet.md`](reader-snippet.md)) instruct the agent to: read
`MEMORY.md` at the start of a task, open only the relevant notes, treat recall as fallible
background to verify, and **never create, edit, or delete anything in the store** — if it
learns something durable, surface it to the user instead of writing it.

## Reliability & privacy notes

- **The read-only rule is instruction-level, not a hard guard.** Nothing physically blocks a
  file write. For a hard stop on hosts that support it, run the reader under a read-only
  sandbox (e.g. `codex exec -s read-only`) for recall-only tasks.
- **Data egress.** A reader sends what it reads to its model provider. If the store holds
  sensitive project detail, be deliberate about which agent you point at it, and scope
  `--memory-root` to a store (or curated subset) you're comfortable sending off-machine.
- Index-size guards are a writer concern; see the [host reliability ladder](../../PORTING.md#4-enforce-the-size-cap--the-degradation-ladder-no-pretooluse-hook).
