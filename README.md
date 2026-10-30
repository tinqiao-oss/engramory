**English** | [简体中文](README.zh-CN.md)

# Engramory

[![CI](https://github.com/tinqiao-oss/engramory/actions/workflows/test.yml/badge.svg)](https://github.com/tinqiao-oss/engramory/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-blue.svg)](https://www.python.org/)

**A zero-infrastructure memory *protocol* for small-scale, local, file-based
agent memory.** Engramory combines curation rules with a validator
(`tools/engramory_doctor.py`): small markdown notes, one pointer-only index, and
rules loaded through `CLAUDE.md`, `AGENTS.md`, or your host's standing instructions.
The files are human-readable and editable; the live store stays git-ignored.

> *Engramory* — *engram* (a memory's physical trace) + *memory*.
> Here: one file = one fact.

> ⚠️ **Unrelated projects share this name.** This project is
> `tinqiao-oss/engramory` (npm: `dsh-engramory`); same-named repositories under
> other owners are not its forks, mirrors, or newer versions.

> 🤖 **AI agent asked to install or check this?** Start at
> **[AGENT-SETUP.md](AGENT-SETUP.md)** to assess the host, existing stores, safe
> setup, and what you can honestly report as active.

> **Status: 1.0.0.** The store format, the tools and the index caps now change
> incompatibly only in a major version ([versioning](#versioning)); what they cover
> has not changed. Claude Code's `PreToolUse` hook provides the
> hard index cap for matched direct-edit tools (`Edit | Write | MultiEdit`); the
> `dsh-engramory` plugin is the second, for dsh's file tools. Shell tools (Bash, PowerShell, background Monitor commands), MCP file tools,
> external editors, and sync clients bypass the guards. Model-followed curation
> remains best-effort; this is not a mandatory, reliable cross-agent memory layer.
> See [host coverage](PORTING.md) and [protocol limits](SKILL.md).

---

## What this is — and is NOT

Engramory is a **discipline, not a storage engine**: no database, embeddings, or
server. Standing rules carry the recall/write instructions; an optional skill
carries the full protocol. It needs a host with rules and file access, so a plain
chat UI without either cannot run it. The model itself does not matter.

The markdown-plus-index pattern and typed notes are prior art. Engramory's
contribution is their curation contract and host-specific guard implementations,
not a new memory architecture. Its focus is agent working memory: who the user
is, how the agent should behave, and what a project needs next.

## What's actually differentiated

1. **A small index, details opened on demand.** `MEMORY.md` contains pointers,
   not prose copied from the notes. Keep it available every session through host
   injection or an explicit read: Codex needs the read, and on dsh the plugin injects
   it (without the plugin, dsh needs the read too). Bounding the
   index controls recurring context cost and avoids exceeding a host's load window.
2. **Curated, actionable notes.** The types are
   `user | feedback | project | reference`, plus `moment | upcoming | self` for a
   companion character's own life (SKILL.md §2.2). A store can be written in Chinese
   (§1.1). Procedural
   `feedback` records reusable
   corrections with **Why:** and **How to apply:**. The agent checks for duplicates,
   updates existing notes, retires wrong or stale facts, and avoids copying what
   git, code, or project instructions already record. These are model-followed rules.
3. **A pre-write size backstop where implemented.** The default hard cap is
   200 lines / 25 KB; either dimension can trigger it. The guard denies growth
   past a cap that it can measure, while permitting compaction (the dsh plugin
   cannot measure an `insert`-style partial edit). Claude Code may also provide
   after-write alerts; Engramory's hook acts before the write. Configuration and
   coverage live in [hooks/INSTALL.md](hooks/INSTALL.md), the
   [dsh plugin guide](adapters/dsh/plugin/README.md), and [PORTING.md](PORTING.md).

## Continuity without a second handoff store

An unfinished task may keep **at most one** live `project` note in the canonical
store, updated in place: goal, status, decisions, constraints, blockers, and next
step. There is no extra `handoff` type, dated series, or per-turn handoff log.
`feedback` is reserved for corrections or workflows reusable beyond that task.

Before a deliberate compact, clear, or new thread, perform the
[continuity sync](PORTING.md#3-wire-continuity-sync--explicit-first-hooks-optional):
curate the notes, retire stale or completed transient state, run check + doctor,
and confirm a cold-started agent could continue. Keep stable pointers to repo
state and re-check them on recall; do not duplicate changing git/test state.
Report added, updated, archived (including deletions), and skipped with reasons,
plus index size and check result. Lifecycle hooks can prompt or gate a transition;
they cannot perform or guarantee the semantic sync.

## How it compares

- **Native memory, such as Claude Code auto-memory:** the index/detail-file
  pattern is familiar; Engramory adds an explicit curation contract and a pre-write
  guard for the operations its adapter covers.
- **Markdown-memory projects:** [obsidian-second-brain](https://github.com/eugeniughelbur/obsidian-second-brain)
  and [claude-memory-compiler](https://github.com/coleam00/claude-memory-compiler)
  share the file-based approach. Engramory emphasizes small, typed, curated notes.
- **Retrieval and automatic-capture systems:** [basic-memory](https://github.com/basicmachines-co/basic-memory),
  mem0, Zep, and [agentmemory](https://github.com/rohitg00/agentmemory) address needs
  beyond a tiny loaded index. Engramory supplies no search engine or automatic
  ingestion pipeline; it is intended for a curated personal active set.
- **An MCP server — deliberately not the route** for a host that already reads
  files and loads standing rules: it would open a second write channel past the
  pre-write guard, and turn recall from an index loaded every session into a tool
  the model has to remember to call. For a host with neither, an MCP entry point is
  worth adding as a supplement, not a replacement for the protocol.

---

## Install

> Requires **Python 3.9+** for the hook and `tools/` scripts. Run the commands from
> this repository. They use `python`; use `python3` on macOS / Linux where bare
> `python` is unavailable, and `python` on Windows (where `python3` may be a Store stub).

### Claude Code

1. Paste [`rules-snippet.md`](rules-snippet.md) into `~/.claude/CLAUDE.md`
   (all projects) or the project `CLAUDE.md` so the discipline is always in context.
2. Optionally copy or symlink this folder as `engramory/` in the Claude Code skills
   directory so [`SKILL.md`](SKILL.md) is available on demand.
3. Register `hooks/engramory_index_guard.py` in `settings.json` using
   [`hooks/settings.snippet.json`](hooks/settings.snippet.json).
4. Point `<MEMORY_ROOT>` at your memory directory; `.gitignore` it inside a repo.

Exact paths, interpreter setup, and a scratch-write check that verifies the hook
actually denies are in [hooks/INSTALL.md](hooks/INSTALL.md).

> **Optional — read the transcripts behind a memory.**
> `tools/engramory_trace.py` searches Claude Code's JSONL transcripts locally and
> read-only, without uploads, indexing, or embeddings. Use it for the reasoning
> behind a terse note, original evidence, or a discussion that was never saved:
>
> ```bash
> python tools/engramory_trace.py "streaming parser"   # search this project
> python tools/engramory_trace.py --show <session-id>  # replay one session
> ```
>
> It searches spoken messages by default, excluding tool output that would repeat
> injected memories. If a note names its origin session, use `--show` to open it.
> This Claude Code convenience is separate from the memory protocol.

### Codex

The helper installs the rules in `AGENTS.md`, creates the memory template, copies
the skill, and git-ignores an in-project store:

```sh
python tools/engramory_init.py codex --project-root /path/to/project --install-skill
```

The default store is `<project>/.engramory-memory/`; use `--memory-root` for an
existing folder. Keep it separate from Codex native Memories, which Codex manages.

For optional lifecycle assistance, add `--install-hooks --mode explicit`
(default), or `--mode assisted` for milestone reminders. Both depend on an
agent-run sync. Review/trust project hooks and confirm their active state with
`/hooks`; `.engramory-codex-state.json` holds only bounded synchronization
bookkeeping, never prompts, transcripts, or note bodies.

See [adapters/codex/README.md](adapters/codex/README.md), especially its chat-bridge
notes if each incoming message starts a session: Engramory's index is read through
a file tool, not auto-loaded. The cap uses rules + check + doctor, best-effort.

### Read-only readers (recall another agent's memory)

Use [one writer and many readers](adapters/reader/README.md) to let another host
recall an existing store without becoming a second curator:

```sh
python tools/engramory_init.py codex-reader   --project-root ~/.codex \
  --memory-root ~/.claude/projects/<project>/memory
# another host — writes the recall rule into that host's own rules file:
python tools/engramory_init.py cursor-reader  --project-root /path/to/repo --memory-root <store>
```

`--memory-root` must already contain `MEMORY.md`; the reader creates no store.
Keep `--project-root` outside the store. The [reader guide](adapters/reader/README.md)
documents supported readers, verification status, instruction-level read-only
limits, and data egress; [PORTING.md](PORTING.md) covers host capabilities.

### OpenClaw

The helper defaults to workspace `~/.openclaw/workspace`:

```sh
python tools/engramory_init.py openclaw --install-skill
```

It wires workspace `AGENTS.md`, installs `.agents/skills/engramory`, and creates
a separate `.engramory-memory/` store. The cap uses rules + check + doctor,
best-effort; see [adapters/openclaw/README.md](adapters/openclaw/README.md).

### Kiro

Setup is manual (no init helper): copy the
[steering template](adapters/kiro/steering-engramory.md) to
`.kiro/steering/engramory.md`. It uses `inclusion: always` and the live index
reference `#[[file:.engramory-memory/MEMORY.md]]`; keep the notes in the
**non-steering** `.engramory-memory/` directory.

> ⚠️ **Do not put notes in `.kiro/steering/`.** Steering without an `inclusion`
> field defaults to always-loaded, which would put every note into every request.
> Git-ignore the store but keep it out of `.kiroignore` so the agent can read it.

No Kiro guard is shipped or verified here. Use rules + check + doctor, best-effort;
follow [adapters/kiro/README.md](adapters/kiro/README.md) for the full setup and
validator paths (the manual setup does not copy `tools/` into your workspace).

### DeepSeek Harness (dsh)

[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Ftinqiao-oss__engramory.json)](https://unstone.github.io/dsh-xray/registry.html#tinqiao-oss__engramory)

The badge links to the plugin's static capability scan. Setup defaults to
`$DSH_HOME` when set, otherwise `~/.dsh`:

```sh
python tools/engramory_init.py dsh --install-skill
```

This wires `$DSH_HOME/AGENTS.md`, installs `$DSH_HOME/skills/engramory`, and keeps
a separate `.engramory-memory/` store. Pass `--project-root` for a project install
at `<project>/.dsh/skills/engramory`. Global rules use absolute store paths;
project rules use relative paths. Details: [adapters/dsh/README.md](adapters/dsh/README.md).

The helper alone gives rules + check + doctor. For the deterministic guard (0.2.7+)
and the index injected into every request without a read (0.2.8+), install
**`dsh-engramory`** in the profile you use (`pnpm` must be on PATH):

```sh
dsh plugin --profile <name> add dsh-engramory
```

See the [plugin guide](adapters/dsh/plugin/README.md) for configuration and guard
limits. Compatible dsh releases are exactly the `compatible` entries in
`dsh.compatibility.dshReleases` in [package.json](adapters/dsh/plugin/package.json),
backed by [results.json](tests/dsh_e2e/results.json); an unlisted release is unverified.
The [E2E guide](tests/dsh_e2e/README.md) describes verification, and
[CHANGELOG.md](CHANGELOG.md) is the release-history record.

### Any other agent (Hermes, Cursor, Cline, Windsurf, …)

Follow [PORTING.md](PORTING.md): put [`rules-snippet.md`](rules-snippet.md) in
always-loaded instructions, optionally import [`SKILL.md`](SKILL.md), and select
one `<MEMORY_ROOT>` you control. Reuse native memory only if it is an editable
plain-file store; keep Engramory separate from host-managed memory.

These hosts use rules + `tools/engramory_check.py` after index writes + periodic
`tools/engramory_doctor.py`, best-effort. A pre-write seam alone does not supply an
Engramory guard; see the [host capability matrix](PORTING.md).

For a pre-existing store, use [Adopting an existing store](PORTING.md#adopting-an-existing-store):
start with `--no-schema` to check structure, backfill missing dates with the
documented snippet, then hand-write Why/How before re-running strict doctor.

## Uninstall

Re-run the same host and installation paths with `--uninstall`:

```sh
python tools/engramory_init.py codex --uninstall --dry-run   # print the plan
python tools/engramory_init.py codex --uninstall             # do it
```

It removes the marked rules block, installed skill copy, and managed Codex hook
handlers. Unrelated handlers remain; `.codex/hooks.json` is deleted only if it
held nothing else. A rules file with stray or duplicate markers is left
byte-identical and reported for manual cleanup.

**The memory store and its `.gitignore` entry are never removed**, even when the
store sits inside a directory being cleaned. Only installer-owned files are
removed, and retained files are reported. Pass the original `--memory-root` for a
non-default store so the report names it correctly. Delete memories yourself if
you want them gone.

## Configuration

- **`<MEMORY_ROOT>`** — choose a folder you will inspect; git-ignore it inside repos.
- **Index limits** — Claude Code defaults and environment overrides are in
  [hooks/INSTALL.md](hooks/INSTALL.md); dsh defaults and config keys are in the
  [plugin configuration table](adapters/dsh/plugin/README.md#configuration).

## Security & privacy

The store is **plain, unencrypted text** readable by local processes with file
access. `.gitignore` only keeps it out of git; cloud sync, backups, and desktop
search can still copy or index it. A synced or remotely backed-up folder can send
its contents off-machine.

- **Never store secret values** — keys, tokens, passwords, cookies, recovery codes.
  Record where they live (password manager / environment variable `FOO`). IPs,
  paths, and serials can be locators; credential values cannot.
- Minimize personal information such as phone numbers, email, or addresses;
  prefer pointers.

No hook scans memory content for secrets. This is best-effort discipline; see
[SKILL.md](SKILL.md) §5/§8 and [SECURITY.md](SECURITY.md).

## Versioning

One number for everything: from 1.0.0 the repo's tag `vX.Y.Z` and the npm package
`dsh-engramory@X.Y.Z` are one release, published together even when only one side
changed (the [CHANGELOG](CHANGELOG.md) says which). Before 1.0 the plugin had its own
numbers (0.1.0–0.3.0).

From 1.0, these change incompatibly only in a major version:

- **The store format:** the layout (`MEMORY.md`, one note per file, `archive/`), the
  frontmatter keys, the four types and what each requires, and the index's headings
  and pointer lines, in English and in Chinese.
- **The tools:** the scripts in `tools/` (their commands and options, and where
  `engramory_init.py` puts a store), and the Claude Code and Codex hooks.
- **The dsh plugin:** its package name, the index cap's decisions (the table in its
  README), and the settings
  `indexName`, `maxLines`, `maxBytes`, `indexPath`, `registerSkill`, `injectIndex`,
  `language` and `skill`.

Experimental, and may change in a minor version: dsh's companion mode (`companion`)
with the types `moment` / `upcoming` / `self`, social mode (`audience`) with the file
refusals it adds and the bridge `speaker` stamp, and the plugin's settings and memory
pages. The protocol's wording is
revised in any release; a rule that would make a valid store invalid waits for a major
version. A security fix may change what an unsafe configuration does in any release,
and its CHANGELOG entry says so, as 0.13.0's `indexName` fallback did.

## Known limitations

**Exactly two hosts have a deterministic pre-write deny written, tested, and
running here:** Claude Code ([`hooks/engramory_index_guard.py`](hooks/engramory_index_guard.py))
and dsh ([`dsh-engramory >= 0.2.7`](adapters/dsh/plugin/README.md)). Every other
host gets rules + `engramory_check.py` + doctor, best-effort. Even hosts exposing
a seam — Hermes, Cursor, OpenClaw via `before_tool_call`, and Kiro CLI — are
**portable in principle, not written or verified here**. See [PORTING.md](PORTING.md)
for the authoritative host picture; shell, MCP, and external-editor writes bypass
every guard.

- **Versioning / migration:** the store carries no `schema_version`, and nothing
  upgrades one automatically: a format change that would invalidate existing stores
  waits for a major version ([Versioning](#versioning)), with the steps to migrate in
  the CHANGELOG. Codex's versioned bookkeeping contains no memory.
- **Provenance / trust:** no `source`, `confidence`, `last_verified`, expiry, or
  `superseded-by` fields. Recalled memory is advisory, unauthenticated, and
  attacker-influenceable ([SKILL.md](SKILL.md) §4).
- **Scope / multi-project:** optional `scope: global | repo` is doctor-validated,
  but there is no `project_id`; the flat slug namespace can cause collisions and
  project bleed. A store manifest for protocol version, scope, and host config is
  planned, not implemented.
- **Concurrency:** use [one writer and many readers](adapters/reader/README.md);
  Codex's bookkeeping lock does not lock semantic note/index writes.
- **Scale:** the active set must fit the bounded index. This is personal-scale
  curated memory, not a large corpus or an automatic capture system.

## Prior art & credits

Andrej Karpathy's **LLM Wiki / Knowledge Base** (knowledge encyclopedias, compared
with Engramory's agent working memory) · Claude Code auto-memory · basic-memory ·
obsidian-second-brain · claude-memory-compiler · Anthropic memory tool · OpenAI
Codex memory · [agentmemory](https://github.com/rohitg00/agentmemory) · the wider
markdown-memory community. The primitives and procedural-memory category are
prior art; the contribution is the discipline and its packaging.

## License

MIT — see [LICENSE](LICENSE).
