# dsh-engramory

Curated, file-based long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
plain markdown notes you can read and `git log`, one store shared across every host you
use, and an index cap that is a **real refusal** rather than a request.

Part of [Engramory](https://github.com/tinqiao-oss/engramory).

## Why a plugin, when an `AGENTS.md` block already works

The block does carry the discipline, and for recall that is enough. Two things it cannot
do:

**The cap becomes deterministic.** Engramory keeps its index under 200 lines / 25 KB
because the index loads every session and everything past the cap silently stops being
recalled. On most hosts that limit is rules plus a checker the agent has to remember to
run. dsh exposes `ctx.tools.guard()` — a synchronous, **monotonic** refusal: once a guard
returns a reason, no later listener can turn it back into an allow. So here the limit is
enforced, not requested. Outside Claude Code, this is the only host where that is true.

**The protocol arrives with the plugin.** `ctx.skills.register()` contributes the skill at
runtime, so it does not depend on landing files in one of the five skill roots dsh scans —
a path that is easy to get subtly wrong and fails silently when you do.

## Install

```sh
dsh plugin --profile <name> add dsh-engramory
```

Then mount it in that profile's `cordis.patch.yml`:

```yaml
- id: engramory
  name: dsh-engramory
  config:
    indexName: MEMORY.md   # optional
```

For the store itself and the always-on block, use the installer in the Engramory repo
(`python tools/engramory_init.py dsh --install-skill`). This plugin enforces the cap and
supplies the protocol; it does not create the store.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `indexName` | `MEMORY.md` | Basename treated as the memory index. Nothing else is inspected. |
| `maxLines` | `200` | Hard line cap. Non-positive or non-finite values fall back to the default. |
| `maxBytes` | `25600` | Hard UTF-8 byte cap (25 KB). |
| `registerSkill` | `true` | Set `false` to keep the cap but skip the runtime skill. |
| `skill` | built-in | Replace the skill body with your own markdown. |

## What the guard actually does

| Call | Decision |
|---|---|
| `write` to the index, within caps | allow |
| `write` to the index, over either cap | **deny**, naming the numbers and what to compact |
| Partial edit of an index that is already over cap | **deny** — do not grow a breach |
| Partial edit of a healthy index | allow |
| Any write to any other file | allow — not the guard's business |
| Missing/unreadable index, malformed arguments | allow — a guard must never block work by accident |

The line count ignores a trailing newline, matching `hooks/engramory_index_guard.py`, so
an index sitting exactly at the cap stays writable.

## Known limits

- **An edit that crosses the cap from under it is not caught.** A partial write does not
  carry the resulting text, and a synchronous guard has no business reconstructing it.
  The breach is caught by the next whole-file write, or by `engramory_check.py`. What is
  guaranteed here is that an already-over index cannot be grown further.
- **Not yet verified end to end inside dsh.** The guard's decision table is covered by
  `node --test` (13 cases, run in Engramory's CI), and the wiring for the AGENTS.md block
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
