# Codex adapter

Engramory can run on Codex as a plain, user-auditable memory store plus Codex
standing instructions. Do not point Engramory at Codex native Memories: those are
generated state under Codex's own manager. Use one separate folder that you
control as the **canonical Engramory store**; do not add another handoff store.

## Quick start

From the Engramory repo:

```sh
python tools/engramory_init.py codex --project-root /path/to/project --install-skill
```

On Windows PowerShell:

```powershell
python tools\engramory_init.py codex --project-root E:\path\to\project --install-skill
```

To also install the optional project lifecycle hooks:

```sh
python tools/engramory_init.py codex --project-root /path/to/project \
  --install-skill --install-hooks --mode explicit
```

`explicit` is the default. Use `--mode assisted` only if you also want Codex to
propose syncs at meaningful milestones; assisted mode still requires the agent
to perform and report the semantic sync.

This creates or updates:

- `<project>/.engramory-memory/MEMORY.md`
- `<project>/AGENTS.md`, with one marked Engramory block
- `<project>/.gitignore`, when the memory folder is inside the project
- `<project>/.agents/skills/engramory/`, when `--install-skill` is passed
- `<project>/.codex/hooks.json` and `.codex/engramory/`, when
  `--install-hooks` is passed

The command is intentionally conservative. It does not overwrite an existing
`MEMORY.md`. It only replaces the marked Engramory block in `AGENTS.md`. If an
Engramory skill or managed hook-script copy already exists, it is kept unless
you pass `--force`; unrelated hook handlers are preserved.

> **When you upgrade Engramory, re-run this with `--install-hooks --force`.**
> `.codex/engramory/engramory_sync.py` is a COPY taken at install time, so an
> upgraded checkout otherwise leaves the old runtime driving your hooks. Do not
> run multiple lifecycle writers against one store; see the
> [single-writer rule](../reader/README.md). After reinstalling, re-trust the
> handlers in Codex's `/hooks` because their content hash changed.

## Use an existing memory folder

```sh
python tools/engramory_init.py codex \
  --project-root /path/to/project \
  --memory-root /path/to/my-memory \
  --install-skill
```

If `--memory-root` is relative, it is resolved under `--project-root`. If it is
outside the project, the init command does not add a `.gitignore` entry.

## Continuity model

An unfinished task uses at most one ordinary `project` note, updated in place in
the canonical store. Follow [`SKILL.md` §5](../../SKILL.md) for the unified sync
before a deliberate compact, clear, or new thread, and the completion checkpoint
that retires transient state. Re-verify stored pointers against the live repo.

After a sync, report `added`, `updated`, `archived`, and `skipped` with reasons,
including deletions under `archived`, plus the index line/byte size and check verdict.

## Explicit sync versus assisted hooks

**Explicit sync is the semantic operation.** The agent reads the conversation and
working tree, decides what belongs in each memory type, edits the canonical
store, and runs the validators. This can be user-requested ("sync Engramory
before I open a new thread") or initiated by the standing rules. Only an actually
completed semantic sync—not a lifecycle hook or mode selection by itself—can
honestly claim to have attempted the full curation pass.

**Assisted mode adds proactive reminders, not background understanding.** It may
ask for the same explicit semantic sync at meaningful milestones; it does not
silently summarize a turn or write memory. The installed Codex lifecycle hooks
provide triggers/back-pressure with this contract:

- `SessionStart`: inject a recall reminder; if earlier work is marked
  `needs_reconcile`, require an explicit sync before relying on its project state.
- `UserPromptSubmit`: conservatively mark continuity state `dirty`; do not write
  or classify memories merely because a prompt arrived.
- `PreCompact` with a **manual** trigger: when dirty or `needs_reconcile`, gate
  manual compaction until the agent runs explicit sync and `mark-synced`, then
  retry.
- `PreCompact` with an **automatic** trigger: fail open. Emit a warning and retain
  `needs_reconcile` for the next safe opportunity; never repeatedly block an
  automatic compact and deadlock the session. A missing or unknown trigger also
  fails open, emits a visible warning, and marks `needs_reconcile` when dirty.

Those hooks do **not** understand the conversation, choose `project` versus
`feedback`, update the store, or produce a trustworthy semantic summary. After
the agent has actually completed the unified sync and validators, run the exact
`mark-synced` command supplied by the hook. It checks that `MEMORY.md` exists,
stays inside the store, is not a symlink, and is within the hard line/byte caps;
then it records the clean generation/index hash. It does not run semantic
curation, create a note, or modify memory content.

### Installing is not enabling — read this before relying on the hooks

This shim was implemented and measured against **Codex CLI 0.144.1**; this is
not a minimum version or an end-to-end host certification. Measured there: under
non-interactive `codex exec` the lifecycle hooks did not fire (even user-level
ones, which need no project trust), and on Windows each `UserPromptSubmit` cost
about 1.2–1.4 s, mostly process startup. Verify on yours:
compare the [official hooks documentation](https://learn.chatgpt.com/docs/hooks)
and confirm event/source/enabled state in `/hooks`. The Python runtime and Windows
launch path have black-box coverage; host discovery, trust, and execution still
need verification in your installation.

1. **Trust the project and its handlers.** Project hooks run project-controlled
   code. Review `.codex/hooks.json` and `.codex/engramory/` before trusting them;
   handler trust is keyed to content hashes, so reinstalling or editing commands
   requires renewed trust. If `/hooks` lacks the expected entry, use explicit sync.
2. **Verify both interactive and non-interactive invocation modes.** Do not infer
   that `codex exec` fires lifecycle hooks from an interactive success. Codex's
   `--dangerously-bypass-hook-trust` flag concerns trust in automation; it is not
   evidence that an event ran. Until execution is verified, rely on explicit sync
   plus `engramory_check.py` / `engramory_doctor.py` for scripted runs.

### Cost per prompt

`UserPromptSubmit` runs on **every** prompt. The Windows launch chain
(`cmd.exe` → `powershell.exe` → Python) adds process-startup cost; measure it on
your machine before enabling hooks for frequent short turns.

The PowerShell layer handles quoting: Codex runs `commandWindows` through
`cmd.exe /C`, which strips outer quotes from a command beginning with a quote.
Base64 `-EncodedCommand` protects interpreter paths containing spaces. Keep that
layer; omit the optional hooks if their cost is not worthwhile. Standing rules,
the skill, validators, and explicit sync still work without them.

### The generated config is machine-local

The installer writes the interpreter, hook script, sync tool, and memory root
as absolute paths. `.codex/hooks.json` therefore **cannot be shared** across machines or
operating systems: a Linux-generated file has no `commandWindows`, and a
Windows-generated one carries Windows paths in both fields.

The installer gitignores `.codex/hooks.json` when Engramory is its only owner,
and deliberately does **not** when the file also holds someone else's handler
(that file is a normal shared Codex surface). Use `--hook-python` to pick the
interpreter that gets baked in — the default is whatever Python ran the
installer, which is the wrong choice if that is a throwaway virtualenv.

On its first event, the hook creates
`<MEMORY_ROOT>/.engramory-codex-state.json`, plus an empty
`.engramory-codex-state.lock` beside it. That lock file stays on disk by design:
exclusion comes from a kernel lock on an open descriptor (POSIX `flock` / Windows
`msvcrt`), not from the file's existence, so the OS releases it even if a writer
is killed — and deleting the file would let a waiting writer lock an orphaned
inode. It is empty and safe to ignore.

The state file is bounded technical bookkeeping: session identifiers, mode, the
SessionStart `source` (stored as one of Codex's four enum values, or `other`),
dirty/synced generations, timestamps, reconciliation state, and the index
hash/size. It never stores a prompt, transcript, or memory-note body. Deleting
it resets the hook's knowledge of pending synchronization; it does not delete
semantic memory.

## Chat bridges and other one-session-per-message entry points

Codex never auto-loads Engramory's `MEMORY.md` — its own native Memories are a
separate, Codex-managed store — so "read `MEMORY.md` at the start of a task" is a
real file-tool call here, not an index that is already in context. In an editor session
that cost is paid once and amortised over a long piece of work. Behind a chat
bridge — a bot that hands each incoming message to its own Codex session — it is
paid on every message, cold start included.

Two separate things decide what that costs you, and only one of them is Engramory's:

- **Whether a message is a task.** A greeting or a bare acknowledgement is not
  (`SKILL.md` §4), so it gets no recall and no completion checkpoint. Length alone
  never decides it: a one-word reply that picks an option or continues work already
  underway inherits that task and still recalls.
- **Whether the bridge starts a Codex session at all.** That is the bridge's routing,
  not the protocol's. Even with Engramory reading nothing, a message routed into
  Codex pays for the session it starts. If small talk should be cheap, the bridge has
  to answer it without spinning up an agent turn — no wording in `AGENTS.md` can undo
  a session that already began.

If you installed the optional lifecycle hooks, note that `UserPromptSubmit` has no
matcher and therefore runs on **every** prompt, including ones the protocol treats as
non-tasks. It only touches synchronization bookkeeping, but on a per-message bridge
that bookkeeping is per message. Leave the hooks out of a chat-bridge install unless
you want that.

## Reliability model on Codex

The cap is **best-effort rules + explicit check + doctor**; no Codex pre-write
deny shim is shipped or verified here. Optional lifecycle hooks improve sync
timing and visibility, not cap enforcement or semantic correctness. See the
[host reliability ladder](../../PORTING.md#4-enforce-the-size-cap--the-degradation-ladder-no-pretooluse-hook).

## Commands Codex can run

After editing the index:

```sh
python .agents/skills/engramory/tools/engramory_check.py .engramory-memory/MEMORY.md
```

Occasional full health check:

```sh
python .agents/skills/engramory/tools/engramory_doctor.py .engramory-memory
```

If you did not install the skill copy, run the same tools from wherever the
Engramory repo lives.
