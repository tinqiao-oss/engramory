# Installing Engramory

Engramory is a memory **protocol**, not a skill — its discipline must fire on
*every* task, so it loads primarily as **standing rules**, with `SKILL.md` as the
full reference (optionally registered as a skill) and a hook for the hard cap.

## 1. Load the discipline as standing rules (primary)

Paste [`rules-snippet.md`](../rules-snippet.md) into your host's **always-loaded**
rules so the protocol applies on every task (not just when a skill happens to load
by relevance):

- **Claude Code:** `%USERPROFILE%\.claude\CLAUDE.md` (Windows) / `~/.claude/CLAUDE.md`
  (macOS / Linux) for all projects, or the project's `CLAUDE.md`.
- **Codex:** `AGENTS.md` (global `~/.codex/AGENTS.md` or per-project).
- **Cursor / Cline / Windsurf:** `.cursor/rules` / `.clinerules` / `.windsurfrules`.

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

The standing rules' 150/200 behavior is model-followed; the hook is the
*deterministic backstop* the model cannot skip. It's written and tested for Claude
Code only; Cursor, Cline, Codex, and Windsurf expose equivalent pre-write deny hooks
you can adapt the I/O shim to (coverage varies by host and version — you verify it).

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

Requires **Python 3.9+** (the hook and tools use f-strings; `python3` on most
systems).

## 4. Point `<MEMORY_ROOT>` at your memory directory

Tell the agent where memory lives (or reuse the host's native memory directory).
If it's inside a git repo, confirm it is `.gitignore`d — memories often hold
machine-local detail (server IPs, ssh paths, serial numbers). Never write a
secret's *value* into memory at all (keys, tokens, passwords) — see SKILL.md §5.

## 5. Other agents (Cursor, Cline, Codex, Windsurf, …)

Step 1 already covers them: paste [`rules-snippet.md`](../rules-snippet.md) (or the
body of [`SKILL.md`](../SKILL.md)) into the agent's always-loaded rules. The
150/200 guard then applies via the instructions; for the deterministic cap, adapt
the hook to the host's pre-write deny hook or run `tools/engramory_check.py` after
each index write. Full per-host wiring is in [PORTING.md](../PORTING.md).
