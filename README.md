**English** | [简体中文](README.zh-CN.md)

# Engramory

[![CI](https://github.com/tinqiao-oss/engramory/actions/workflows/test.yml/badge.svg)](https://github.com/tinqiao-oss/engramory/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-blue.svg)](https://www.python.org/)

**An opinionated, zero-infrastructure memory *protocol* for small-scale, local,
file-based agent memory** — a strict curation discipline plus a validator
(`tools/engramory_doctor.py`), loaded as **standing rules** (`CLAUDE.md` /
`AGENTS.md` / your host's rules file). It is not a database, a framework, or a
relevance-loaded skill. Memory is a folder of small, human-readable markdown files
plus one always-loaded index. No database, no embeddings, no server — just
plain-text files you can open, read, edit, and diff in any editor (the live store
itself stays git-ignored).

> *Engramory* — coined from *engram* (the physical trace a memory leaves in the
> brain) + *memory*. Here: one file = one fact.

> ⚠️ **Unrelated projects share this name.** *engram + memory* is an obvious
> coinage and at least one other repository arrived at it independently. This
> project is only ever `tinqiao-oss/engramory` (npm: `dsh-engramory`); a same-named
> repo under a different owner is not a fork, a mirror, or a newer version of it.

> 🤖 **Are you an AI agent, asked to install or check this?** Start at
> **[AGENT-SETUP.md](AGENT-SETUP.md)**, not at the install steps below. It is the
> procedure for working out what your host can actually enforce, whether a store
> already exists, what you must not touch, and what to tell the user — the parts
> agents reliably get wrong when improvising.

> **Status: 0.10.0 — experimental.** The hard index cap (a `PreToolUse` hook) is
> deterministic for the matched direct-edit tools (`Edit | Write | MultiEdit`) but
> NOT a global write guard (shell tools — Bash, PowerShell, a background Monitor
> command — plus MCP file tools, external editors, and sync clients bypass it);
> the discipline loads as standing rules the model follows, so it's
> best-effort, not guaranteed on every task (see [SKILL.md](SKILL.md) §8). Assumes a
> single writer / serialized writes. Don't rely on it as a "mandatory, reliable,
> cross-agent" memory layer yet.

---

## What this is — and is NOT

Engramory is **not a new memory architecture**. The "markdown files + a small index
loaded into context + the model curates it" pattern is now the mainstream shape
for agent memory, and it ships in several places already. Engramory stands on:

- **Claude Code native auto-memory** — the same markdown-`MEMORY.md`-index +
  lazy detail-file pattern; its system prompt even uses the same
  `user | feedback | project | reference` type vocabulary (per
  [anthropics/claude-code#58840](https://github.com/anthropics/claude-code/issues/58840);
  the *public docs* describe only the index + topic files). Engramory is a
  disciplined superset of this default.
- **[basic-memory](https://github.com/basicmachines-co/basic-memory)** — markdown
  source-of-truth, YAML frontmatter `type`, `[[wikilink]]` graph, local-first.
- **[obsidian-second-brain](https://github.com/eugeniughelbur/obsidian-second-brain)**,
  **[claude-memory-compiler](https://github.com/coleam00/claude-memory-compiler)**
  ("a loaded index beats vector search at personal scale"), and the broader family
  of markdown-memory skills.

What Engramory contributes is the **opinionated bundle + the discipline**, not the
primitives. Do not claim novelty on markdown, frontmatter, wikilinks, a loaded
index, one-file-per-fact notes, or curation hygiene — all are prior art.

## What's actually differentiated

1. **A role/purpose ontology, headed by `feedback` = procedural memory.** The
   semantic / episodic / **procedural** split is established prior art — the CoALA
   taxonomy, and a named procedural type in LangMem and mem0 — so Engramory does not
   claim the category. What it does is make procedural `feedback` the *spine* of a
   deliberately tiny, hand-authored, human-readable set, with required **Why:** /
   **How to apply:** lines, instead of auto-extracting it into a vector/graph store.
   The contribution is the packaging and discipline, not the ontology.

2. **The curation contract as concrete behaviour** the protocol applies (model-followed, not a hard gate): dedup-before-write,
   update-don't-duplicate, delete-when-wrong, and a negative-scope rule ("don't
   store what git/CLAUDE.md/the code already records"). Surveys consistently name
   *modify/delete/forget* as the most under-implemented memory operation — Engramory
   makes it the spine.

3. **A bounded index designed not to silently rot.** The index loads every session and
   Claude Code reads the first 200 lines / 25 KB (documented behavior), so an unbounded index silently
   drops memories off the end. Engramory warns at 150 lines / 20 KB, compacts-or-asks
   before 200 / 25 KB, and ships a hard `PreToolUse` hook backstop (it blocks only
   *growth* past the cap — shrinking/compaction edits always pass). Both the line and
   byte caps apply — whichever is hit first triggers (an index can be under the line
   count yet over on bytes when the lines run long).

   Claude Code has since followed up on this natively: v2.1.186 (released
   2026-06-22) reminds the agent to compact the index when it nears the cap, and
   v2.1.210 (released 2026-07-14) turned an over-cap write into an explicit error
   instead of a silent truncation. Both are after-the-fact alerts, though — the
   write still lands, and entries past the cap stay invisible until someone
   compacts. Engramory's hook denies the write *before* it happens, so a write
   through the matched edit tools never leaves the index over-cap in the first
   place (writes outside them — a shell, an MCP file tool — are not gated; see the
   status note above and SKILL.md §8). The native alerts validate the direction
   and make a welcome second layer — and older versions and other hosts still
   have neither.

## How it compares

| | storage | recall | human-readable | typed ontology | curation discipline | bounded index | infra |
|---|---|---|---|---|---|---|---|
| **Engramory** | md files | loaded index → open file | ✅ | ✅ role-based (4) | ✅ contract (model-run) | ✅ 150/200 + hook | none |
| CC auto-memory | md files | loaded index → open file | ✅ | ✅ same 4 types | partial (auto) | ~200-line window* | none (built-in) |
| basic-memory | md + SQLite | semantic/FTS search | ✅ | ✅ freeform type | schema + overwrite checks | ❌ (no loaded index) | SQLite + embeddings |
| obsidian-second-brain | md vault | index-first + search | ✅ | folder-typed | ✅ reconcile/lint | partial | none |
| mem0 / Zep | vector/graph DB | semantic | ❌ (DB) | typed (prefs/episodic/proc.; Zep custom) | auto-extract | n/a | DB + embeddings |
| [agentmemory](https://github.com/rohitg00/agentmemory) | SQLite + vector index (+opt. graph) | hybrid BM25+vector (+opt. graph), RRF | ❌ (DB/engine) | ✅ 4-tier lifecycle (work./epis./sem./proc.) | auto (capture + dedup + decay) | n/a | iii engine (local) + opt. embeddings |

Engramory's lane: **minimalism + actionable role typing + curation discipline, zero
infra.** It does *not* try to out-search basic-memory, out-scale mem0, or
out-capture agentmemory — those solve a different problem (auto-capture /
auto-ingest at volume) at a different cost point. agentmemory is the closest
heavyweight foil: also local-first, but it bets on automatic capture (lifecycle
hooks) + hybrid retrieval (BM25 + vectors + optional graph) on a SQLite/`iii`
engine, where Engramory bets on hand-curation + a tiny always-loaded index and
ships no engine at all.

\* Claude Code's [memory docs](https://docs.claude.com/en/docs/claude-code/memory)
document this exactly: *"the first 200 lines of `MEMORY.md`, or the first 25KB,
whichever comes first, are loaded at the start of every conversation."* Other hosts
vary, so the window stays configurable via the hook's env vars.

## Where it fits — and the goal

Engramory is a **portable memory *discipline*, not a product** — not a database, not a
framework, not a relevance-loaded skill, not a Claude-Code-only plugin. The plumbing it rides on (a markdown index +
one-file-per-fact notes, the `user | feedback | project | reference` types, a bounded loaded index)
is increasingly shipped *natively* by the host — Claude Code's built-in auto-memory
already does it. So Engramory's value is the part hosts **don't** ship: the explicit
curation contract (dedup-before-write, delete-when-wrong, don't-store-what-the-repo-
already-has), procedural `feedback` notes with required Why/How, and a portable way to
enforce the size cap.

**The goal is the same discipline on *any* agent — by riding the real cross-agent rails,
not by inventing a new standard.** Paste [`rules-snippet.md`](rules-snippet.md) into the
host's always-loaded rules so the discipline fires every task. On a host that only gives
you a flat rules file or a raw file store, that is a real upgrade; on a host that already
ships structured memory, Engramory is a thin discipline layer on top — and says so.

**On MCP: deliberately not the route for a host that can already read files and
load standing rules.** Serving memory over MCP would (a) open a *second write
channel* that bypasses the pre-write hook — the single deterministic guarantee
this project has, and one that already lists MCP file tools among the things that
slip past it — and (b) demote recall from an index the host loads *every session*
to a tool the model has to remember to call, i.e. back to the weakest rung in
§8. For a host that lacks files or standing rules, an MCP entry point is the only
way in and is worth adding as a **supplement**; it is not a replacement for the
protocol, and it is not the cross-agent plan.

---

## Continuity without a second handoff store

Engramory uses **one canonical store**. It does not add a `handoff` type or a
parallel handoff folder. An unfinished task may keep **at most one** live `project`
note — a ceiling, not a quota — holding the current goal, status, decisions,
constraints, blockers, and next concrete step needed to resume it. That note is
updated **in place**: never a dated series of state files, and never a per-turn
handoff log indexed beside it. A `feedback` note is narrower: only a correction or workflow
that should be reused beyond that task.

Before a deliberate compact, clear, or move to a new thread, the agent performs
one continuity sync: scan the task, dedup/update existing notes, refresh project
state, promote reusable feedback, keep durable reference pointers, retire stale
or completed transient state, run the size check plus doctor, and verify that a
cold-started agent could continue from the repo and memory alone. Continuity
never duplicates code or git: a note may keep a **stable** pointer (branch name,
issue/PR number, file path) to re-check, and may record a **settled fact**
("2.0 shipped on 2026-01-15"), but never **current state** — the version you are
on now, the tip commit, the current test count. It records where to read those.

After a write, the agent reports what was added, updated, archived, and skipped
(with reasons, identifying any deletion under archived), plus the index size and
check result. Host lifecycle hooks can remind, mark a task dirty, or gate a
manual transition; they do **not** perform or guarantee this semantic sync.

---

## Install

> Requires **Python 3.9+** for the hook and the `tools/` scripts. The commands below
> are written as `python`; on macOS and most Linux distributions a bare `python` does
> not exist, so use `python3` there (and `python` on Windows, where `python3` is often
> a Microsoft Store stub that does nothing).

### Claude Code
1. **Load the discipline as standing rules (primary):** paste
   [`rules-snippet.md`](rules-snippet.md) into your always-loaded rules —
   `~/.claude/CLAUDE.md` (all projects) or the project `CLAUDE.md` — so the protocol
   fires on every task, not just when a skill happens to load by relevance.
2. **(Optional) register the full spec as a skill:** copy or symlink this folder
   into your Claude Code skills directory as `engramory/`, so [`SKILL.md`](SKILL.md)
   is available on demand as the detailed reference (path in `hooks/INSTALL.md`).
3. **Add the hard-cap hook:** register the hook from `hooks/` in your `settings.json`
   (snippet in `hooks/settings.snippet.json`).
4. Point `<MEMORY_ROOT>` at your memory directory; ensure it's `.gitignore`d if
   inside a repo.

### Codex

Use the Codex init helper to wire the discipline into `AGENTS.md`, create the
memory template, optionally install the full protocol as a Codex skill, and add a
`.gitignore` entry when the store lives inside the project:

```sh
python tools/engramory_init.py codex --project-root /path/to/project --install-skill
```

Optional Codex lifecycle assistance can also be installed with
`--install-hooks --mode explicit` (default), or `--mode assisted` to ask for the
same agent-run sync at meaningful milestones. Neither mode silently creates a
semantic summary; review/trust project hooks and confirm them with `/hooks`.
The hook's bounded `.engramory-codex-state.json` stores only synchronization
bookkeeping, never prompts, transcripts, or note bodies.

By default this creates `<project>/.engramory-memory/`. Pass `--memory-root` to
use an existing folder. Keep this store separate from Codex native Memories:
Codex Memories are generated state, while Engramory is a user-auditable plain
folder and the canonical store for the Engramory protocol. Full Codex notes,
including explicit sync versus optional lifecycle-hook assistance, are in
[adapters/codex/README.md](adapters/codex/README.md).

### Read-only readers (recall another agent's memory)

Point **any** host at a store **another agent owns and writes** (e.g. Claude Code's native
auto-memory) so a delegated run is grounded in the same project memory — read-only, so the
owner stays the sole writer (Engramory assumes a single writer; many readers are fine):

```sh
python tools/engramory_init.py codex-reader   --project-root ~/.codex \
  --memory-root ~/.claude/projects/<project>/memory
# same shape for any host — it lands in that host's own rules file:
python tools/engramory_init.py cursor-reader  --project-root /path/to/repo --memory-root <store>
```

Reader hosts: `codex-reader` and `dsh-reader` (both dogfooded) plus `claude-reader`,
`cursor-reader`, `kiro-reader`, `cline-reader`, `windsurf-reader`, `openclaw-reader`,
`hermes-reader` (wired from each host's documented rules-file format, printed with an
"unverified" note). It creates no store and never
writes; `--memory-root` must be an existing store. See
[adapters/reader/README.md](adapters/reader/README.md) (incl. the tested-host table + data-egress note).

### OpenClaw

Use the OpenClaw init helper (defaults to the workspace `~/.openclaw/workspace`):

```sh
python tools/engramory_init.py openclaw --install-skill
```

It writes a marked Engramory block into the workspace `AGENTS.md` (auto-loaded every
session), installs the protocol under `.agents/skills/engramory` (OpenClaw
auto-discovers it), and keeps a separate `.engramory-memory/` store. The index cap on
OpenClaw is rules + `engramory_check.py`, **not** a deterministic deny hook (that would
need a `before_tool_call` plugin) — see
[adapters/openclaw/README.md](adapters/openclaw/README.md).

### Kiro

Kiro (AWS's agentic IDE/CLI) is a strong host — always-loaded steering files, an agent
that reads/writes workspace markdown, and a real pre-write deny hook. Wiring is manual
(no init helper yet): copy
[`adapters/kiro/steering-engramory.md`](adapters/kiro/steering-engramory.md) to
`.kiro/steering/engramory.md` (it is `inclusion: always` and pulls in the live index via
`#[[file:.engramory-memory/MEMORY.md]]`), and keep your notes in a **non-steering**
`.engramory-memory/` folder.

> ⚠️ **Do not drop notes into `.kiro/steering/`.** A steering file with no `inclusion`
> front-matter defaults to `inclusion: always`, so every note would load into every
> request and **blow up your context** — the #1 Kiro install mistake. Only the index
> belongs in always-loaded steering; notes stay in `.engramory-memory/` and open on
> demand. Cap is rules + `engramory_check.py` for now (a deterministic Kiro `PreToolUse`
> hook is possible but not yet shipped/tested). Full notes:
> [adapters/kiro/README.md](adapters/kiro/README.md).

### DeepSeek Harness (dsh)

[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Ftinqiao-oss__engramory.json)](https://unstone.github.io/dsh-xray/registry.html#tinqiao-oss__engramory)

That card is [dsh-xray](https://github.com/unStone/dsh-xray)'s static capability scan of
the plugin, and `C2` reads worse than it is: the level fires on `manifest.bundle.patch`,
which **74.6%** of the scanned ecosystem declares because a plugin that omits it silently
never mounts. That one flag is the entire card here. Across 4,092 scanned plugins 42.6%
ship `exec`, 14.0% `base64_decode`, 10.4% credential-like env reads — this plugin has none
of those, no `eval`, no install script, and no outbound domains.

Use the dsh init helper (defaults to `$DSH_HOME` — the env var wins when set, else `~/.dsh`):

```sh
python tools/engramory_init.py dsh --install-skill
```

It writes a marked Engramory block into `$DSH_HOME/AGENTS.md` — dsh's `agent-instructions`
plugin loads a hardcoded `["AGENTS.md", "CLAUDE.md"]` candidate list at the start of every
session — installs the protocol under `<DSH_HOME>/skills/engramory` (dsh's **user skill
root**; with `--project-root` it goes to `<project>/.dsh/skills/engramory` instead, the
root dsh scans there — *not* `.agents/skills`, which dsh does not scan in either place;
install into an unscanned root and the copy lands but is never listed), and keeps a
separate `.engramory-memory/` store. The user-global block renders ABSOLUTE paths (dsh's
file tools resolve relative paths against the session cwd); a project block stays
relative so the repo can move. The index cap from those steps is rules + `engramory_check.py`,
**not** a deterministic deny hook — though [`adapters/dsh/plugin/`](adapters/dsh/plugin/)
(`dsh-engramory`) implements one against `ctx.tools.guard()`, whose refusal is monotonic.
Install **0.2.1 or later**: dsh's preview-era "cannot install third-party plugins"
bug is fixed upstream (rc.7), and 0.2.0 installs but never activates (issue #8 —
older-Cordis `inject` syntax).

Wiring *and* model behavior were dogfooded against `deepseek-v4-flash`: the block arrives
as a `<system-reminder>`, a question answerable only from a stored note made the model open
that note unprompted, and one durable fact came back as a conforming note plus index
pointer. See [adapters/dsh/README.md](adapters/dsh/README.md).

### Any other agent (Hermes, Cursor, Cline, Windsurf, …)
Engramory is model-agnostic (DeepSeek, GPT, Llama, …) and rides on the host's own
memory store. Full wiring is in **[PORTING.md](PORTING.md)**; in short: paste
[`rules-snippet.md`](rules-snippet.md) into the host's always-loaded rules (so the
discipline is always-on, not just a by-relevance skill), import [`SKILL.md`](SKILL.md)
if the host supports skills, point `<MEMORY_ROOT>` at the host's memory dir **when
that dir is plain files you control** (against a host that manages its own memory —
Codex, OpenClaw, Hermes — use a separate folder instead), and
wire the size cap at the strongest rung the host supports: PreToolUse hook →
`tools/engramory_check.py` after each index write → model discipline, with
`tools/engramory_doctor.py` as a periodic backstop. A deterministic cap needs a
pre-write *deny* hook. Claude Code's is written, tested, and RUNNING here; dsh's shim
(`adapters/dsh/plugin/`, `dsh-engramory` 0.2.1+) installs and activates on current dsh
builds — 0.2.0 never activated (issue #8); some other hosts
expose an equivalent seam too (Hermes; Cursor, though its is newer/flaky), so the cap is portable with
a per-host I/O shim you write and verify yourself — while OpenClaw can only block via a
`before_tool_call` plugin and some hosts have none. See [PORTING.md](PORTING.md) for the
per-host picture. Where no such hook exists (or plain chat), the cap degrades to
best-effort discipline (see [SKILL.md](SKILL.md) §9).

First connecting a *pre-existing* store to the strict `doctor` surfaces a wall of
mechanical issues (missing `created`/`updated`, Why/How not yet in canonical form) —
don't blindly fix them. See PORTING.md's [Adopting an existing store](PORTING.md): run
`--no-schema` for structure first, batch-backfill dates with the snippet, then
hand-write Why/How.

A plain chat UI with no file access / no rules mechanism cannot run Engramory — it
needs a host that executes skills/rules and can read & write files.

## Uninstall

Remove a host's wiring by re-running the same host with `--uninstall`:

```sh
python tools/engramory_init.py codex --uninstall --dry-run   # print the plan
python tools/engramory_init.py codex --uninstall             # do it
```

It removes only what the installer wrote — the marked block in the rules file, the
installed skill copy, and the managed Codex hooks (dropping this installer's handlers
while keeping anyone else's, and deleting `.codex/hooks.json` only when nothing but ours
was in it).

**The memory store is never touched**, nor is its `.gitignore` entry: the notes are the
one artefact here that cannot be regenerated from this repo, and the ignore rule is what
keeps a still-present store out of git. Delete the store yourself if you want the
memories gone.

That holds even for a store kept inside a directory the uninstall cleans up — it removes
its own files by name and leaves anything else in place, naming what it kept. If your
store is not at the default path, passing the same `--memory-root` to `--uninstall` is
still worth it: it lets the closing report name your real store instead of saying it
could not find one.

A rules file with stray or duplicated markers (a botched hand-edit) is left
byte-identical and reported, rather than guessed at — an Engramory block you must remove
by hand is recoverable; content deleted on a guess is not.

## Configuration

- **`<MEMORY_ROOT>`** — where memory lives. Keep it somewhere you'll actually
  look; `.gitignore` it inside repos.
- **Index limits** — soft warn / hard cap default 150 / 200 lines and 20 / 25 KB;
  override via the hook's env vars (see `hooks/`).

## Security & privacy

The store is **plain, unencrypted text** that any local process can read. `.gitignore`
keeps it out of git — it is **not** encryption, and it does nothing against
cloud-sync clients (Dropbox / iCloud / OneDrive), OS backups, or desktop search. If
your `<MEMORY_ROOT>` sits in a synced or backed-up folder, its contents leave your
machine.

- **Never write a secret's *value*** into memory — keys, tokens, passwords,
  cookies, recovery codes. Record only *where* the secret lives (e.g. "in the
  password manager / env var `FOO`"). An IP / path / serial used as a locator is
  fine; a credential value never is.
- Minimize partial PII (phone, email, address) — prefer a pointer.

This discipline is **unenforced** (no hook scans memory content — see
[SKILL.md](SKILL.md) §5/§8); treat it as best-effort and be deliberate.

## Known limitations

Engramory is a **single-project, single-writer, personal-scale** protocol. It does
*not* yet have:

- **Versioning / migration** — the semantic memory store has no
  `schema_version`; there is no defined upgrade path if the frontmatter format
  changes. (The optional Codex hook's bookkeeping file is versioned, but it
  contains no memory.) For onboarding a *pre-existing* store, PORTING.md's
  "Adopting an existing store" has a triage recipe + a date-backfill snippet.
- **Provenance / trust** — no `source`, `confidence`, `last_verified`, expiry, or
  `superseded-by` fields. Recalled memory is advisory and attacker-influenceable
  (see [SKILL.md](SKILL.md) §4); there is no authentication of memory content.
- **Scope / multi-project** — a note CAN carry an optional `scope: global | repo`
  (SKILL.md §2.1, doctor-validated), but there is still no `project_id`, and one flat
  slug namespace means a store shared across projects/agents would hit slug
  collisions and project bleed. A store-level manifest (protocol version + scope +
  host config) is the planned first step — not built yet.
- **Concurrency** — semantic note/index writes assume one serialized writer and
  have no store-level lock. The optional Codex hook locks only its bookkeeping
  state; it does not make memory writes concurrent-safe.
- **Scale** — the always-loaded flat index bounds the *active* set to what fits the
  cap (~200 pointers). It is a personal / curated-scale tool, not a large corpus;
  above that, a retrieval-based system (basic-memory, mem0) is the right tool.

## Prior art & credits
Andrej Karpathy's **LLM Wiki / Knowledge Base** (the markdown-over-RAG pattern, the
most prominent statement of this approach — note it targets a knowledge
*encyclopedia*, where Engramory targets agent *working* memory: who the user is,
how the agent should behave, project state) · Claude Code auto-memory · basic-memory ·
obsidian-second-brain · claude-memory-compiler (itself Karpathy-inspired) · the
Anthropic memory tool · OpenAI Codex memory (and its earlier topics-memory proposal
#19758) · [agentmemory](https://github.com/rohitg00/agentmemory) (a heavyweight,
local-first counterpart — auto-capture + SQLite/`iii` engine + hybrid BM25/vector
retrieval; the opposite design point to Engramory's zero-infra hand-curation) ·
the wider markdown-memory community.

## License
MIT — see [LICENSE](LICENSE).
