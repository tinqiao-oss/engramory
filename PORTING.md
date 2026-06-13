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
| Hermes (Nous) | `SOUL.md` / project context files | yes (agentskills.io standard) |
| Cursor | `.cursor/rules` (`.cursorrules`) | partial |
| Cline / Codex / Windsurf | their rules / system-prompt file | varies |

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

## 3. Enforce the size cap — the degradation ladder (no PreToolUse hook)

The cap stops the index growing past the host's load window. Strongest → softest:

1. **Pre-write deny hook:** `hooks/engramory_index_guard.py` runs on every edit and
   can DENY one that would grow the index past the cap — deterministic. It's written
   for Claude Code's hook format, but Cursor and Cline (and, less maturely, Codex and
   Windsurf) now expose equivalent pre-write deny hooks, so the cap ports — rewrite
   the small JSON I/O shim per host. See `hooks/INSTALL.md`.
2. **Agent-invoked check (any host with a shell):** after writing the index, run
   `python tools/engramory_check.py <MEMORY.md>` and compact if it says `OVER`.
   Add that instruction to the rules. Hermes / Cursor / Cline / Codex all have
   shell or file tools, so this works — but it's best-effort (the agent must run
   it). Exit code 0/1/2 = OK/WARN/OVER for scripting (64 = usage error, 66 =
   index unreadable — both distinct from a real 0/1/2 result so a caller can tell
   "could not check" from "index is fine").
3. **Model discipline:** SKILL §6 — count lines/bytes before writing the index.
4. **Periodic backstop:** `python tools/engramory_doctor.py <MEMORY_ROOT>` flags
   an over-cap index, broken pointers, and orphan notes even when per-write checks
   were missed.

**Honest limit.** A *deterministic* guarantee exists only where a real pre-write
deny hook runs — today that is Claude Code, Cursor, and Cline (Codex and Windsurf
are newer / partial), each needing its own I/O shim. If a host writes its memory
**internally** — not through a tool that an agent step or hook can see (e.g. Letta)
— even the step-2 check can't intercept that write; there the cap is pure
discipline. So the cap is deterministic on the handful of hosts with such a hook,
and best-effort discipline everywhere else. This is why Engramory is 0.1 /
experimental: set expectations accordingly and don't sell the cap as guaranteed on
a host without a pre-write deny hook.

## Quick port checklist

- [ ] `rules-snippet.md` pasted into the host's always-loaded instructions
- [ ] `SKILL.md` imported as a skill too (if supported)
- [ ] `<MEMORY_ROOT>` set to the host's own memory dir; Engramory made its authority
- [ ] store git-ignored if inside a repo (it holds machine-local detail)
- [ ] size cap wired at the strongest rung the host supports (hook → check → discipline)
- [ ] `engramory_doctor.py` runnable as an occasional backstop
