# Porting Engramory to other hosts

Engramory ships no database: it puts structure (one typed note per fact, a
pointer-only index) and curation rules on top of the files and standing
instructions a host already has, so porting is mostly wiring. Any model works; the
host needs a way to keep rules in context and file read/write.

## 1. Make the discipline always-on (not just a by-relevance skill)

A skill loaded "when relevant" does not fire on every task, so put the short rules
in the host's **always-loaded** instructions:

| Host | Always-loaded file | Also supports a SKILL.md? |
|---|---|---|
| Claude Code | `CLAUDE.md` / `~/.claude/CLAUDE.md` | yes (Agent Skills) |
| Codex | `AGENTS.md` (`~/.codex/AGENTS.md` or project `AGENTS.md`) | yes (`.agents/skills`) |
| OpenClaw | `AGENTS.md` (in `~/.openclaw/workspace`) | yes (auto-discovers `.agents/skills`) |
| DeepSeek Harness (dsh) | `AGENTS.md` (`$DSH_HOME/AGENTS.md` or project `AGENTS.md`) | yes (skill roots: `$DSH_HOME/skills`, project `.dsh/skills` / `.agents/skills`) |
| Hermes (Nous) | `AGENTS.md` / `.hermes.md` (rules) — **not** `SOUL.md` (persona slot) | yes (skills system) |
| Cursor | `.cursor/rules/*.mdc` (`alwaysApply: true`) | yes (auto-discovers `.agents/skills`) |
| Trae | `.trae/rules/project_rules.md` or `AGENTS.md` | yes (`.agents/skills`, enable in settings) |
| Cline / Windsurf | `.clinerules` / `.windsurfrules`, or their rules directories | varies |

Paste [`rules-snippet.md`](rules-snippet.md) into that file. If the host supports
skills, also import [`SKILL.md`](SKILL.md): the snippet keeps the rules in context,
the skill carries the detail. (On dsh, the [plugin](adapters/dsh/plugin/README.en.md)
does both.)

### Read-only host wiring

The [reader adapter](adapters/reader/README.md) lets a host recall an existing store
without becoming a writer:

| Host (`<host>-reader`) | Rules file it writes | Verified here? |
|---|---|---|
| `codex-reader` | `AGENTS.md` | dogfooded end-to-end |
| `dsh-reader` | `AGENTS.md` | dogfooded end-to-end |
| `claude-reader` | `CLAUDE.md` | dogfooded end-to-end |
| `openclaw-reader` / `hermes-reader` | `AGENTS.md` | unverified wiring |
| `cline-reader` | `.clinerules` | unverified wiring |
| `windsurf-reader` | `.windsurfrules` | unverified wiring |
| `cursor-reader` | `.cursor/rules/engramory-recall.mdc` (`alwaysApply: true`) | unverified wiring |

"Dogfooded" means a real host read the index, opened the right note and answered
from it. The other rows follow each host's documented format but have not run here;
change a row's status only with real-host evidence. If Cline or Windsurf ignores the
single-file rules, move the block into `.clinerules/*.md` or `.windsurf/rules/*.md`
(Windsurf: always-on activation).

## 2. Choose one canonical `<MEMORY_ROOT>` — and make Engramory its authority

One writer, many readers ([why](adapters/reader/README.md)); no second handoff store.
Reuse a host's own store only if it is plain editable files that Engramory can
govern: on Claude Code, the auto-memory directory with the rules in `CLAUDE.md`.

Keep host-managed memory separate: Codex native Memories, Letta memory blocks,
OpenClaw's auto-written store, and Hermes's `memory`-tool files
(`~/.hermes/memories/MEMORY.md`, `USER.md`) are not Engramory stores. On Hermes, use a
separate store with the rules in `AGENTS.md` or `.hermes.md`.

## 3. Wire continuity sync — explicit first, hooks optional

Any host with rules and file access can run the continuity sync in
[`SKILL.md` §5](SKILL.md) before a deliberate compact, clear, or new thread: curate
the store, validate it, and confirm a cold-started agent could continue.

## 4. Enforce the size cap — the degradation ladder (no PreToolUse hook)

The cap keeps the index inside the host's load window. Strongest first:

1. **Pre-write deny.** Two implementations are written, tested and running here: the
   [Claude Code hook](hooks/INSTALL.md) (`hooks/engramory_index_guard.py`, matching
   `Edit|Write|MultiEdit`) and the [dsh plugin](adapters/dsh/plugin/README.en.md)
   (`dsh-engramory >= 0.2.7`, compatible releases in
   [`dshReleases`](adapters/dsh/plugin/package.json), backed by
   [E2E records](tests/dsh_e2e/results.json)). Both refuse growth past a cap they can
   measure before the write; the dsh plugin cannot simulate an `insert`-style edit,
   which on a healthy index can cross the cap.

   | Host | Pre-write seam | Engramory enforcement here |
   |---|---|---|
   | Claude Code | `PreToolUse` | shipped, tested, running hook |
   | dsh | `ctx.tools.guard()` | shipped, tested, running plugin |
   | Hermes | `pre_tool_call`, matching `write_file\|patch` | rules + check + doctor; no shim |
   | Cursor | `preToolUse` for file edits | rules + check + doctor; no shim |
   | OpenClaw | TypeScript `before_tool_call` plugin, `block: true` | rules + check + doctor; no shim |
   | Codex | no index-deny shim here | rules + check + doctor |
   | Trae | post-write review/undo, no pre-write deny | rules + check + doctor |
   | Other hosts | verify the host's interface | rules + check + doctor where tools are available |

   The "no shim" hosts are **portable in principle, not written or verified here**.
   Demonstrate a real deny on your host before claiming a port works.

2. **Agent-invoked check** (any host with a shell): after writing the index, run
   `python tools/engramory_check.py <MEMORY.md>` and compact on `OVER`. Put that in
   the rules; it is best-effort, since the agent must run it. Exit codes:
   0/1/2 = OK/WARN/OVER, 64 = usage error, 66 = index unreadable.
3. **Model discipline:** SKILL §6, count lines/bytes before writing the index.
4. **Periodic backstop:** `python tools/engramory_doctor.py <MEMORY_ROOT>` flags an
   over-cap index, broken pointers, orphan notes and frontmatter errors
   (`--no-schema` checks structure only).

**Honest limit.** A seam is not a guard: only the Claude Code and dsh
implementations deny before the write, and only for their matched tools. **Shell
tools, MCP file tools, and external editors bypass every guard.** Everything else is
best-effort, and host-internal writes cannot be caught by an agent-run check.

## Adopting an existing store

A store that predates Engramory (a host's auto-memory directory, say) usually fails
the strict `doctor` on day one, mostly on mechanical gaps such as missing dates or
Why/How not in label form. Triage instead of hand-fixing blind:

1. **Structure first:** run `engramory_doctor.py <root> --no-schema` and fix broken
   pointers, orphans and duplicate slugs by hand.
2. **Backfill dates.** No tool rewrites note content (by design), but this one-off
   stdlib snippet fills only missing `created:`/`updated:`. Run it on a copy or a clean
   git tree, dry-run first, and remember **mtime is the file's date, not necessarily
   the fact's**:

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
3. **Re-run strict `doctor`** and work through its bucketed summary. Write the
   Why/How lines **by hand**: that reflection is the point, not something to script.

## Quick port checklist

- [ ] `rules-snippet.md` in the host's always-loaded instructions
- [ ] `SKILL.md` imported as a skill too (if supported)
- [ ] one canonical `<MEMORY_ROOT>`; no second handoff store or writer
- [ ] continuity sync wired
- [ ] store git-ignored if inside a repo (it holds machine-local detail)
- [ ] size cap at the strongest rung the host supports (hook → check → discipline)
- [ ] `engramory_doctor.py` runnable as an occasional backstop

Init helpers wire `AGENTS.md`, the skill and a separate store in one go:

```sh
python tools/engramory_init.py codex    --project-root <repo> --install-skill
python tools/engramory_init.py openclaw                       --install-skill   # -> ~/.openclaw/workspace
python tools/engramory_init.py dsh                            --install-skill   # -> $DSH_HOME (else ~/.dsh)
```

Setup and limits per host: [Codex](adapters/codex/README.md),
[OpenClaw](adapters/openclaw/README.md), [dsh plugin](adapters/dsh/plugin/README.en.md)
(the dsh guard is the plugin, `dsh-engramory >= 0.2.7`).
