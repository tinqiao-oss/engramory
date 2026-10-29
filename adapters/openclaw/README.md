# OpenClaw adapter

[OpenClaw](https://docs.openclaw.ai) is a self-hosted, model-agnostic agent host. It
loads `AGENTS.md` from its workspace at the start of every session and auto-discovers
Agent Skills from `.agents/skills` — the two rails Engramory needs. Run the discipline
as a plain, user-auditable memory store plus OpenClaw standing instructions. Keep that
store **separate** from OpenClaw's own memory (it auto-writes daily logs under
`memory/YYYY-MM-DD.md` and an optional curated `MEMORY.md`); don't try to make Engramory
the authority over OpenClaw's managed memory.

## Quick start

From the Engramory repo. The installer defaults to the **base-profile** workspace
`~/.openclaw/workspace`; OpenClaw can also select a workspace by profile,
`OPENCLAW_WORKSPACE_DIR`, or per-agent config, so pass `--project-root` explicitly
if yours is not the base one:

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

The cap is **best-effort rules + explicit check + doctor**; no OpenClaw deny
plugin is shipped or verified here. Its `before_tool_call` seam would need its
own implementation, not the Claude Code Python hook. The two running guards
(Claude Code and `dsh-engramory >= 0.2.7`) and porting requirements are documented
in [PORTING.md](../../PORTING.md); dsh's exact compatibility record is in
[`dsh.compatibility.dshReleases`](../dsh/plugin/package.json).

## Commands the agent can run

After editing the index, run the check and compact if it reports `OVER`:

```sh
python .agents/skills/engramory/tools/engramory_check.py .engramory-memory/MEMORY.md
```

Occasional full health check:

```sh
python .agents/skills/engramory/tools/engramory_doctor.py .engramory-memory
```

If you did not install the skill copy, run the same tools from wherever the Engramory
repo lives.
