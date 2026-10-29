# Porting Engramory to other hosts

Engramory is a **discipline, not a storage engine.** It ships no database or
memory store of its own — it imposes structure (one-file-per-fact typed notes + a
pointer-only index) and curation discipline on whatever memory + instruction
mechanism your agent host already has. So "porting" is mostly wiring, not code.

The model doesn't matter (DeepSeek, GPT, Llama, Claude all work). The host needs
two things: a way to keep rules in context, and file read/write. Four steps:

## 1. Make the discipline always-on (not just a by-relevance skill)

A skill that loads "when relevant" won't fire on every task, so "check memory at
the start of a task" is not reliable from a skill alone. Put the short pointer in
the host's **always-loaded** instructions:

| Host | Always-loaded file | Also supports a SKILL.md? |
|---|---|---|
| Claude Code | `CLAUDE.md` / `~/.claude/CLAUDE.md` | yes (Agent Skills) |
| Codex | `AGENTS.md` (`~/.codex/AGENTS.md` or project `AGENTS.md`) | yes (`.agents/skills`) |
| OpenClaw | `AGENTS.md` (in `~/.openclaw/workspace`) | yes (auto-discovers `.agents/skills`) |
| DeepSeek Harness (dsh) | `AGENTS.md` (`$DSH_HOME/AGENTS.md` or project `AGENTS.md`) | yes (skill roots: `$DSH_HOME/skills`, project `.dsh/skills` / `.agents/skills`) |
| Kiro | `.kiro/steering/*.md` with `inclusion: always` (or `AGENTS.md`) | yes (`SKILL.md` as an `inclusion: manual`/`auto` steering file, or a Kiro skill) |
| Hermes (Nous) | `AGENTS.md` / `.hermes.md` (rules) — **not** `SOUL.md` (persona slot) | yes (skills system) |
| Cursor | `.cursor/rules/*.mdc` (`alwaysApply: true`) | yes (auto-discovers `.agents/skills`) |
| Trae | `.trae/rules/project_rules.md` or `AGENTS.md` | yes (`.agents/skills`, enable in settings) |
| Cline / Windsurf | `.clinerules` / `.windsurfrules`, or their rules directories | varies |

Paste [`rules-snippet.md`](rules-snippet.md) into that always-loaded file. If the
host also supports skills, additionally import [`SKILL.md`](SKILL.md) for the full
protocol — the snippet keeps the rules in context; the skill carries the detail.

### Read-only host wiring

The [reader adapter](adapters/reader/README.md) wires a host to an existing store
without making it a writer. Its host-specific destinations and evidence are:

| Host (`<host>-reader`) | Rules file it writes | Verified here? |
|---|---|---|
| `codex-reader` | `AGENTS.md` | dogfooded end-to-end |
| `dsh-reader` | `AGENTS.md` | dogfooded end-to-end |
| `claude-reader` | `CLAUDE.md` | unverified wiring |
| `openclaw-reader` / `hermes-reader` | `AGENTS.md` | unverified wiring |
| `cline-reader` | `.clinerules` | unverified wiring |
| `windsurf-reader` | `.windsurfrules` | unverified wiring |
| `cursor-reader` | `.cursor/rules/engramory-recall.mdc` (`alwaysApply: true`) | unverified wiring |
| `kiro-reader` | `.kiro/steering/engramory-recall.md` (`inclusion: always`) | unverified wiring |

The Codex reader was exercised with `codex exec -s read-only`: it read the index,
opened the relevant note, and returned the fact. A live dsh reader did the same;
its captured model request confirmed the rules were injected. Other rows follow
documented formats but have no host run here; the installer prints that caveat.
Submit real-host evidence before changing their verification status.

If Cline or Windsurf does not pick up the single-file rules, move the generated
block into `.clinerules/*.md` or `.windsurf/rules/*.md` respectively; use Windsurf's
always-on activation mode. Verify the rules load on your installed host.

## 2. Choose one canonical `<MEMORY_ROOT>` — and make Engramory its authority

Use [one writer and many readers](adapters/reader/README.md); do not create a
second handoff store. Reuse an editable host store only when Engramory can be its
authority: for Claude Code, use the auto-memory directory and put the discipline
in `CLAUDE.md` so its writes follow the same protocol.

Keep generated or managed memory separate: Codex native Memories, Letta's memory
blocks, OpenClaw's auto-written store, and Hermes's native `memory`-tool files are
not Engramory stores. On Hermes, leave `~/.hermes/memories/MEMORY.md` and `USER.md`
under the host's manager; use a separate plain-file store with rules in `AGENTS.md`
or `.hermes.md`, not the persona slot `SOUL.md`. The init commands below wire
separate stores for Codex and OpenClaw.

Hermes's native frozen-snapshot files have their own code-enforced size limits,
error back-pressure, and exact-duplicate rejection. They do not implement
Engramory's files-plus-index recall or its typed notes, Why/How, and negative scope.

On Kiro, keep notes outside steering and load only the index through one steering
pointer; follow the [manual layout and ignore-file instructions](adapters/kiro/README.md).

## 3. Wire continuity sync — explicit first, hooks optional

Every host with rules and file access can run the explicit continuity sync in
[`SKILL.md` §5](SKILL.md): curate the canonical store, validate it, and confirm a
cold-started agent could continue before a deliberate compact, clear, or new thread.

Lifecycle hooks only prompt that work; they cannot perform semantic curation.
The [Codex adapter](adapters/codex/README.md) defines the shipped lifecycle contract
and install commands, including `--mode explicit` and optional `--mode assisted`.
For another host, verify event payloads, trust requirements, and blocking behavior
before mapping the contract. Automatic or unknown compaction must fail open with
a warning and retain reconciliation state; otherwise use explicit sync alone.

## 4. Enforce the size cap — the degradation ladder (no PreToolUse hook)

The cap stops the index growing past the host's load window. Strongest → softest:

1. **Pre-write deny:** exactly two implementations here are **written, tested,
   and running**: the [Claude Code hook](hooks/INSTALL.md)
   (`hooks/engramory_index_guard.py`, matching `Edit|Write|MultiEdit`) and the
   [dsh plugin](adapters/dsh/plugin/README.md) (`dsh-engramory >= 0.2.7`). Each
   refuses index growth past a cap that it can measure before the write — whole-file
   writes and edits it can simulate. The dsh plugin cannot simulate an `insert`-style
   partial edit, so on a healthy index such an edit can cross the cap from below; see
   its guide for configuration and simulation limits. dsh compatibility is the `compatible` set in
   [`dsh.compatibility.dshReleases`](adapters/dsh/plugin/package.json), backed by
   [recorded E2E evidence](tests/dsh_e2e/results.json).

   | Host | Pre-write seam | Engramory enforcement here |
   |---|---|---|
   | Claude Code | `PreToolUse` | shipped, tested, running hook |
   | dsh | `ctx.tools.guard()` | shipped, tested, running plugin |
   | Hermes | `pre_tool_call`, matching `write_file\|patch` | rules + check + doctor; no shim |
   | Cursor | `preToolUse` for file edits | rules + check + doctor; no shim |
   | Kiro CLI | `PreToolUse`, `matcher: fs_write`, `exit 2` | rules + check + doctor; no shim |
   | OpenClaw | TypeScript `before_tool_call` plugin, `block: true` | rules + check + doctor; no shim |
   | Codex | no index-deny shim here; lifecycle assistance is separate | rules + check + doctor |
   | Trae | post-write review/undo, no pre-write deny | rules + check + doctor |
   | Other hosts | verify the host's interface | rules + check + doctor where tools are available |

   Hermes, Cursor, OpenClaw, and Kiro CLI are **portable in principle, not written
   or verified here**. Check current official host documentation and demonstrate
   an actual deny on your host before claiming a port works. Kiro IDE and CLI
   interfaces must be checked separately. Hermes's file-write seam does not cover
   its native `memory` tool. Third-party reports worth testing for first (they may
   be fixed by now): Hermes `pre_tool_call` shell hooks not firing in some worker
   contexts (issue #25204); Cursor's hook flaky on Windows; Kiro IDE passing empty
   `toolArgs` (issue #7375, so a path/content deny is CLI-only) and the Kiro CLI hook
   not firing on Windows 11 (issue #8264).

2. **Agent-invoked check (any host with a shell):** after writing the index, run
   `python tools/engramory_check.py <MEMORY.md>` and compact if it says `OVER`.
   Add that instruction to the rules. Hermes / Cursor / Cline / Codex all have
   shell or file tools, so this works — but it's best-effort (the agent must run
   it). Exit code 0/1/2 = OK/WARN/OVER for scripting (64 = usage error, 66 =
   index unreadable — both distinct from a real 0/1/2 result so a caller can tell
   "could not check" from "index is fine").
3. **Model discipline:** SKILL §6 — count lines/bytes before writing the index.
4. **Periodic backstop:** `python tools/engramory_doctor.py <MEMORY_ROOT>` flags
   an over-cap index, broken pointers, and orphan notes — and validates each note's
   frontmatter against the protocol. Add `--no-schema` to skip the frontmatter
   checks and run structure-only (handy on a store that isn't in strict Engramory
   format yet, e.g. a host-native auto-memory store).

**Honest limit.** A seam alone is not a working guard. Only the Claude Code and
dsh implementations above provide deterministic pre-write denial for their
matched tools. **Shell tools, MCP file tools, and external editors bypass every
guard.** All other hosts use best-effort rules + `engramory_check.py` + doctor;
internal host-managed writes cannot be intercepted by an agent-invoked check.
Where file or shell access is unavailable, only model discipline remains.

## Adopting an existing store

Pointing Engramory at a store that predates it (e.g. a host's auto-memory dir with
dozens of notes) fails the strict `doctor` on day one — mostly mechanical gaps
(`created:`/`updated:` absent, Why/How not yet in label form), not real rot. Don't
hand-fix hundreds of issues blind — triage:

1. **Structure first:** `engramory_doctor.py <root> --no-schema` and get the
   structural problems (broken pointers, orphans, duplicate slugs) to zero by hand —
   those genuinely need a human.
2. **Backfill dates mechanically.** There is no migration *tool* for note content
   (by design — `engramory_check` and `engramory_doctor` never write; `init` writes
   only setup files and `sync` only its bookkeeping state), but a one-off stdlib
   snippet fills only the missing
   `created:`/`updated:`. Run it on a copy / clean git, dry-run first, and note that
   **mtime is the file's timestamp, not necessarily the fact's** real last-update:

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
3. **Re-run strict `doctor`** and work the bucketed summary it prints
   (`N missing-why-how, …`). Write the Why/How lines **by hand** — that reflection is
   the whole point of those types and isn't something a script should fabricate.

## Quick port checklist

- [ ] `rules-snippet.md` pasted into the host's always-loaded instructions
- [ ] `SKILL.md` imported as a skill too (if supported)
- [ ] one canonical `<MEMORY_ROOT>` selected; no second handoff store or writer
- [ ] explicit continuity sync wired; lifecycle hooks, if any, documented as assistance only
- [ ] store git-ignored if inside a repo (it holds machine-local detail)
- [ ] size cap wired at the strongest rung the host supports (hook → check → discipline)
- [ ] `engramory_doctor.py` runnable as an occasional backstop

Init helpers (Codex, OpenClaw, dsh) — wire `AGENTS.md` + the skill + a separate store in one go:

```sh
python tools/engramory_init.py codex    --project-root <repo> --install-skill
python tools/engramory_init.py codex    --project-root <repo> --install-skill --install-hooks --mode explicit
python tools/engramory_init.py openclaw                       --install-skill   # -> ~/.openclaw/workspace
python tools/engramory_init.py dsh                            --install-skill   # -> $DSH_HOME (else ~/.dsh)
```

See the [Codex](adapters/codex/README.md),
[OpenClaw](adapters/openclaw/README.md), and [dsh](adapters/dsh/README.md) adapters
for setup and limits; the dsh deterministic guard is installed separately as
[`dsh-engramory >= 0.2.7`](adapters/dsh/plugin/README.md).

Kiro has no init helper yet — wire it manually (one always-on steering file + a
non-steering `.engramory-memory/` store) per
[adapters/kiro/README.md](adapters/kiro/README.md), which also ships a ready-to-copy
[steering template](adapters/kiro/steering-engramory.md).
