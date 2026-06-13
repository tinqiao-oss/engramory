# Installing Engramory

## 1. The skill

Personal (all projects) — copy or symlink the skill folder so `SKILL.md` lands at:

- **Windows:** `%USERPROFILE%\.claude\skills\engramory\SKILL.md`
- **macOS / Linux:** `~/.claude/skills/engramory/SKILL.md`

Project-only — put it at `<project>/.claude/skills/engramory/SKILL.md`.

Symlink keeps this repo as the single source of truth, e.g. on Windows
(PowerShell, admin):

```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.claude\skills\engramory" `
  -Target "<ABSOLUTE_PATH_TO>\engramory"   # the folder that contains SKILL.md
```

Minimal `SKILL.md` frontmatter is just `name` + `description`; both are already
set. Claude reads the `description` to decide when to apply the skill.

## 2. The hard-cap hook (Claude Code only)

The soft 150/200 behavior lives in the skill and the model follows it. The hook
is the *deterministic backstop* that the model cannot skip.

1. Open your settings file (`%USERPROFILE%\.claude\settings.json` for all
   projects, or `.claude/settings.json` for one project).
2. Merge in the `hooks` block from [`settings.snippet.json`](settings.snippet.json).
3. Fix the absolute path to `engramory_index_guard.py`. On Windows, escape
   backslashes (`E:\\engramory\\hooks\\engramory_index_guard.py`) or use forward
   slashes. If the path contains spaces (e.g. under `Program Files`), keep the
   double-quotes around it as shown in the snippet.
4. Make sure `python` is on PATH (or use a full interpreter path, e.g.
   `C:\\Python312\\python.exe E:\\engramory\\hooks\\engramory_index_guard.py`).

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
| `ENGRAMORY_INDEX_NAME` | `MEMORY.md` | which filename counts as the index |
| `ENGRAMORY_INDEX_PATH` | — | absolute path of the one index to guard (use when several `MEMORY.md` files exist; overrides name matching) |

> ⚠️ **If you keep any OTHER file named `MEMORY.md`** (project docs, this repo's own
> `templates/MEMORY.md`, …), set `ENGRAMORY_INDEX_PATH` to the absolute path of your
> real index so the hook only gates that one file. Otherwise a legitimate edit that
> grows the unrelated `MEMORY.md` past the cap is denied (the deny message also
> reminds you of this opt-out).

Requires **Python 3.8+** (the hook and tools use f-strings; `python3` on most
systems).

## 3. Point `<MEMORY_ROOT>` at your memory directory

Tell the agent where memory lives (or reuse the host's native memory directory).
If it's inside a git repo, confirm it is `.gitignore`d — memories often hold
machine-local detail and secrets.

## 4. Other agents (Cursor, Cline, Codex, Windsurf, …)

Paste the body of `SKILL.md` into the agent's rules / system prompt. The skill is
self-contained. The soft 150/200 guard applies via the instructions; the hard
hook is Claude-Code-specific (other hosts have their own hook mechanisms you can
adapt `engramory_index_guard.py` to).
