# Installing Engramory on Claude Code

Install the standing rules for recall and curation, optionally register the full
protocol as a skill, and add the Claude Code hook for the index cap. The general
setup model and host capabilities live in [PORTING.md](../PORTING.md).

## 1. Load the discipline as standing rules (primary)

Paste [`rules-snippet.md`](../rules-snippet.md) into Claude Code's always-loaded
rules: `%USERPROFILE%\.claude\CLAUDE.md` on Windows, `~/.claude/CLAUDE.md` on
macOS / Linux, or the project's `CLAUDE.md` for project-only use.

## 2. (Optional) Register the full spec as a skill — Claude Code

The standing rules carry the trigger; [`SKILL.md`](../SKILL.md) is the complete
protocol. On Claude Code you can ALSO register it as an Agent Skill so the full
reference loads on demand — copy or symlink the folder so `SKILL.md` lands at:

- **Windows:** `%USERPROFILE%\.claude\skills\engramory\SKILL.md`
- **macOS / Linux:** `~/.claude/skills/engramory/SKILL.md`
- Project-only: `<project>/.claude/skills/engramory/SKILL.md`

Symlink keeps this repo as the single source of truth, e.g. on Windows
(PowerShell, admin):

```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.claude\skills\engramory" `
  -Target "<ABSOLUTE_PATH_TO>\engramory"   # the folder that contains SKILL.md
```

Minimal `SKILL.md` frontmatter is just `name` + `description`; both are already
set. Claude reads the `description` to decide when to load the skill.

## 3. The hard-cap hook (deterministic enforcement)

The hook deterministically denies matched over-cap growth through
`Edit|Write|MultiEdit`; the defaults are in the configuration table below. Shell
commands, MCP file tools, and external editors bypass it. For the two shipped
implementations and other hosts' best-effort limits, see
[the reliability ladder](../PORTING.md#4-enforce-the-size-cap--the-degradation-ladder-no-pretooluse-hook).

1. Open your settings file (`%USERPROFILE%\.claude\settings.json` for all
   projects, or `.claude/settings.json` for one project).
2. Merge in the `hooks` block from [`settings.snippet.json`](settings.snippet.json).
   It uses the **exec form** (`"command"` = the interpreter, `"args"` = its argument
   list): Claude Code spawns it directly with **no shell**, so the script path in `args`
   is passed literally — no backslash-escaping and no quoting, even under `Program Files`
   or on Windows.
3. Put the absolute path to `engramory_index_guard.py` in `args`.
4. Set `"command"` to the Python that should run it:
   - **macOS / Linux:** `python3` (a bare `python` may not exist here).
   - **Windows:** `python`.
   - **Most robust on any OS:** the absolute interpreter path from
     `python -c "import sys; print(sys.executable)"` (e.g. `C:\Python312\python.exe`),
     which sidesteps the `python`-vs-`python3` question entirely.

> ⚠️ **Verify the hook actually fires after installing.** If the interpreter in
> `"command"` cannot be spawned at all — e.g. `python3` on a stock Windows, where
> only `python` exists (or `python3` is a Microsoft Store stub) — Claude Code
> treats it as a *non-blocking* hook error and lets the tool call proceed: the
> guard silently never gates anything. Quick self-test: ask the agent to Write a
> 250-line file named `MEMORY.md` in a scratch folder — the write must be
> **denied** with the Engramory message (by default the hook gates *any* file
> named `MEMORY.md`, so a scratch copy exercises it; delete the folder after).

The hook fires on every `Edit` / `Write` / `MultiEdit`, returns instantly for any
file that isn't the index, and only acts when the target's filename is the index
(default `MEMORY.md`).

### Hook configuration (environment variables, all optional)

| var | default | meaning |
|---|---|---|
| `ENGRAMORY_HARD` | `200` | hard line ceiling — edits that grow past it are denied |
| `ENGRAMORY_WARN` | `150` | soft line warning — model is nudged to compact |
| `ENGRAMORY_HARD_BYTES` | `25600` | hard byte ceiling (25 KB) — growth past it is denied |
| `ENGRAMORY_WARN_BYTES` | `20480` | soft byte warning (20 KB) |
| `ENGRAMORY_LINE_WARN_BYTES` | `200` | per-line prose budget — an index line whose text, with its `](path.md)` targets and `[[wikilinks]]` removed, exceeds this is content leaking into the index; the hook nudges (never denies) when an edit adds one, and `engramory_doctor.py` reports the existing ones |
| `ENGRAMORY_INDEX_NAME` | `MEMORY.md` | which filename counts as the index |
| `ENGRAMORY_INDEX_PATH` | — | absolute path of the one index to guard (use when several `MEMORY.md` files exist; overrides name matching) |

> ⚠️ **If you keep any OTHER file named `MEMORY.md`** (project docs, this repo's own
> `templates/MEMORY.md`, …), set `ENGRAMORY_INDEX_PATH` to the absolute path of your
> real index so the hook only gates that one file. Otherwise a legitimate edit that
> grows the unrelated `MEMORY.md` past the cap is denied (the deny message also
> reminds you of this opt-out).

Requires **Python 3.9+** (for the hook and the `tools/` scripts; `python3` on most
systems).

## 4. Point `<MEMORY_ROOT>` at your memory directory

Point `<MEMORY_ROOT>` at Claude Code's plain-file auto-memory directory and make
Engramory its curation authority. Use [one writer with read-only readers](../adapters/reader/README.md)
when sharing it. If the store is inside a git repo, confirm it is `.gitignore`d:
memories may hold machine-local detail. Never save secret values (keys, tokens,
passwords); see [`SKILL.md` §5](../SKILL.md).

## 5. Other hosts

Use [PORTING.md](../PORTING.md) for host capabilities and the degradation ladder,
and the [Codex](../adapters/codex/README.md),
[dsh](../adapters/dsh/plugin/README.md), [OpenClaw](../adapters/openclaw/README.md), or
[Kiro](../adapters/kiro/README.md) guide for setup. Codex lifecycle assistance is
configured and verified separately in its adapter; it does not enforce the cap.
Read-only access to another agent's store uses the
[reader adapter](../adapters/reader/README.md).
