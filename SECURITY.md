# Security Policy

Engramory is an experimental (0.x) local developer tool: a discipline plus a
Claude Code hook and two helper scripts. It has no network surface and runs
entirely on your machine.

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
- The PreToolUse hook is a **size nudge, not a security control.** It fails open
  on unexpected input (so it can never brick editing) and only ever blocks edits
  that grow the index past the configured cap.

In scope: a crafted `tool_input` that makes the hook mis-gate (wrongly block or
wrongly pass) a real index edit, or output that isn't safely JSON-encoded.
Out of scope: the store being readable by local processes (intended), and the
unenforced secrets discipline (documented limitation).
