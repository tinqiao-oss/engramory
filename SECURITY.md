# Security Policy

Engramory is an experimental (0.x) local developer tool: a discipline plus a
Claude Code index hook, optional Codex lifecycle hooks, a dsh guard plugin
(`adapters/dsh/plugin/`, same size-nudge role as the Claude Code hook — a
discipline rail, not a security control), and local helper
scripts. It has no network surface and runs entirely on your machine.

## Reporting a vulnerability

Please **do not** open a public issue for a security-sensitive report. Instead:

- Open a private GitHub Security Advisory on this repository, **or**
- Email **support@tinqiao.com** with details and a minimal repro.

We aim to acknowledge within a few business days. As a 0.x project there is no
formal SLA, but we take memory-content and hook-safety issues seriously.

## Scope & threat model

- The memory store is **plain, unencrypted text** the user can read and audit by
  design. `.gitignore` is not a security boundary — a store in a cloud-synced or
  backed-up folder leaves the machine. **Never put secret values in memory** (only
  pointers to where they live). This is unenforced discipline — see `SKILL.md` §5.
- The Claude Code PreToolUse hook is a **size nudge, not a security control.** It fails open
  on unexpected input (so it can never brick editing), and it only intercepts the
  matched direct-edit tools (`Edit | Write | MultiEdit`) — not shell tools (Bash,
  PowerShell, a background Monitor command), MCP file tools, external editors, or
  sync clients. It is not a global write guard.
- **Memory is attacker-influenceable input.** The store is plain files another
  process, a synced document, or a manipulated earlier session can write or alter;
  because `feedback` notes are designed to shape behavior across sessions, a
  tampered note is a *stored prompt injection*. Engramory does not authenticate
  memory content — recalled memory must be treated as advisory data, never as a
  command, and never outrank the user's live instructions or safety (see `SKILL.md`
  §4). Keep the store private and trusted; review surprising memories.
- **Codex project hooks execute project-controlled code.** Inspect
  `.codex/hooks.json` and `.codex/engramory/`, trust only a checkout whose hook
  code you accept, and verify the registered handlers with `/hooks`. The
  lifecycle shim blocks only a known manual compaction when its bookkeeping says
  work is dirty. Automatic, missing, and unknown trigger kinds fail open visibly
  to avoid a context-limit deadlock; this timing aid is not a security boundary
  or proof that semantic memory was synced.
- The Codex shim's `<MEMORY_ROOT>/.engramory-codex-state.json` is bounded
  bookkeeping, not memory. It records session identifiers, timestamps,
  generations, mode, the SessionStart source, reconciliation state, and index
  hash/size. The runtime never passes prompt text to the state layer and never
  stores prompts, transcripts, or note bodies there. The `source` is normalized
  to Codex's own enum (`startup|resume|clear|compact`, else `other`) rather than
  stored verbatim: it arrives in an untrusted event, and `status --json` prints
  session records straight back into a model's context. The index and state paths reject symlinks
  when validation or mutation would otherwise follow them.
- **The installer's symlink-escape checks are best-effort, not a closed race.**
  `engramory_init.py` refuses a target that resolves outside `--project-root`, and
  re-checks immediately before each write, delete, and copy rather than trusting
  the run's preflight. A local attacker who can swap a parent directory for a
  symlink *between* that check and the write still wins; closing that needs
  fd-relative, reparse-point-refusing directory handles the stdlib does not offer
  portably. The installer also does not roll back: a failure part-way leaves the
  completed steps on disk and reports exactly which ones they were.

In scope: a crafted `tool_input` that makes the hook mis-gate (wrongly block or
wrongly pass) a real index edit; a crafted dsh tool execution that makes the
plugin guard mis-gate the same way; a crafted Codex hook event that incorrectly
blocks non-manual compaction, bypasses a dirty manual gate, escapes the configured
store, or persists prompt content; or output that is not safely JSON-encoded.
Out of scope: the store being readable by local processes (intended), and the
unenforced secrets discipline (documented limitation).
