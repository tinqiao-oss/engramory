# Codex adapter

Engramory can run on Codex as a plain, user-auditable memory store plus Codex
standing instructions. Do not point Engramory at Codex native Memories: those are
generated state under Codex's own manager. Use a separate folder that you control.

## Quick start

From the Engramory repo:

```sh
python tools/engramory_init.py codex --project-root /path/to/project --install-skill
```

On Windows PowerShell:

```powershell
python tools\engramory_init.py codex --project-root E:\path\to\project --install-skill
```

This creates or updates:

- `<project>/.engramory-memory/MEMORY.md`
- `<project>/AGENTS.md`, with one marked Engramory block
- `<project>/.gitignore`, when the memory folder is inside the project
- `<project>/.agents/skills/engramory/`, when `--install-skill` is passed

The command is intentionally conservative. It does not overwrite an existing
`MEMORY.md`. It only replaces the marked Engramory block in `AGENTS.md`. If an
Engramory skill copy already exists, it is kept unless you pass `--force`.

## Use an existing memory folder

```sh
python tools/engramory_init.py codex \
  --project-root /path/to/project \
  --memory-root /path/to/my-memory \
  --install-skill
```

If `--memory-root` is relative, it is resolved under `--project-root`. If it is
outside the project, the init command does not add a `.gitignore` entry.

## Reliability model on Codex

The Codex adapter uses three layers:

1. `AGENTS.md` makes the recall/write discipline visible at the start of each
   Codex run.
2. `.agents/skills/engramory/SKILL.md` gives Codex the full protocol on demand.
3. `tools/engramory_check.py` and `tools/engramory_doctor.py` are the portable
   backstops for index size and store health.

This is useful, but not a hard global write guard. The Claude Code
`PreToolUse` hook in `hooks/` is not a Codex hook. Until a Codex-specific
pre-write hook shim is written and tested, the index cap on Codex is enforced by
rules plus explicit checks, not by a deterministic deny hook.

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
