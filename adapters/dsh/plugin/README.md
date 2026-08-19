[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-engramory

[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Ftinqiao-oss__engramory.json)](https://unstone.github.io/dsh-xray/registry.html#tinqiao-oss__engramory)

<sub>`C2` is the level `manifest.bundle.patch` puts every mountable dsh plugin at (74.6% of the scanned ecosystem); it is the only flag on this card — no `exec`, `eval`, install script, outbound domain, or environment read.</sub>

Curated, file-based long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
plain markdown notes you can open with anything, one store shared across every host you
use, and an index cap that is a **real refusal** rather than a request. (If the store
lives inside a project's git repo it must be git-ignored — memories carry machine-local
detail; see SKILL.md §1. A *dedicated private* repo for the store itself is fine.)

Part of [Engramory](https://github.com/tinqiao-oss/engramory).

## Why a plugin, when an `AGENTS.md` block already works

The block does carry the discipline, and for recall that is enough. Two things it cannot
do:

**The cap becomes deterministic.** Engramory keeps its index under 200 lines / 25 KB
because the index loads every session and everything past the cap silently stops being
recalled. On most hosts that limit is rules plus a checker the agent has to remember to
run. dsh exposes `ctx.tools.guard()` — a synchronous, **monotonic** refusal: once a guard
returns a reason, no later listener can turn it back into an allow. So here the limit is
enforced, not requested. Use **0.2.1 or later**: 0.2.0 shipped before profile installs
worked upstream and carried an `inject` declaration this Cordis does not accept — it
installed but never activated (issue #8). Outside Claude Code, dsh is the first host with
the shim actually written (a few others expose equivalent pre-write seams — see
PORTING.md — but have no shim yet).

**The protocol arrives with the plugin.** The skill is registered at runtime through
dsh's skill registry — via a reactive `ctx.inject(['skills'], …)` child, so a profile
without a registry still gets the cap and one whose registry activates late still gets
the skill — which means it does not depend on landing files in one of the five skill
roots dsh scans, a path that is easy to get subtly wrong and fails silently when you do.

## Install

```sh
dsh plugin --profile <name> add dsh-engramory
```

That is the whole install. The package ships a `dsh.bundle` manifest pointing at its own
`cordis.patch.yml`, so the row is inserted into the profile's plugin tree for you — no
hand-editing. To change a default, patch the EXISTING row by id in your profile's own
patch layer — do **not** use a second `- insert:` (insert always appends, so you would
end up with two engramory rows and the original caps still enforced):

```yaml
- id: engramory
  config:
    indexName: MEMORY.md
    maxLines: 200
    maxBytes: 25600
```

A patch replaces the targeted row's whole `config`, so list every key you mean to keep.

For the store itself and the always-on block, use the installer in the Engramory repo
(`python tools/engramory_init.py dsh --install-skill`). This plugin enforces the cap and
supplies the protocol; it does not create the store.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `indexName` | `MEMORY.md` | Basename treated as the memory index (case-insensitive; both `file_path` and `str_replace_editor`'s `path` are checked). An empty or non-string value falls back to the default. Nothing else is inspected. |
| `maxLines` | `200` | Hard line cap. Non-positive or non-finite values fall back to the default. |
| `maxBytes` | `25600` | Hard UTF-8 byte cap (25 KB). |
| `indexPath` | unset | Absolute path of the ONE index to guard. Without it the guard matches on basename alone, so an unrelated `MEMORY.md` in another project is gated too; set this and only that exact file is. Compared by identity (symlinks and `..` resolved; case-folded on Windows only), and a path that does not exist yet still has its first write guarded. |
| `registerSkill` | `true` | Set `false` to keep the cap but skip the runtime skill. |
| `skill` | built-in | Replace the skill body with your own markdown. |

## What the guard actually does

| Call | Decision |
|---|---|
| `write` (or `str_replace_editor` `create`) ending within caps | allow |
| `write`/`create` that GROWS the index past a cap | **deny**, naming the numbers and what to compact |
| `write`/`create` that SHRINKS or keeps an over-cap index | allow — incremental compaction (210 → 205 → 198) must stay possible |
| Edit carrying `old_str`/`new_str`: result simulated | judged by the RESULT, same grow/shrink rule as a write |
| Unsimulable partial (e.g. `insert`) on an over-cap index | **deny**, telling the agent a shrinking whole-file write passes |
| Unsimulable partial on a healthy index | allow |
| `read`, `view`, or any unknown tool | allow — recall must never be blocked, even over cap |
| Any write to any other file | allow — not the guard's business |
| Missing/unreadable current index on a whole-file write | treated as EMPTY (mirrors the Python guard) — a within-caps write passes, an over-cap first write is refused |
| Missing/unreadable index on a partial edit | allow — a guard must never block work over a path it cannot read |
| Malformed execution (no arguments, non-string path/content) | allow — not recognisably a write |

The deny rule mirrors `hooks/engramory_index_guard.py` exactly: refuse only a result
that is over a cap AND grew past the current file. The line count ignores a trailing
newline, so an index sitting exactly at the cap stays writable.

## Known limits

- **An unsimulable partial that crosses the cap from under it is not caught.** `insert`
  and friends do not carry the resulting text. The breach is caught by the next
  whole-file write, or by `engramory_check.py`. What is guaranteed: an already-over
  index cannot be grown further, and a shrinking write always passes.
- **The tool roster follows dsh's documented tool-fs contract** (`write`/`edit` with
  `file_path`, `str_replace_editor` with `path`) and is deliberately conservative:
  unknown tools pass.
- **0.2.0 never activated; 0.2.1 is the first version that runs.** While the rc.6
  preview bug blocked all third-party profile installs upstream, the only coverage a
  plugin could have was mocks — and 0.2.0's mock hid two activation bugs: an
  older-Cordis `{ required, optional }` inject shape (read as waiting for services
  literally named `required`/`optional`, pending forever) and a bare `ctx.skills` read
  of an undeclared service (throws under Cordis' reflective context). The first field
  install caught both the moment installs became possible (issue #8). 0.2.1 fixes them,
  verified end to end on a live dsh 0.1.0-rc.7 web profile (0.2.0 reproduces the boot
  failure byte for byte; 0.2.1 boots and serves) and against the vendored
  `@deepseek-ai/cordis` resolver (activation with, without, and with a late-mounted
  skill registry). The test mock now mirrors the reflective-context access rules, and
  the guard's decision table stays covered by `node --test` (28 cases, run in
  Engramory's CI).
- dsh is a developer preview and its plugin API can change. This plugin deliberately
  touches only `ctx.tools.guard()` and a reactive `ctx.inject(['skills'], …)` child
  that registers the skill, so it stays cheap to fix.

## License

MIT — see the [Engramory repository](https://github.com/tinqiao-oss/engramory).
