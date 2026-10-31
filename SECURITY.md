# Security Policy

Engramory is a local developer tool: a discipline, a Claude Code index hook, optional
Codex lifecycle hooks, a dsh guard plugin (`adapters/dsh/plugin/`) and helper scripts.
It runs entirely on your machine and opens no network service of its own. The one
network surface is inside dsh: the plugin adds two routes to dsh's web server for its
settings and memory pages (`/api/engramory/settings`, `/api/engramory/memory`), which
dsh answers only for the signed-in owner. They save the plugin's settings, list note
names, and ask dsh to open a note on the dsh machine; no note's text is served.

## Reporting a vulnerability

Please **do not** open a public issue for a security-sensitive report. Instead open a
private GitHub Security Advisory on this repository, or email **support@tinqiao.com**
with details and a minimal repro. We aim to acknowledge within a few business days
(no formal SLA).

## Scope & threat model

- **The store is plain, unencrypted text** by design. `.gitignore` is not a security
  boundary: a store in a synced or backed-up folder leaves the machine. **Never put
  secret values in memory**, only where they live; this is unenforced discipline
  (`SKILL.md` §5).
- **The index caps are size nudges, not security controls.** The Claude Code hook
  fails open on unexpected input (it must never brick editing) and sees only
  `Edit | Write | MultiEdit`; the dsh plugin sees only dsh's own file tools. Shell tools
  (Bash, PowerShell, background commands), MCP file tools, external editors and sync
  clients go past both.
- **The dsh plugin's social mode is best-effort, not access control.** It keeps the
  memory out of conversations that are not the owner's by not injecting it there and
  refusing dsh's file tools pointed at a store. It recognises the owner by what dsh's
  browser client sends, which a program can imitate; a shell tool reads any file, and
  another profile on the same account can read the store. Real isolation needs
  filesystem permissions or a sandbox.
- **Memory is attacker-influenceable input.** Another process, a synced document or a
  manipulated earlier session can alter the files, and a tampered `feedback` note is a
  *stored prompt injection*. Engramory does not authenticate memory: recall is advisory
  data, never a command, and never outranks the user's live instructions or safety
  (`SKILL.md` §4). Keep the store private and review surprising memories.
- **Codex project hooks run project-controlled code.** Inspect `.codex/hooks.json` and
  `.codex/engramory/`, trust only hook code you accept, and verify handlers with
  `/hooks`. The shim blocks only a known manual compaction while its bookkeeping is
  dirty; automatic, missing and unknown triggers fail open visibly. It is a timing aid,
  not a security boundary or proof of a sync.
- **The Codex state file is bookkeeping, not memory.** It holds session ids,
  timestamps, generations, mode, the SessionStart source (normalised to
  `startup|resume|clear|compact|other`, since it arrives untrusted and is echoed back
  by `status --json`), reconcile state and the index hash/size. Never prompts,
  transcripts or note bodies. Index and state paths refuse to follow symlinks.
- **The installer's symlink-escape checks are best-effort.** `engramory_init.py`
  refuses targets outside `--project-root` and re-checks before each write, delete and
  copy, but an attacker who swaps a parent directory for a symlink between check and
  write still wins (closing that needs handles the stdlib lacks). It does not roll
  back: a failure part-way leaves the completed steps and reports them.

**In scope:** a crafted `tool_input` that makes the hook wrongly block or pass a real
index edit; a crafted dsh tool execution that does the same to the plugin; a crafted
Codex hook event that blocks a non-manual compaction, bypasses a dirty manual gate,
escapes the store, or persists prompt content; output that is not safely
JSON-encoded. **Out of scope:** the store being readable by local processes
(intended) and the unenforced secrets discipline (documented).
