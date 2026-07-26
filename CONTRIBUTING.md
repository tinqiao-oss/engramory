# Contributing to Engramory

Thanks for your interest. Engramory is a small, experimental (0.x) project — a
*discipline* for agent memory, not a framework — so contributions are best kept
focused and well-tested.

## Project shape

- No build step, no dependencies beyond the Python standard library.
- The load-bearing code is `hooks/engramory_index_guard.py` (the Claude Code
  PreToolUse cap), `hooks/codex/engramory_codex_hook.py` (Codex lifecycle
  assistance), and the portable scripts in `tools/`.
- `SKILL.md` is the full protocol; `README.md` / `README.zh-CN.md` are the front
  door; `PORTING.md` covers non-Claude-Code hosts.

## Running the tests

Requires **Python 3.9+**. From the repo root:

```sh
python -m pytest tests -q
```

The two original standalone suites still work with
`python tests/test_index_guard.py` and `python tests/test_tools.py`; each prints
`ALL PASS`. Every behavioral change to a hook, installer, or tool should come
with a test.

## Guidelines

- **Preserve each hook's failure contract.** The Claude Code index guard must
  never emit `allow` or crash a user's edit. An unexpected failure passes
  silently; an index that exists but cannot be read allows the edit with a
  visible "cap NOT verified" warning, because silently predicting from an empty
  base would let a growing Edit through unnoticed. The Codex
  lifecycle hook may block only an explicit manual compaction with unsynchronized
  state. Automatic, missing, or unknown compaction triggers fail open visibly.
- **Don't oversell reliability.** Hooks enforce bounded mechanical gates, not
  semantic memory quality. Codex project discovery, trust, and real-host
  execution must be verified with `/hooks`; the discipline remains
  best-effort. Keep docs honest (see `SKILL.md` §8).
- **Keep both READMEs in sync.** A change to `README.md` should be mirrored in
  `README.zh-CN.md` (and vice versa).
- **No secrets or machine-local detail** in examples, templates, or memory: the
  store is plain text (see `SECURITY.md`).

## Reporting bugs / ideas

Open a GitHub issue with a minimal repro (for the hook: the `tool_input` payload
and the index state). Security-sensitive reports: see `SECURITY.md`.
