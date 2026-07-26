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

An unfinished task is resumed through an ordinary `project` note in the canonical
store, not a fifth `handoff` type. That note may contain the current goal, status,
decisions, constraints, blockers, and next concrete step. `feedback` remains only
for a reusable correction or workflow. Such a note stores only **stable**
pointers (branch name, issue/PR number, file path) and may record a settled fact
("2.0 shipped on 2026-01-15"), but never **current state** — the version you are
on now, the tip commit, the current test count. Every recorded pointer must be
checked against the live repo/environment before use.

Before a deliberate compact, clear, or new thread, run the unified sync in
`SKILL.md`: scan → dedup/update → project → reusable feedback → durable
references → retire stale/completed transient state → check + doctor → cold-start
sufficiency. On task completion, archive or delete transient status after
promoting the durable decisions that remain useful.

After the sync, report `added`, `updated`, `archived`, and `skipped` (including
reasons; identify any deletion under `archived`), plus the index line/byte size
and check verdict.

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

Two limits are structural. Neither is a bug in this adapter, and neither can be
fixed from here:

1. **A freshly installed project hook does not run until you trust it.** Codex
   disables project-local config, hooks, and exec policies "in the following
   folders until the project is trusted", and each handler additionally carries a
   trust state keyed to its content hash. So installation leaves the hooks
   **inactive**: open Codex's `/hooks` view, confirm the event/source/enabled
   state, and trust them. Because the trust is content-hashed, **re-running the
   installer or editing the command invalidates it and you must trust again**. If
   `/hooks` does not show the expected entry, assume the assistance is absent and
   use explicit sync.
2. **Non-interactive `codex exec` did not fire these lifecycle hooks when tested.**
   Measured on **0.144.1**: a correctly-shaped, successfully-parsed config produced
   no `SessionStart` / `UserPromptSubmit` execution under `codex exec` — including
   at the *user* level (`~/.codex/hooks.json`, which needs no project trust) with a
   writable sandbox, so project-trust alone does not explain it.

   This is one version's observation, not a permanent property: Codex ships a
   `--dangerously-bypass-hook-trust` flag aimed at running enabled hooks in
   automation, and this area is moving. **Re-test on your version** rather than
   assuming either answer. Until you have, treat the assistance as interactive-TUI
   only and rely on explicit sync plus `engramory_check.py` /
   `engramory_doctor.py` for scripted runs.

### Cost per prompt

`UserPromptSubmit` runs on **every** prompt and Codex 0.144.1 does not support
async hooks ("async hooks are not supported yet"), so the cost is synchronous.
Measured on Windows: **~1.2–1.4 s per prompt**, dominated by process startup
(`cmd.exe` → `powershell.exe` → Python).

That PowerShell layer is deliberate and should not be "optimised" away: Codex
runs `commandWindows` through `cmd.exe /C`, which strips the outer quotes of a
command line that *begins* with a quote — and an interpreter path containing a
space must be quoted. The Base64 `-EncodedCommand` sidesteps that quoting trap
entirely. A direct `cmd.exe` invocation measured far faster only because it
failed immediately.

If that per-prompt cost is not worth it for your project, do not install the
hooks: the base three-layer adapter (AGENTS.md + skill + validators) still works,
and explicit sync remains the semantic operation either way.

Project-scoped hooks execute project-controlled code. Review them before trusting
the project and enable them only for a trusted checkout.

### The generated config is machine-local

Codex 0.144.1 has no project-directory variable for hook commands, so the
interpreter, hook script, sync tool, and memory root are all written as absolute
paths. `.codex/hooks.json` therefore **cannot be shared** across machines or
operating systems: a Linux-generated file has no `commandWindows`, and a
Windows-generated one carries Windows paths in both fields.

The installer gitignores `.codex/hooks.json` when Engramory is its only owner,
and deliberately does **not** when the file also holds someone else's handler
(that file is a normal shared Codex surface). Use `--hook-python` to pick the
interpreter that gets baked in — the default is whatever Python ran the
installer, which is the wrong choice if that is a throwaway virtualenv.

The installer writes the managed hook configuration to `.codex/hooks.json` and
managed scripts under `.codex/engramory/`. It preserves unrelated hook handlers;
review both locations before granting project trust.

On its first event, the hook creates
`<MEMORY_ROOT>/.engramory-codex-state.json` (and a short-lived lock beside it).
This is bounded technical bookkeeping: session identifiers, mode/source,
dirty/synced generations, timestamps, reconciliation state, and the index
hash/size. It never stores a prompt, transcript, or memory-note body. Deleting
it resets the hook's knowledge of pending synchronization; it does not delete
semantic memory.

This shim was implemented against and source-checked against the **Codex CLI
0.144.1** command-hook schema and behavior. The Python lifecycle runtime and the
generated `cmd.exe`/PowerShell launch path have black-box coverage; project hook
discovery, trust, and execution inside a real Codex host still need to be
confirmed with `/hooks`. This is an implementation target, not a claimed
minimum version or end-to-end host certification. On any other version, compare
the [official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks),
then use `/hooks` to verify the installed entries; if unavailable or
incompatible, fall back to explicit sync.

## Reliability model on Codex

The base Codex adapter uses three layers:

1. `AGENTS.md` makes the recall/write discipline visible at the start of each
   Codex run.
2. `.agents/skills/engramory/SKILL.md` gives Codex the full protocol on demand.
3. `tools/engramory_check.py` and `tools/engramory_doctor.py` are the portable
   backstops for index size and store health.

With `--install-hooks`, a fourth lifecycle-assistance layer adds bounded recall
navigation and dirty/compact bookkeeping. It still delegates semantic curation
to the agent.

This is useful, but not a hard global write guard. The Claude Code
`PreToolUse` hook in `hooks/` is not a Codex hook. Until a Codex-specific
pre-write hook shim is written and tested, the index cap on Codex is enforced by
rules plus explicit checks, not by a deterministic deny hook. Optional lifecycle
hooks described above improve timing and visibility, not semantic correctness.

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
