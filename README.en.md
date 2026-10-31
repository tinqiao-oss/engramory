[简体中文](README.md) | **English**

<p align="center"><img src="brand/anim/engramory-merged.gif" alt="Engramory logo animation: a book opens to the right and engramory is typed at the cursor" width="640"></p>

# Engramory

[![CI](https://github.com/tinqiao-oss/engramory/actions/workflows/test.yml/badge.svg)](https://github.com/tinqiao-oss/engramory/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Ftinqiao-oss__engramory.json)](https://unstone.github.io/dsh-xray/registry.html#tinqiao-oss__engramory)

**A general-purpose long-term memory layer for AI agents.** What the AI remembers is kept as small markdown
files, one per memory, with a pointer-only index (`MEMORY.md`) that is read at the start
of every session; a note is opened when its details are needed. No database,
embeddings, or server; you can read and edit every file yourself. It works with Claude
Code, Codex, [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh),
OpenClaw, Kiro and others; one agent writes a store, and others can read it.

**dsh has a dedicated plugin**, `dsh-engramory`: it works once installed, brings the
index into context on every step, refuses most writes that would grow the index past
its cap before they land, and adds a Memory page to the sidebar. On Claude Code a hook
refuses those writes; other tools rely on the rules plus a checker.

> The name is *engram* (a memory's physical trace) + *memory*. This project is
> `tinqiao-oss/engramory` (the dsh plugin is `dsh-engramory` on npm); same-named
> repositories under other owners are unrelated.

> 🤖 **AI agent asked to install or check this?** Start at [AGENT-SETUP.md](AGENT-SETUP.md).

> **Status: 1.0.4.** The store format, the tools and the index caps now change
> incompatibly only in a major version; see [Versioning](#versioning).

## What it looks like

```text
.engramory-memory/
├── MEMORY.md                 the index: one line per note
├── run-tests-first.md        one file = one fact
├── db-migration-rules.md
└── archive/                  stale notes are archived here
```

A line in the index: `- [Run the tests first](run-tests-first.md) — test before calling a change done`

A `feedback` note keeps a reusable correction, with the reason and how to apply it:

```markdown
---
name: run-tests-first
description: Test before calling a change done
type: feedback
created: 2026-10-31
updated: 2026-10-31
---
Run the tests after a code change, and only then call it done.
**Why:** a change was once reported done untested, and CI broke.
**How to apply:** finish every code change with a test run.
```

## Install

> The dsh plugin installs from npm and needs nothing else. The others need Python 3.9+;
> run the commands from this repository, and use `python3` on macOS / Linux where bare
> `python` is unavailable.

### DeepSeek Harness (dsh)

```sh
dsh plugin --profile <name> add dsh-engramory
```

In dsh's desktop app you can also search for `dsh-engramory` on the Plugins page. It
works once installed: the memory lives in `~/.dsh/.engramory-memory/` by default, and
the sidebar gets a read-only Memory page. Settings, companion mode, social mode and the
cap's rules are in the [plugin README](adapters/dsh/plugin/README.en.md).

![The memory page in dsh](https://raw.githubusercontent.com/tinqiao-oss/engramory/master/adapters/dsh/plugin/screenshots/memory-page.png)

### Claude Code

1. Paste [`rules-snippet.md`](rules-snippet.md) into `~/.claude/CLAUDE.md` (all
   projects) or a project's `CLAUDE.md`.
2. Optionally copy or link this repo as `engramory/` in the Claude Code skills
   directory, so [`SKILL.md`](SKILL.md) is available on demand.
3. Register the pre-write hook in `settings.json` with
   [`hooks/settings.snippet.json`](hooks/settings.snippet.json).

Exact paths, and a check that the hook really denies, are in
[hooks/INSTALL.md](hooks/INSTALL.md). Also included: `tools/engramory_trace.py`
searches Claude Code's transcripts locally and read-only, to find the story behind a
note.

### Codex

```sh
python tools/engramory_init.py codex --project-root /path/to/project --install-skill
```

The store defaults to `<project>/.engramory-memory/`; use `--memory-root` for an
existing folder. It stays separate from Codex's own Memories. Add `--install-hooks`
for lifecycle reminders; they run only once you trust the project hooks in Codex
(check with `/hooks`). For a chat bridge that starts a session per message, read
[adapters/codex/README.md](adapters/codex/README.md) first.

### Other hosts

- **OpenClaw:** `python tools/engramory_init.py openclaw --install-skill`; see
  [adapters/openclaw](adapters/openclaw/README.md).
- **Kiro:** copy the steering template by hand; see [adapters/kiro](adapters/kiro/README.md).
  Keep the notes out of `.kiro/steering/`, or every note loads into every request.
- **Cursor, Cline, Hermes, …:** follow [PORTING.md](PORTING.md) to put
  `rules-snippet.md` in the standing instructions. To take over an existing store, see
  its [Adopting an existing store](PORTING.md#adopting-an-existing-store).

These hosts have no pre-write cap: they rely on the rules, `tools/engramory_check.py`
after each index write, and `tools/engramory_doctor.py` now and then.

### Let another agent read the same store

One agent writes a store; others only read it
([one writer, many readers](adapters/reader/README.md)):

```sh
python tools/engramory_init.py codex-reader --project-root ~/.codex \
  --memory-root ~/.claude/projects/<project>/memory
```

A reader creates no store; `--memory-root` must already hold a `MEMORY.md`. "Read-only"
is a rule the agent follows, not enforced, and what it recalls goes to that host's
model provider. See the [reader guide](adapters/reader/README.md).

## Why it works this way

- **A small index, details on demand.** The index is read at the start of every
  session (injected by the host, as the dsh plugin does, or read by the agent), so it holds
  pointers only, capped at 200 lines / 25 KB by default.
- **Curated notes, not a log.** Four types: `user | feedback | project | reference`.
  Before writing, the agent checks for a duplicate, updates an existing note rather
  than adding one, retires what is stale, and does not copy what git or the code
  already records. A companion character adds `moment`, `upcoming` and `self` for its
  own life ([SKILL.md](SKILL.md) §2.2); a store can be written in Chinese (§1.1).
- **The cap is enforced before the write.** On dsh (a plugin) and Claude Code (a hook),
  a write whose result can be worked out and would grow the index past the cap is
  refused before it lands; compaction still passes. Other tools rely on the rules plus
  a checker.
- **Continuity without a handoff store.** An unfinished task keeps one `project` note,
  updated in place with its status and next step; before a compact, clear, or new
  thread, the agent runs a [continuity sync](PORTING.md#3-wire-continuity-sync--explicit-first-hooks-optional).

## How it compares

- **Native memory** (such as Claude Code auto-memory): the same index-plus-files
  pattern; Engramory adds explicit curation rules and a pre-write cap.
- **Retrieval and auto-capture systems** (basic-memory, mem0, Zep, agentmemory, …):
  built for large memory sets. Engramory has no search engine or automatic ingestion;
  it is for a curated personal set.
- **No MCP server.** For a host that already reads files and loads standing rules, MCP
  would open a second write channel past the pre-write cap, and turn recall from an
  index loaded every session into a tool the model has to remember to call. For a host
  with neither, an MCP entry point is worth adding as a supplement.

## Uninstall

The dsh plugin: `dsh plugin --profile <name> remove dsh-engramory`. For a setup made
with the installer, run the same host and paths again with `--uninstall` (add
`--dry-run` first to see the plan):

```sh
python tools/engramory_init.py codex --uninstall
```

It removes only what the installer put there: the rules block, the skill copy, the
Codex hooks. **The memory store is never removed**; delete it yourself if you want it
gone.

## Security & privacy

The store is **plain, unencrypted text** that any local process can read; `.gitignore`
only keeps it out of git, and cloud sync or backups still copy it.

- **Never store secret values** (keys, tokens, passwords, cookies), only where they
  live (a password manager, an environment variable's name).
- Keep personal details such as phone numbers, email or addresses to a minimum; prefer
  pointers.

Nothing scans for secrets; it is discipline only. See [SKILL.md](SKILL.md) §5/§8 and
[SECURITY.md](SECURITY.md).

## Versioning

The repo's `vX.Y.Z` and the npm package `dsh-engramory@X.Y.Z` are one release,
published together even when only one side changed (the [CHANGELOG](CHANGELOG.md) says
which).

**Change incompatibly only in a major version:**

- **The store format:** the layout (`MEMORY.md`, one note per file, `archive/`), the
  frontmatter keys, the four types and what each requires, and the index's headings and
  pointer lines, in English and in Chinese.
- **The tools:** the scripts in `tools/` (their commands and options, and where
  `engramory_init.py` puts a store), and the Claude Code and Codex hooks.
- **The dsh plugin:** its package name, the cap's decisions, and the settings
  `indexName`, `maxLines`, `maxBytes`, `indexPath`, `registerSkill`, `injectIndex`,
  `language` and `skill`.

**Experimental, may change in a minor version:** companion mode (`companion`) and its
three types, social mode (`audience`), and the plugin's settings and memory pages.

The protocol's wording is revised in any release, but a rule that would make a valid
store invalid waits for a major version. The store carries no version number; a format
change's migration steps go in the CHANGELOG. A security fix may change what an unsafe
configuration does in any release, and the CHANGELOG says so.

## Known limitations

- **Only dsh and Claude Code refuse a write before it lands**, and shell tools, MCP
  file tools and external editors go past both. Every other host relies on the rules,
  best-effort; [PORTING.md](PORTING.md) is the authoritative host picture.
- **Curation depends on the model following the rules**; nothing enforces it.
- **No provenance, confidence or expiry fields.** Recalled memory is advisory and can
  be influenced by an attacker ([SKILL.md](SKILL.md) §4).
- **No project ID.** Projects sharing one store can collide on note names or bleed
  into each other.
- **One writer per store**; see [one writer, many readers](adapters/reader/README.md).
- **Personal scale only.** The active set must fit the bounded index; for a large
  corpus use a retrieval system.

## Prior art & credits

Andrej Karpathy's LLM Wiki / Knowledge Base · Claude Code auto-memory · basic-memory ·
obsidian-second-brain · claude-memory-compiler · Anthropic memory tool · OpenAI Codex
memory · [agentmemory](https://github.com/rohitg00/agentmemory) · the wider
markdown-memory community. The primitives are prior art; Engramory's contribution is
the discipline and how it is put together.

## License

MIT — see [LICENSE](LICENSE).
