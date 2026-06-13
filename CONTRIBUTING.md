# Contributing to Engramory

Thanks for your interest. Engramory is a small, experimental (0.x) project — a
*discipline* for agent memory, not a framework — so contributions are best kept
focused and well-tested.

## Project shape

- No build step, no dependencies beyond the Python standard library.
- The load-bearing code is `hooks/engramory_index_guard.py` (the Claude Code
  PreToolUse cap) plus the two portable scripts in `tools/`.
- `SKILL.md` is the full protocol; `README.md` / `README.zh-CN.md` are the front
  door; `PORTING.md` covers non-Claude-Code hosts.

## Running the tests

Requires **Python 3.8+**. From the repo root:

```sh
python tests/test_index_guard.py   # the hook
python tests/test_tools.py         # engramory_check + engramory_doctor
```

Both print `ALL PASS` on success (they also run under `pytest -q` if you prefer).
Every behavioral change to the hook or the tools should come with a test.

## Guidelines

- **Keep the hook fail-safe.** It must never emit `allow` (that auto-approves a
  tool call) and must never crash a user's edit — on any unexpected error it
  fails open silently. Preserve those invariants.
- **Don't oversell reliability.** Only the Claude Code hook is deterministic; the
  discipline is best-effort. Keep docs honest (see `SKILL.md` §8).
- **Keep both READMEs in sync.** A change to `README.md` should be mirrored in
  `README.zh-CN.md` (and vice versa).
- **No secrets or machine-local detail** in examples, templates, or memory: the
  store is plain text (see `SECURITY.md`).

## Reporting bugs / ideas

Open a GitHub issue with a minimal repro (for the hook: the `tool_input` payload
and the index state). Security-sensitive reports: see `SECURITY.md`.
