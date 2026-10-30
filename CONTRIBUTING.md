# Contributing to Engramory

Engramory is small, a *discipline* for agent memory rather than a framework, so keep
contributions focused and tested.

## Project shape

- No build step and no dependencies beyond the Python standard library, plus Node's
  built-ins for the dsh plugin (`adapters/dsh/plugin/`, plain ESM, Node ≥18).
- The load-bearing code: `hooks/engramory_index_guard.py` (Claude Code cap),
  `hooks/codex/engramory_codex_hook.py` (Codex lifecycle assistance),
  `adapters/dsh/plugin/index.js` (dsh plugin), and the scripts in `tools/`.
- `SKILL.md` is the full protocol; `README.md` (Chinese) / `README.en.md` are the front
  door; `PORTING.md` covers other hosts.
- The repo-root `package.json` is a discovery manifest only (registry crawlers look for
  `dsh.bundle` at the root): `private: true`, never published.
- **One version number** covers the repo and the plugin: a release bumps the plugin's
  `package.json`, the root one, the newest CHANGELOG heading and both root READMEs'
  status lines together (`tests/test_dsh_plugin.py` pins them), and ships as tag
  `vX.Y.Z` and npm `X.Y.Z`, even when only one side changed.

## Running the tests

Python 3.9+, from the repo root:

```sh
python -m pytest tests -q
```

Each suite also runs as a plain script (`python tests/test_<name>.py`), which is how CI
runs them. The dsh plugin's tests run with `node --test adapters/dsh/plugin` (or
through `python tests/test_dsh_plugin.py`). Every behavioral change to a hook,
installer, plugin or tool should come with a test.

## Guidelines

- **Keep each hook's failure contract.** The Claude Code guard never emits `allow` and
  never crashes an edit: an unexpected failure passes silently; an index that exists
  but cannot be read passes with a visible "cap NOT verified" warning. The Codex hook
  may block only an explicit manual compaction with unsynced state; automatic, missing
  or unknown triggers fail open visibly.
- **Don't oversell reliability.** Hooks enforce bounded mechanical gates, not memory
  quality; the discipline stays best-effort (`SKILL.md` §8).
- **Keep both READMEs in sync.** A change to `README.md` (Chinese) should be mirrored in
  `README.en.md` (and vice versa), at the repo root and in `adapters/dsh/plugin/`.
- **No secrets or machine-local detail** in examples or templates (see `SECURITY.md`).

## Reporting bugs / ideas

Open a GitHub issue with a minimal repro (for the hook: the `tool_input` payload and the
index state). Security-sensitive reports: see `SECURITY.md`.
