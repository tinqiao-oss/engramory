# OpenClaw adapter

[OpenClaw](https://docs.openclaw.ai) is a self-hosted, model-agnostic agent host. It
loads `AGENTS.md` from its workspace at the start of every session and auto-discovers
Agent Skills from `.agents/skills` — the two rails Engramory needs. Run the discipline
as a plain, user-auditable memory store plus OpenClaw standing instructions. Keep that
store **separate** from OpenClaw's own memory (it auto-writes daily logs under
`memory/YYYY-MM-DD.md` and an optional curated `MEMORY.md`); don't try to make Engramory
the authority over OpenClaw's managed memory.

## Quick start

From the Engramory repo (defaults to the OpenClaw workspace `~/.openclaw/workspace`):

```sh
python tools/engramory_init.py openclaw --install-skill
```

Windows PowerShell:

```powershell
python tools\engramory_init.py openclaw --install-skill
```

This creates or updates, under the workspace:

- `<workspace>/.engramory-memory/MEMORY.md` (the curated Engramory store)
- `<workspace>/AGENTS.md`, with one marked Engramory block
- `<workspace>/.gitignore`, when the memory folder is inside the workspace
- `<workspace>/.agents/skills/engramory/`, when `--install-skill` is passed

Use a different workspace or memory folder with `--project-root` / `--memory-root`. The
command is conservative: it never overwrites an existing `MEMORY.md`, only replaces the
marked Engramory block in `AGENTS.md`, and keeps an existing skill copy unless you pass
`--force`.

## How OpenClaw picks this up

- **Standing rules (always-on):** `AGENTS.md` is loaded at the start of every session —
  the marked block carries the recall/write discipline (`rules-snippet.md`).
- **Full protocol on demand:** OpenClaw auto-discovers skills from `<workspace>/.agents/skills`
  and `~/.agents/skills` (the Agent Skills open standard), so the installed
  `.agents/skills/engramory/SKILL.md` loads by relevance — no manual registration.

## Reliability model on OpenClaw

The index-size cap on OpenClaw is **rules + an explicit check**, not a deterministic
deny hook:

1. `AGENTS.md` makes the discipline visible every session.
2. `.agents/skills/engramory/SKILL.md` gives the full protocol on demand.
3. After editing the index, run
   `python .agents/skills/engramory/tools/engramory_check.py .engramory-memory/MEMORY.md`
   and compact if it reports `OVER`; `engramory_doctor.py` is the occasional full
   health check.

> **Why no deterministic cap here yet.** Engramory's hard cap
> (`hooks/engramory_index_guard.py`) is a **Claude-Code-format Python shell hook**.
> OpenClaw's pre-write deny mechanism is a **`before_tool_call` *plugin* hook**
> (TypeScript, returns `block: true`) — a different interface, so the Python hook does
> **not** drop in. A real deterministic cap on OpenClaw would mean writing a
> `before_tool_call` plugin that runs the same line/byte check and blocks the write.
> That plugin is **not shipped or verified here** — until it is, treat the OpenClaw cap
> as best-effort (rules + `engramory_check.py`). This matches Engramory's honesty rule:
> the deterministic guarantee is only claimed where it's actually written and tested
> (today, Claude Code).

## Commands the agent can run

After editing the index:

```sh
python .agents/skills/engramory/tools/engramory_check.py .engramory-memory/MEMORY.md
```

Occasional full health check:

```sh
python .agents/skills/engramory/tools/engramory_doctor.py .engramory-memory
```

If you did not install the skill copy, run the same tools from wherever the Engramory
repo lives.
