# Installing Engramory on Claude Code

Standing rules for recall and curation, optionally the full protocol as a skill, and
a hook that enforces the index cap. Other hosts: [PORTING.md](../PORTING.md).

## 1. Load the discipline as standing rules (primary)

Paste [`rules-snippet.md`](../rules-snippet.md) into Claude Code's always-loaded
rules: `%USERPROFILE%\.claude\CLAUDE.md` on Windows, `~/.claude/CLAUDE.md` on
macOS / Linux, or a project's `CLAUDE.md` for that project only.

## 2. (Optional) Register the full spec as a skill — Claude Code

The rules carry the trigger; [`SKILL.md`](../SKILL.md) is the full protocol. To have
it load on demand as an Agent Skill, copy or symlink this folder so `SKILL.md` lands at:

- **Windows:** `%USERPROFILE%\.claude\skills\engramory\SKILL.md`
- **macOS / Linux:** `~/.claude/skills/engramory/SKILL.md`
- Project-only: `<project>/.claude/skills/engramory/SKILL.md`

A symlink keeps this repo the single source, e.g. on Windows (PowerShell, admin):

```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.claude\skills\engramory" `
  -Target "<ABSOLUTE_PATH_TO>\engramory"   # the folder that contains SKILL.md
```

## 3. The hard-cap hook (deterministic enforcement)

The hook denies growth of the index past its cap through `Edit|Write|MultiEdit`, and
does nothing for any other file. Shell commands, MCP file tools and external editors
bypass it; see [the reliability ladder](../PORTING.md#4-enforce-the-size-cap--the-degradation-ladder-no-pretooluse-hook).

1. Open your settings file: `%USERPROFILE%\.claude\settings.json` (all projects) or
   `.claude/settings.json` (one project).
2. Merge in the `hooks` block from [`settings.snippet.json`](settings.snippet.json).
   It uses the **exec form** (`"command"` = the interpreter, `"args"` = its arguments),
   which Claude Code spawns with **no shell**: the path in `args` needs no quoting or
   escaping, even under `Program Files`.
3. Put the absolute path to `engramory_index_guard.py` in `args`.
4. Set `"command"` to the Python that runs it: `python3` on macOS / Linux, `python` on
   Windows, or, most robust anywhere, the absolute path printed by
   `python -c "import sys; print(sys.executable)"`.

> ⚠️ **Check that the hook really fires.** If the interpreter cannot start (say
> `python3` on a stock Windows, where it may be a Store stub), Claude Code treats that
> as a non-blocking error and lets every write through. Self-test: ask the agent to
> Write a 250-line `MEMORY.md` in a scratch folder. It must be **denied** with the
> Engramory message; delete the folder afterwards. With `ENGRAMORY_INDEX_PATH` set, a
> scratch file is not guarded: append 250 lines to the real index with an Edit instead,
> never rewrite it (on an index already that long a rewrite is a shrink, and passes).

### Hook configuration (environment variables, all optional)

| var | default | meaning |
|---|---|---|
| `ENGRAMORY_HARD` | `200` | hard line ceiling — edits that grow past it are denied |
| `ENGRAMORY_WARN` | `150` | soft line warning — model is nudged to compact |
| `ENGRAMORY_HARD_BYTES` | `25600` | hard byte ceiling (25 KB) — growth past it is denied |
| `ENGRAMORY_WARN_BYTES` | `20480` | soft byte warning (20 KB) |
| `ENGRAMORY_LINE_WARN_BYTES` | `200` | per-line prose budget: an index line longer than this once its link targets are removed is content leaking into the index; the hook nudges (never denies) when an edit adds one, and `engramory_doctor.py` reports existing ones |
| `ENGRAMORY_INDEX_NAME` | `MEMORY.md` | which filename counts as the index |
| `ENGRAMORY_INDEX_PATH` | — | absolute path of the one index to guard; overrides name matching |

> ⚠️ **Any other file named `MEMORY.md`** (project docs, this repo's
> `templates/MEMORY.md`, …) is gated too, unless you set `ENGRAMORY_INDEX_PATH` to your
> real index. The deny message reminds you of this.

Requires **Python 3.9+**.

## 4. Point `<MEMORY_ROOT>` at your memory directory

Use Claude Code's plain-file auto-memory directory and make Engramory its curation
authority; share it with [one writer and read-only readers](../adapters/reader/README.md).
Inside a git repo, git-ignore it: memories hold machine-local detail. Never save secret
values (keys, tokens, passwords); see [`SKILL.md` §5](../SKILL.md).
