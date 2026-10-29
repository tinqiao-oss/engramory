[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-engramory

[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Ftinqiao-oss__engramory.json)](https://unstone.github.io/dsh-xray/registry.html#tinqiao-oss__engramory)

Curated, file-based long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
plain markdown notes you can open with anything,
[one writer and many readers](../../reader/README.md) across hosts, and a pre-write
index guard for matched file tools. (If the store
lives inside a project's git repo it must be git-ignored — memories carry machine-local
detail; see SKILL.md §1. A *dedicated private* repo for the store itself is fine.)

Part of [Engramory](https://github.com/tinqiao-oss/engramory).

## Why a plugin, when an `AGENTS.md` block already works

The block does carry the discipline, and for recall that is enough. Two things it cannot
do:

**The cap becomes deterministic for matched tools.** `ctx.tools.guard()` is a
synchronous, **monotonic** refusal: once a guard returns a reason, later listeners
cannot allow the call. This keeps the index within its configured growth limits
without relying on the agent to run a checker. Use **`dsh-engramory >= 0.2.7`**;
[PORTING.md](../../../PORTING.md) records which hosts have shipped guards, and
[CHANGELOG.md](../../../CHANGELOG.md) holds release history.

**The protocol arrives with the plugin.** The skill is registered at runtime through
dsh's skill registry — via a reactive `ctx.inject(['skills'], …)` child, so a profile
without a registry still gets the cap and one whose registry activates late still gets
the skill — which means it does not depend on landing files in one of the five skill
roots dsh scans, a path that is easy to get subtly wrong and fails silently when you do.

## Install

Zero-dependency ESM with no build step; requires Node.js 18+ and `pnpm` on PATH
for dsh's plugin command.

```sh
dsh plugin --profile <name> add dsh-engramory
```

Check `dsh.compatibility.dshReleases` in [`package.json`](package.json) for the
exact compatible releases, backed by [`results.json`](../../../tests/dsh_e2e/results.json).
Use the [E2E guide](../../../tests/dsh_e2e/README.md) to verify another release.

The package ships a `dsh.bundle` manifest pointing at its own
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

To uninstall:

```sh
dsh plugin --profile <name> remove dsh-engramory
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `indexName` | `MEMORY.md` | Basename treated as the memory index (case-insensitive; both `file_path` and `str_replace_editor`'s `path` are checked) — the name a write is called by, or the name of the file it lands on, so a symlink under another name is caught too. An empty or non-string value falls back to the default. |
| `maxLines` | `200` | Hard line cap. Non-positive or non-finite values fall back to the default. |
| `maxBytes` | `25600` | Hard UTF-8 byte cap (25 KB). |
| `indexPath` | unset | Absolute path of the ONE index to guard. Without it the guard matches on basename alone, so an unrelated `MEMORY.md` in another project is gated too; set this and only that exact file is. Compared by identity — the file the write lands on, whatever it is called (symlinks and `..` resolved; case-folded on Windows only) — and a path that does not exist yet still has its first write guarded. |
| `registerSkill` | `true` | Set `false` to keep the cap but skip the runtime skill. |
| `skill` | built-in | Replace the skill body with your own markdown. |

## What the guard actually does

| Call | Decision |
|---|---|
| `write` (or `str_replace_editor` `create`) ending within caps | allow |
| `write`/`create` that GROWS the index past a cap | **deny**, naming the numbers and what to compact |
| `write`/`create` that SHRINKS or keeps an over-cap index | allow — incremental compaction (210 → 205 → 198) must stay possible |
| Edit carrying `old_str`/`new_str`: result simulated | judged by the RESULT, same grow/shrink rule as a write — sized before it is built, so a `replace_all` whose result would be too long to build is judged on lower bounds of its bytes and lines |
| Unsimulable partial (e.g. `insert`) on an over-cap index | **deny**, telling the agent a shrinking whole-file write passes |
| Unsimulable partial on a healthy index | allow |
| `read`, `view`, or any unknown tool | allow — recall must never be blocked, even over cap |
| Any write to any other file | allow — not the guard's business |
| Missing/unreadable current index on a whole-file write | treated as EMPTY (mirrors the Python guard) — a within-caps write passes, an over-cap first write is refused |
| Missing/unreadable index on a partial edit | allow — a guard must never block work over a path it cannot read |
| A FIFO, device, or directory under the index's name | never read — counts as unreadable (a read there would hang or flood the host, which runs guards on its main thread) |
| An index past the read limit (`min(16 MiB, max(1 MiB, 4 × maxBytes))`) | not read whole: a whole-file write is judged on bytes against the filesystem's size (every shrink passes; its line count is unknown, so lines are not capped there), and an edit passes unmeasured, as on an unreadable index |
| Malformed execution (no arguments, non-string path/content) | allow — not recognisably a write |

For measured results, deny only a dimension that is over its cap AND grew past
the current file. The line count ignores a trailing newline, so an index exactly
at the cap stays writable. This decision table is pinned by `node --test` in CI.

Relative paths use the session's `workingDirectory` service when available,
falling back to the process cwd. Edits match LF-normalised text and preserve the
file's line endings when sizing the result, including CRLF bytes.

## Known limits

- **Unsimulable partial edits can cross the cap from below.** On a readable,
  already-over-cap index they are denied; use a shrinking whole-file write to
  compact. Missing/unreadable files and the read-limit exceptions are listed above.
  Run `engramory_check.py` after index edits and `engramory_doctor.py` periodically.
- **Coverage is limited to known file tools:** `write`/`edit` with `file_path`,
  `str_replace`/`insert`, and mutating `str_replace_editor` commands with `path`.
  Unknown tools pass. **Shell tools, MCP file tools, and external editors bypass
  the guard.**
- dsh's plugin API can change. The plugin uses `ctx.tools.guard()` and two reactive
  `ctx.inject()` children for the skill registry and session working directory;
  a compatible-release declaration needs recorded host evidence, not just unit tests.

## License

MIT — see the [Engramory repository](https://github.com/tinqiao-oss/engramory).
