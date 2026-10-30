# OpenClaw adapter

[OpenClaw](https://docs.openclaw.ai) loads its workspace's `AGENTS.md` every session
and auto-discovers skills from `.agents/skills` (and `~/.agents/skills`), which is all
Engramory needs. Keep the Engramory store **separate** from OpenClaw's own memory (its
daily `memory/YYYY-MM-DD.md` logs and optional `MEMORY.md`).

## Quick start

From the Engramory repo:

```sh
python tools/engramory_init.py openclaw --install-skill
```

The default is the base-profile workspace `~/.openclaw/workspace`. If yours is chosen
by profile, `OPENCLAW_WORKSPACE_DIR` or per-agent config, pass `--project-root`; use
`--memory-root` for another store folder. Under the workspace this creates or updates:

- `.engramory-memory/MEMORY.md` (never overwritten if it exists)
- `AGENTS.md`: only the marked Engramory block is replaced
- `.gitignore`, when the store is inside the workspace
- `.agents/skills/engramory/`, with `--install-skill` (an existing copy is kept unless
  you pass `--force`)

## Reliability model on OpenClaw

The cap is **best-effort rules + explicit check + doctor**; no OpenClaw deny plugin is
shipped or verified here (its `before_tool_call` seam would need its own
implementation). See [PORTING.md](../../PORTING.md).

```sh
python .agents/skills/engramory/tools/engramory_check.py .engramory-memory/MEMORY.md   # after editing the index; compact on OVER
python .agents/skills/engramory/tools/engramory_doctor.py .engramory-memory            # now and then
```

Without the skill copy, run the same tools from the Engramory repo.
