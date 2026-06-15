# Porting Engramory to other hosts

Engramory is a **discipline, not a storage engine.** It ships no database or
memory store of its own — it imposes structure (atomic, typed notes + a
pointer-only index) and curation discipline on whatever memory + instruction
mechanism your agent host already has. So "porting" is mostly wiring, not code.

The model doesn't matter (DeepSeek, GPT, Llama, Claude all work). The host needs
two things: a way to keep rules in context, and file read/write. Three steps:

## 1. Make the discipline always-on (not just a by-relevance skill)

A skill that loads "when relevant" won't fire on every task, so "check memory at
the start of a task" is not reliable from a skill alone. Put the short pointer in
the host's **always-loaded** instructions:

| Host | Always-loaded file | Also supports a SKILL.md? |
|---|---|---|
| Claude Code | `CLAUDE.md` / `~/.claude/CLAUDE.md` | yes (Agent Skills) |
| Codex | `AGENTS.md` (`~/.codex/AGENTS.md` or project `AGENTS.md`) | yes (`.agents/skills`) |
| OpenClaw | `AGENTS.md` (in `~/.openclaw/workspace`) | yes (auto-discovers `.agents/skills`) |
| Hermes (Nous) | `SOUL.md` / project context files | yes (agentskills.io standard) |
| Cursor | `.cursor/rules/*.mdc` (`alwaysApply: true`) | yes (auto-discovers `.agents/skills`) |
| Trae | `.trae/rules/project_rules.md` or `AGENTS.md` | yes (`.agents/skills`, enable in settings) |
| Cline / Windsurf | their rules / system-prompt file | varies |

Paste [`rules-snippet.md`](rules-snippet.md) into that always-loaded file. If the
host also supports skills, additionally import [`SKILL.md`](SKILL.md) for the full
protocol — the always-loaded snippet guarantees the behaviour fires; the skill
carries the detail.

## 2. Point `<MEMORY_ROOT>` at the host's own store — and make Engramory its authority

Don't create a second store. Reuse the memory directory the host already loads:
- Claude Code → its auto-memory dir (the `MEMORY.md` it injects each session).
- Hermes → its `MEMORY.md` / memory location.

⚠️ Hosts that **auto-write** their memory (Claude, Hermes) have their own house
style, which fights Engramory's structure (one-file-one-fact, pointer-only index,
four types). Resolve it by making Engramory's rules the **authority** for that
store — put the SKILL / snippet where it shapes how the host writes memory
(`SOUL.md` / context / `CLAUDE.md`), so one store follows one set of rules instead
of two writers fighting in the same file.

⚠️ But some hosts treat their memory as **generated / managed state not meant for
hand-editing** (Letta's memory blocks; OpenAI Codex's local Memories). You cannot
make Engramory the authority over a store like that — there is no agent-visible
file to curate, and editing it fights the host's manager. There, apply the
discipline via the host's **rules** (`AGENTS.md`, etc.) and keep the Engramory
store **separate** (a plain folder you control); don't try to take over the managed
store. For Codex, `tools/engramory_init.py codex --project-root <repo>
--install-skill` performs that wiring and points `AGENTS.md` at the separate
store.

## 3. Enforce the size cap — the degradation ladder (no PreToolUse hook)

The cap stops the index growing past the host's load window. Strongest → softest:

1. **Pre-write deny hook:** `hooks/engramory_index_guard.py` runs on every edit and
   can DENY one that would grow the index past the cap — deterministic. It's written
   for **Claude Code's** hook format. Other hosts' pre-write deny mechanisms vary and
   are **not interchangeable**, so each needs its own shim:
   - **Hermes** — a `pre_tool_call` shell hook (matcher `write_file|patch`) can block.
   - **Cursor** — a generic `preToolUse` hook can deny `Edit|Write` (newer, and
     reported flaky on Windows in 2026 — verify before relying on it).
   - **OpenClaw** — blocks via a `before_tool_call` *plugin* (TypeScript, `block: true`),
     **not** a shell hook, so the Python guard does not drop in.
   - **Trae** — has **no** pre-write deny (only post-write review/undo), so the cap
     can't be deterministic there; use rung 2.

   So the cap is portable *in principle* on hosts with a real pre-write deny — but
   **only the Claude Code hook here is written and tested**; for the others you write
   and verify the shim yourself. See `hooks/INSTALL.md`.
2. **Agent-invoked check (any host with a shell):** after writing the index, run
   `python tools/engramory_check.py <MEMORY.md>` and compact if it says `OVER`.
   Add that instruction to the rules. Hermes / Cursor / Cline / Codex all have
   shell or file tools, so this works — but it's best-effort (the agent must run
   it). Exit code 0/1/2 = OK/WARN/OVER for scripting (64 = usage error, 66 =
   index unreadable — both distinct from a real 0/1/2 result so a caller can tell
   "could not check" from "index is fine").
3. **Model discipline:** SKILL §6 — count lines/bytes before writing the index.
4. **Periodic backstop:** `python tools/engramory_doctor.py <MEMORY_ROOT>` flags
   an over-cap index, broken pointers, and orphan notes — and validates each note's
   frontmatter against the protocol. Add `--no-schema` to skip the frontmatter
   checks and run structure-only (handy on a store that isn't in strict Engramory
   format yet, e.g. a host-native auto-memory store).

**Honest limit.** A *deterministic* guarantee is shipped and tested only for the
host whose adapter lives in this repo — today **Claude Code**
(`hooks/engramory_index_guard.py`). The same pattern ports to hosts with a real
pre-write deny (Hermes and Cursor; OpenClaw only via a TypeScript `before_tool_call`
plugin), but those shims are not written or verified here — portable in principle,
build and verify your own. Hosts with no pre-write deny at all (e.g. Trae) get rung 2. If a host writes its memory
**internally** — not through a tool that an agent step or hook can see (e.g. Letta)
— even the step-2 check can't intercept that write; there the cap is pure
discipline. So the cap is deterministic on the handful of hosts with such a hook,
and best-effort discipline everywhere else. This is why Engramory is 0.1 /
experimental: set expectations accordingly and don't sell the cap as guaranteed on
a host without a pre-write deny hook.

## Adopting an existing store

Pointing Engramory at a store that predates it (e.g. a host's auto-memory dir with
dozens of notes) fails the strict `doctor` on day one — mostly mechanical gaps
(`created:`/`updated:` absent, Why/How not yet in label form), not real rot. Don't
hand-fix hundreds of issues blind — triage:

1. **Structure first:** `engramory_doctor.py <root> --no-schema` and get the
   structural problems (broken pointers, orphans, duplicate slugs) to zero by hand —
   those genuinely need a human.
2. **Backfill dates mechanically.** There is no migration *tool* (by design — `tools/`
   are read-only validators), but a one-off stdlib snippet fills only the missing
   `created:`/`updated:`. Run it on a copy / clean git, dry-run first, and note that
   **mtime is the file's timestamp, not necessarily the fact's** real last-update:

   ```python
   import os, re, datetime, glob
   for p in glob.glob("<root>/*.md"):
       if os.path.basename(p) == "MEMORY.md":
           continue
       t = open(p, encoding="utf-8").read()
       if not t.startswith("---"):
           continue
       end = t.find("\n---", 3)                 # end of the frontmatter block
       fm = t[:end]
       d = datetime.date.fromtimestamp(os.path.getmtime(p)).isoformat()
       add = "".join(f"\n{k}: {d}" for k in ("created", "updated")
                     if not re.search(rf"(?m)^{k}:", fm))
       if add:
           print(p, "->", add.replace(chr(10), " "))   # dry-run: review first
           # open(p, "w", encoding="utf-8").write(fm + add + t[end:])
   ```
3. **Re-run strict `doctor`** and work the bucketed summary it prints
   (`N missing-why-how, …`). Write the Why/How lines **by hand** — that reflection is
   the whole point of those types and isn't something a script should fabricate.

## Quick port checklist

- [ ] `rules-snippet.md` pasted into the host's always-loaded instructions
- [ ] `SKILL.md` imported as a skill too (if supported)
- [ ] `<MEMORY_ROOT>` set to the host's own memory dir; Engramory made its authority
- [ ] store git-ignored if inside a repo (it holds machine-local detail)
- [ ] size cap wired at the strongest rung the host supports (hook → check → discipline)
- [ ] `engramory_doctor.py` runnable as an occasional backstop

Init helpers (Codex, OpenClaw) — wire `AGENTS.md` + the skill + a separate store in one go:

```sh
python tools/engramory_init.py codex    --project-root <repo> --install-skill
python tools/engramory_init.py openclaw                       --install-skill   # -> ~/.openclaw/workspace
```

See [adapters/codex/README.md](adapters/codex/README.md) and
[adapters/openclaw/README.md](adapters/openclaw/README.md) for the exact behavior and
limitations (both enforce the cap by rules + `engramory_check.py`, not a deterministic
hook).
