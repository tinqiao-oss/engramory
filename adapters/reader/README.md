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

| Host (`<host>-reader`) | Rules file it writes | Verified here? |
|---|---|---|
| `codex-reader` | `AGENTS.md` | ✅ dogfooded end-to-end |
| `dsh-reader` | `AGENTS.md` | ✅ dogfooded end-to-end |
| `claude-reader` | `CLAUDE.md` | ⚠️ unverified wiring |
| `openclaw-reader` | `AGENTS.md` | ⚠️ unverified wiring |
| `hermes-reader` | `AGENTS.md` | ⚠️ unverified wiring |
| `cline-reader` | `.clinerules` | ⚠️ unverified wiring |
| `windsurf-reader` | `.windsurfrules` | ⚠️ unverified wiring |
| `cursor-reader` | `.cursor/rules/engramory-recall.mdc` (`alwaysApply: true`) | ⚠️ unverified wiring |
| `kiro-reader` | `.kiro/steering/engramory-recall.md` (`inclusion: always`) | ⚠️ unverified wiring |

**"Verified here"** means the wiring was dogfooded on a real machine: a `codex exec -s
read-only` run read the index, opened the relevant note, and returned the fact; for
`dsh-reader`, a live `deepseek-v4-flash` session did the same, and the request dsh sent was
captured to confirm the block had actually been injected. The
"unverified" rows are written from each host's **documented** rules-file format (the same
per-host facts in [PORTING.md](../../PORTING.md)) but have not been run on that host —
Engramory does not claim a host works until it is dogfooded. The tool prints this caveat when
you init one. If you verify one on a real host, please open a PR to flip it.

> **Cline / Windsurf — file vs. directory.** These use the single-file form (`.clinerules`,
> `.windsurfrules`), which current versions still read. Newer versions also support a rules
> **directory** (`.clinerules/*.md`, `.windsurf/rules/*.md`, the latter with an "always-on"
> activation mode). If your version doesn't pick up the single file, move the generated block
> into that directory. (`codex-reader` and `dsh-reader` are the wirings dogfooded here — see
> above.)

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
- The deterministic index-size hook (`hooks/`) is Claude-Code-only and is a *writer* concern;
  it is irrelevant to a reader.
