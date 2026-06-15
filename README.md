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

> **Status: 0.3.0 — experimental.** The hard index cap (a `PreToolUse` hook) is
> deterministic for the matched direct-edit tools (`Edit | Write | MultiEdit`) but
> NOT a global write guard (Bash / MCP file tools / external editors / sync clients
> bypass it); the discipline loads as standing rules the model follows, so it's
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
index, atomic notes, or curation hygiene — all are prior art.

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
atomic notes, the `user | feedback | project | reference` types, a bounded loaded index)
is increasingly shipped *natively* by the host — Claude Code's built-in auto-memory
already does it. So Engramory's value is the part hosts **don't** ship: the explicit
curation contract (dedup-before-write, delete-when-wrong, don't-store-what-the-repo-
already-has), procedural `feedback` notes with required Why/How, and a portable way to
enforce the size cap.

**The goal is the same discipline on *any* agent — by riding the real cross-agent rails,
not by inventing a new standard.** Paste [`rules-snippet.md`](rules-snippet.md) into the
host's always-loaded rules so the discipline fires every task; an **Engramory MCP server
(planned)** would then let any MCP-capable agent (Claude Code, Cursor, Cline, Codex,
Windsurf, …) share the same store, the same tools, and a **server-enforced cap** — making
the one deterministic guarantee cross-agent instead of per-host. On a host that only gives
you a flat rules file or a raw file store, that is a real upgrade; on a host that already
ships structured memory, Engramory is a thin discipline layer on top — and says so.

---

## Install

> Requires **Python 3.9+** for the hook and the `tools/` scripts (`python3` on
> most systems).

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

By default this creates `<project>/.engramory-memory/`. Pass `--memory-root` to
use an existing folder. Keep this store separate from Codex native Memories:
Codex Memories are generated state, while Engramory is a user-auditable plain
folder. Full Codex notes are in [adapters/codex/README.md](adapters/codex/README.md).

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

### Any other agent (Hermes, Cursor, Cline, Windsurf, …)
Engramory is model-agnostic (DeepSeek, GPT, Llama, …) and rides on the host's own
memory store. Full wiring is in **[PORTING.md](PORTING.md)**; in short: paste
[`rules-snippet.md`](rules-snippet.md) into the host's always-loaded rules (so the
discipline is always-on, not just a by-relevance skill), import [`SKILL.md`](SKILL.md)
if the host supports skills, point `<MEMORY_ROOT>` at the host's memory dir, and
wire the size cap at the strongest rung the host supports: PreToolUse hook →
`tools/engramory_check.py` after each index write → model discipline, with
`tools/engramory_doctor.py` as a periodic backstop. A deterministic cap needs a
pre-write *deny* hook. Only Claude Code's is written and tested here; some other hosts
expose one too (Hermes; Cursor, though its is newer/flaky), so the cap is portable with
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

- **Versioning / migration** — no `schema_version`; no defined upgrade path if the
  frontmatter format changes. (For onboarding a *pre-existing* store, PORTING.md's
  "Adopting an existing store" has a triage recipe + a date-backfill snippet.)
- **Provenance / trust** — no `source`, `confidence`, `last_verified`, expiry, or
  `superseded-by` fields. Recalled memory is advisory and attacker-influenceable
  (see [SKILL.md](SKILL.md) §4); there is no authentication of memory content.
- **Scope / multi-project** — no `scope` / `project_id`; one flat slug namespace, so
  a store shared across projects/agents would hit slug collisions and project bleed.
  A store-level manifest (protocol version + scope + host config) is the planned
  first step — not built yet.
- **Concurrency** — single writer / serialized writes assumed (no locking).
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
