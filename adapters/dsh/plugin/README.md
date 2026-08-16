# dsh-engramory

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
enforced, not requested — **once the plugin is actually installed and running**; a
profile install currently fails upstream (see "Known limits"), and until then the cap on
dsh is still rules plus the checker. Outside Claude Code, dsh is the first host with the
shim actually written (a few others expose equivalent pre-write seams — see PORTING.md —
but have no shim yet).

**The protocol arrives with the plugin.** `ctx.skills.register()` contributes the skill at
runtime, so it does not depend on landing files in one of the five skill roots dsh scans —
a path that is easy to get subtly wrong and fails silently when you do.

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
  unknown tools pass. Until the plugin runs inside a real profile this mapping is
  documentation-verified only.
- **Not yet verified end to end inside dsh.** The guard's decision table is covered by
  `node --test` (21 cases, run in Engramory's CI), and the wiring for the AGENTS.md block
  and skill discovery was dogfooded against a live `deepseek-v4-flash` session. But
  installing a *third-party plugin* into a profile currently fails on dsh 0.1.0-rc.6:
  `dsh plugin` shells out to `pnpm` (not bundled), and a direct `pnpm add` then dies on
  `ERR_PNPM_FETCH_404` for `@deepseek-ai/dsh-type-meta`, a package the published tree
  depends on but which is not on the registry. That is a preview-packaging problem
  upstream, not a plugin defect; this note goes away once a profile install resolves.
- dsh is a developer preview and its plugin API can change. This plugin deliberately
  touches only `ctx.tools.guard()` and `ctx.skills.register()` so it stays cheap to fix.

## License

MIT — see the [Engramory repository](https://github.com/tinqiao-oss/engramory).
