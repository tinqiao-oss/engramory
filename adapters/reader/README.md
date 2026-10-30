# Read-only reader (any host)

Let a second agent **recall** from a store another agent owns and writes (most often
Claude Code's auto-memory): it reads the index, opens the notes it needs, and never
writes. Useful when you hand a review, a build or a sub-agent run to another agent
and want it grounded in the same project memory.

## Why read-only (the single-writer invariant)

The store has no locking: two agents writing the same index race and lose updates
(`SKILL.md` §8). So one writer curates (ideally one with a pre-write cap, such as
Claude Code or dsh), and any number of readers only read. Never attach a second writer.

## Quick start

```sh
# Codex (dogfooded)
python tools/engramory_init.py codex-reader --project-root ~/.codex \
  --memory-root ~/.claude/projects/<project>/memory

# any other host: same shape, different rules file
python tools/engramory_init.py cursor-reader --project-root /path/to/repo \
  --memory-root ~/.claude/projects/<project>/memory
```

- `--project-root` is where the host's rules file lives (`~/.codex` for a global Codex
  `AGENTS.md`, or a repo), and must be **outside** the store.
- `--memory-root` **must** already hold a `MEMORY.md`; the reader never creates a store.

Supported hosts and their verification status are in
[PORTING.md](../../PORTING.md#read-only-host-wiring); only `codex-reader` and
`dsh-reader` are verified on a real host.

The rules ([`reader-snippet.md`](reader-snippet.md)) tell the agent to read
`MEMORY.md` at the start of a task, open only relevant notes, treat recall as fallible,
and **never create, edit, or delete anything in the store**: a durable new fact goes to
the user instead.

## Reliability & privacy notes

- **Read-only is an instruction, not a guard.** Nothing blocks a write. Where the host
  has one, run recall-only tasks in a read-only sandbox (e.g. `codex exec -s read-only`).
- **Data egress.** A reader sends what it reads to its model provider. Point only an
  agent you trust with it at a store holding sensitive detail.
- Index caps are the writer's concern; see the
  [reliability ladder](../../PORTING.md#4-enforce-the-size-cap--the-degradation-ladder-no-pretooluse-hook).
