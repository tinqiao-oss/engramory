# Codex adapter

Engramory on Codex is a plain-file store you control plus a block in `AGENTS.md`.
Keep it apart from Codex's native Memories, which Codex generates and manages; use
one **canonical Engramory store** and no second handoff store.

## Quick start

From the Engramory repo (on Windows, `tools\engramory_init.py` and a Windows path work
the same):

```sh
python tools/engramory_init.py codex --project-root /path/to/project --install-skill
```

With the optional lifecycle hooks:

```sh
python tools/engramory_init.py codex --project-root /path/to/project \
  --install-skill --install-hooks --mode explicit
```

`explicit` is the default; `--mode assisted` also has Codex propose a sync at
milestones (the agent still does the sync).

This creates or updates:

- `<project>/.engramory-memory/MEMORY.md` (never overwritten if it exists)
- `<project>/AGENTS.md`: only the marked Engramory block is replaced
- `<project>/.gitignore`, when the store is inside the project
- `<project>/.agents/skills/engramory/`, with `--install-skill`
- `<project>/.codex/hooks.json` and `.codex/engramory/`, with `--install-hooks`

An existing skill or hook-script copy is kept unless you pass `--force`; other hook
handlers are left alone.

> **After upgrading Engramory, re-run with `--install-hooks --force`.**
> `.codex/engramory/engramory_sync.py` is a copy made at install time, so the old one
> keeps running otherwise. Then re-trust the handlers in `/hooks` (their content hash
> changed). Never run two lifecycle writers on one store
> ([single-writer rule](../reader/README.md)).

To use an existing folder, add `--memory-root /path/to/my-memory`. A relative path is
resolved under `--project-root`; a store outside the project gets no `.gitignore` entry.

## Continuity: explicit sync, hooks only assist

An unfinished task keeps at most one `project` note, updated in place. Before a
deliberate compact, clear, or new thread, the agent runs the sync in
[`SKILL.md` §5](../../SKILL.md) and reports `added`, `updated`, `archived` (deletions
included) and `skipped` with reasons, plus the index size and check result.

**The sync is semantic work the agent does**: reading the conversation and the tree,
deciding what goes where, editing the store, running the validators. Only a sync
actually done can claim the curation happened. The hooks add triggers and
back-pressure, nothing more:

- `SessionStart`: a recall reminder; if earlier work is marked `needs_reconcile`, an
  explicit sync is required before trusting its project state.
- `UserPromptSubmit`: marks continuity state `dirty`; writes and classifies nothing.
- `PreCompact`, **manual** trigger: while dirty or `needs_reconcile`, blocks the
  compaction until the agent has synced and run `mark-synced`, then retries.
- `PreCompact`, **automatic** trigger: fail open. It warns and keeps
  `needs_reconcile` for later, and never blocks an automatic compact (that would
  deadlock the session). A missing or unknown trigger fails open the same way.

The hooks do not understand the conversation or update the store. After a real
sync, run the `mark-synced` command the hook prints. It checks that `MEMORY.md`
exists inside the store, is not a symlink and is within the caps, then records the
clean state. It does not run semantic curation, create a note, or modify memory content.

### Installing is not enabling

Built and measured against **Codex CLI 0.144.1**, which is not a minimum version or
a certification. Measured there: hooks did not fire under non-interactive
`codex exec`, and on Windows each `UserPromptSubmit` cost about 1.2–1.4 s, mostly
process startup. Check yours against the
[official hooks documentation](https://learn.chatgpt.com/docs/hooks):

1. **Trust the project and its handlers.** Project hooks run project code: review
   `.codex/hooks.json` and `.codex/engramory/` first. Trust is keyed to content hashes,
   so a reinstall needs it again. If `/hooks` lacks the entry, use explicit sync.
2. **Verify interactive and non-interactive runs separately.** An interactive success
   says nothing about `codex exec`, and `--dangerously-bypass-hook-trust` is no evidence
   an event ran. Until verified, scripted runs rely on explicit sync plus
   `engramory_check.py` / `engramory_doctor.py`.

`UserPromptSubmit` runs on **every** prompt; measure its cost before enabling hooks
for many short turns. The rules, skill, validators and explicit sync work without them.
(The Windows chain `cmd.exe` → `powershell.exe -EncodedCommand` → Python exists for
quoting: `cmd.exe /C` strips outer quotes. Keep it.)

### The generated config is machine-local

`.codex/hooks.json` holds absolute paths to the interpreter, scripts and store, so it
**cannot be shared** across machines or operating systems. The installer git-ignores
it when Engramory is its only owner, and does not when it also holds other handlers. `--hook-python` picks the interpreter to bake in (default: the Python that
ran the installer, wrong if that was a throwaway virtualenv).

The hook keeps `<MEMORY_ROOT>/.engramory-codex-state.json` and an empty
`.engramory-codex-state.lock` beside it; the lock file stays by design (the lock is a
kernel lock on an open descriptor). The state file holds only bookkeeping: session
ids, mode, dirty/synced generations, timestamps, reconcile state, the index hash and
size. Never a prompt, transcript or note body. Deleting it forgets pending syncs, not
memory.

## Chat bridges (one session per message)

Codex never auto-loads Engramory's `MEMORY.md`, so recall is a real file read. In an
editor that is paid once per task; behind a bridge that starts a Codex session per
message, it is paid on every message.

- **A greeting or bare acknowledgement is not a task** (`SKILL.md` §4): no recall, no
  checkpoint. Length never decides it; a one-word reply continuing work is a task.
- **Whether a message starts a session at all is the bridge's call.** A session that
  already began costs what it costs; to keep small talk cheap, the bridge must answer
  it without an agent turn.
- `UserPromptSubmit` has no matcher and runs on every message. Leave the hooks out of a
  bridge install unless you want that.

## Reliability model on Codex

The cap is **best-effort rules + explicit check + doctor**; no Codex pre-write deny
is shipped here. The hooks improve sync timing, not cap enforcement or correctness.
See the [host reliability ladder](../../PORTING.md#4-enforce-the-size-cap--the-degradation-ladder-no-pretooluse-hook).

```sh
python .agents/skills/engramory/tools/engramory_check.py .engramory-memory/MEMORY.md   # after editing the index
python .agents/skills/engramory/tools/engramory_doctor.py .engramory-memory            # now and then
```

Without the skill copy, run the same tools from the Engramory repo.
