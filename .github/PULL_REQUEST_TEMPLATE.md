<!-- Thanks for contributing to Engramory. Keep PRs focused and well-tested — see CONTRIBUTING.md. -->

## What & why


## Checklist
- [ ] **Both READMEs in sync** — a change to `README.md` is mirrored in `README.zh-CN.md` (and vice versa).
- [ ] **Tests added/updated** and `python tests/test_index_guard.py` + `python tests/test_tools.py` both print `ALL PASS` (also runnable via `pytest -q`).
- [ ] **Docs stay honest** — no overselling reliability; only the Claude Code hook is deterministic (`SKILL.md` §8).
- [ ] **Hook invariants preserved** — never emits `allow`, never crashes an edit (fails open on unexpected input).
- [ ] **No secrets / machine-local detail** in examples, templates, or memory.
- [ ] **CHANGELOG.md updated** if this is a user-visible change.
