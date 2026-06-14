"""
Tests for hooks/engramory_index_guard.py.

Standard pytest: each `test_*` function takes pytest's built-in `tmp_path`
fixture (auto-created and auto-cleaned). The hook is run as a subprocess, exactly
how Claude Code invokes it, with a simulated PreToolUse payload on stdin.

Also runnable without pytest (this env's pytest collection can time out):
    python tests/test_index_guard.py     # exit 0 = all pass

Covers: silent pass-through, the WARN nudge (context-only, never "allow"),
the HARD cap (deny only when the edit GROWS an over-cap index), incremental
compaction (shrinking edits allowed even while over cap), the exact 200/201
boundary, byte vs line dimensions, content/file_text keys, Edit/MultiEdit delta
prediction, env overrides, and fail-open on bad input.
"""
import json
import os
import subprocess
import sys

HOOK = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "hooks",
    "engramory_index_guard.py"))


def _run(idx, payload, env=None):
    """Run the hook with `payload` on stdin; return (rc, parsed_stdout_or_None)."""
    e = dict(os.environ)
    if env:
        e.update(env)
    p = subprocess.run([sys.executable, HOOK], input=json.dumps(payload),
                       capture_output=True, text=True, env=e)
    out = None
    if p.stdout.strip():
        try:
            out = json.loads(p.stdout)["hookSpecificOutput"]
        except Exception:
            out = {"_unparseable": p.stdout}
    return p.returncode, out


def _decision(out):
    if out is None:
        return "(silent)"
    return out.get("permissionDecision", "(no-decision)")


def _nudges(out):
    # a non-blocking nudge: additionalContext present, no blocking permissionDecision
    # (the hook emits context-only for warn / over-but-shrinking, never "defer"/"allow").
    return bool(out) and bool(out.get("additionalContext")) and _decision(out) not in ("deny", "allow")


def _write(idx, lines=None, nbytes=None):
    if nbytes is not None:
        idx.write_text("z" * nbytes, encoding="utf-8")
    else:
        idx.write_text("\n".join(["L"] * lines), encoding="utf-8")
    return idx


def _w(idx, content):
    return {"tool_name": "Write", "tool_input": {"file_path": str(idx), "content": content}}


def _edit(idx, old, new, replace_all=False):
    ti = {"file_path": str(idx), "old_string": old, "new_string": new}
    if replace_all:
        ti["replace_all"] = True
    return {"tool_name": "Edit", "tool_input": ti}


# --- pass-through ---

def test_non_index_file_is_silent(tmp_path):
    rc, out = _run(tmp_path, {"tool_name": "Write", "tool_input":
                              {"file_path": str(tmp_path / "other.txt"), "content": "x\n" * 500}})
    assert rc == 0 and _decision(out) == "(silent)"


def test_small_index_is_silent(tmp_path):
    idx = _write(tmp_path / "MEMORY.md", lines=40)
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 40)))
    assert rc == 0 and _decision(out) == "(silent)"


# --- WARN: context-only nudge (never auto-approve via "allow") ---

def test_warn_lines_nudges_with_context(tmp_path):
    idx = _write(tmp_path / "MEMORY.md", lines=40)
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 160)))  # 160 lines: >150 warn, <=200 hard
    assert rc == 0 and _nudges(out)  # additionalContext present, no blocking decision


def test_warn_bytes_nudges(tmp_path):
    idx = _write(tmp_path / "MEMORY.md", nbytes=1000)
    rc, out = _run(idx, _w(idx, "z" * 21000))  # ~21KB: >20KB warn, <25KB hard
    assert rc == 0 and _nudges(out)


def test_never_returns_allow(tmp_path):
    """A size guard must never emit 'allow' (that bypasses the permission prompt)."""
    idx = tmp_path / "MEMORY.md"
    payloads = [
        _w(idx, "\n".join(["L"] * 40)),    # under
        _w(idx, "\n".join(["L"] * 160)),   # warn
        _w(idx, "\n".join(["L"] * 250)),   # over hard
        _w(idx, "z" * 21000),              # warn bytes
        _w(idx, "z" * 40000),              # over hard bytes
    ]
    for p in payloads:
        _write(idx, lines=40)
        _, out = _run(idx, p)
        assert _decision(out) != "allow", f"emitted allow for {p}"


# --- HARD cap: deny only when the edit GROWS an over-cap index ---

def test_grow_over_hard_lines_denies(tmp_path):
    idx = _write(tmp_path / "MEMORY.md", lines=40)
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 250)))
    assert rc == 0 and _decision(out) == "deny"


def test_grow_over_hard_bytes_denies(tmp_path):
    idx = _write(tmp_path / "MEMORY.md", lines=40)
    rc, out = _run(idx, _w(idx, "z" * 40000))
    assert rc == 0 and _decision(out) == "deny"


def test_incremental_compaction_shrink_is_allowed(tmp_path):
    """210 -> 205 lines: still over 200, but shrinking, so must NOT be denied."""
    idx = _write(tmp_path / "MEMORY.md", lines=210)
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 205)))
    assert rc == 0 and _nudges(out)


def test_shrink_under_cap_is_silent(tmp_path):
    idx = _write(tmp_path / "MEMORY.md", lines=210)
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 140)))  # under both caps
    assert rc == 0 and _decision(out) == "(silent)"


def test_edit_shrink_over_cap_allowed(tmp_path):
    """Edit that removes lines from an over-cap index must be allowed (context-only nudge)."""
    idx = _write(tmp_path / "MEMORY.md", lines=210)
    rc, out = _run(idx, _edit(idx, "L\nL\nL\nL\nL", "L"))  # net -4 lines -> 206, shrinking
    assert rc == 0 and _nudges(out)


# --- exact boundary: 200 ok, 201 over ---

def test_boundary_200_lines_ok(tmp_path):
    idx = tmp_path / "MEMORY.md"  # new file
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 200)))
    # 200 is the last loadable line: NOT denied. It's > the 150 warn, so it nudges (context-only).
    assert rc == 0 and _nudges(out)


def test_boundary_201_lines_denies(tmp_path):
    idx = tmp_path / "MEMORY.md"  # new file (0 -> 201 = grew)
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 201)))
    assert rc == 0 and _decision(out) == "deny"


# --- payload key variants ---

def test_write_file_text_fallback_key(tmp_path):
    idx = _write(tmp_path / "MEMORY.md", lines=40)
    rc, out = _run(idx, {"tool_name": "Write", "tool_input":
                         {"file_path": str(idx), "file_text": "\n".join(["L"] * 250)}})
    assert rc == 0 and _decision(out) == "deny"


def test_edit_delta_grow_denies(tmp_path):
    idx = tmp_path / "MEMORY.md"
    idx.write_text("ANCHOR\n" + "\n".join(["L"] * 197), encoding="utf-8")  # 198 lines, ANCHOR unique
    rc, out = _run(idx, _edit(idx, "ANCHOR", "ANCHOR\nA\nB\nC\nD\nE"))  # +5 -> 203, grew
    assert rc == 0 and _decision(out) == "deny"


def test_multiedit_grow_denies(tmp_path):
    idx = tmp_path / "MEMORY.md"
    idx.write_text("A1\nA2\n" + "\n".join(["L"] * 196), encoding="utf-8")  # 198 lines; A1/A2 unique
    payload = {"tool_name": "MultiEdit", "tool_input": {"file_path": str(idx), "edits": [
        {"old_string": "A1", "new_string": "A1\nx\nx"},
        {"old_string": "A2", "new_string": "A2\ny\ny"}]}}  # +4 -> 202, grew over cap
    rc, out = _run(idx, payload)
    assert rc == 0 and _decision(out) == "deny"


# --- env overrides + fail-open ---

def test_env_override_hard(tmp_path):
    idx = _write(tmp_path / "MEMORY.md", lines=40)
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 130)),
                   env={"ENGRAMORY_HARD": "120", "ENGRAMORY_WARN": "100"})
    assert rc == 0 and _decision(out) == "deny"


def test_malformed_json_fails_open(tmp_path):
    p = subprocess.run([sys.executable, HOOK], input="{not json",
                       capture_output=True, text=True)
    assert p.returncode == 0 and not p.stdout.strip()


# --- adversarial-verify regressions ---

def test_multiedit_chained_explosion_denies(tmp_path):
    """edit2.old_string ('Q') is produced by edit1 and is absent from the original.
    Per-edit counting against the original misses it; sequential simulation catches
    the blow-up (150 -> ~30k lines) and must DENY."""
    idx = _write(tmp_path / "MEMORY.md", lines=150)
    payload = {"tool_name": "MultiEdit", "tool_input": {"file_path": str(idx), "edits": [
        {"old_string": "L", "new_string": "Q", "replace_all": True},
        {"old_string": "Q", "new_string": "Q\n" + "\n".join(["j"] * 200), "replace_all": True}]}}
    rc, out = _run(idx, payload)
    assert rc == 0 and _decision(out) == "deny"


def test_non_utf8_index_growth_denies(tmp_path):
    """A non-UTF-8 existing index must not fail-open and disable the guard."""
    idx = tmp_path / "MEMORY.md"
    idx.write_bytes(b"\xff\xfe" + b"bad\x00\x80bytes" * 60)  # invalid UTF-8
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 300)))  # clear growth past cap
    assert rc == 0 and _decision(out) == "deny"


def test_malformed_env_var_still_guards(tmp_path):
    """A bad numeric env var must fall back to the default, not turn the guard off."""
    idx = _write(tmp_path / "MEMORY.md", lines=40)
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 250)), env={"ENGRAMORY_HARD": "abc"})
    assert rc == 0 and _decision(out) == "deny"


def test_absent_old_string_not_false_denied(tmp_path):
    """An Edit whose old_string isn't in the file can't apply -> must not be denied."""
    idx = _write(tmp_path / "MEMORY.md", lines=180)  # under cap
    rc, out = _run(idx, _edit(idx, "ZZZ_NOT_PRESENT", "\n".join(["big"] * 50)))
    assert rc == 0 and _decision(out) != "deny"


# --- 0.1.2 hardening regressions ---

def test_incremental_compaction_shrink_bytes_allowed(tmp_path):
    """40 KB -> 30 KB single-line index: still over the 25 KB BYTE cap but shrinking,
    so must nudge (context-only, not deny) and inject the compaction nudge. The byte dimension is
    the hook's reason for existing, so its over-cap-shrink path must be covered too."""
    idx = _write(tmp_path / "MEMORY.md", nbytes=40000)
    rc, out = _run(idx, _w(idx, "z" * 30000))
    assert rc == 0 and _nudges(out)
    assert out.get("additionalContext")


def test_nonpositive_env_cap_falls_back_to_default(tmp_path):
    """A 0 / negative cap is nonsensical and must fall back to the default, not brick
    every edit. HARD=0 must NOT deny a small write, and must still deny a 250-line
    write via the restored default 200 cap."""
    idx = _write(tmp_path / "MEMORY.md", lines=40)
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 50)), env={"ENGRAMORY_HARD": "0"})
    assert rc == 0 and _decision(out) != "deny"
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 250)), env={"ENGRAMORY_HARD": "0"})
    assert rc == 0 and _decision(out) == "deny"


def test_never_returns_allow_edit_and_multiedit(tmp_path):
    """The 'never allow' red line must hold for Edit/MultiEdit too, not just Write."""
    idx = tmp_path / "MEMORY.md"
    payloads = [
        _edit(idx, "L", "L\nL\nL\nL", replace_all=True),  # explode over cap
        _edit(idx, "L\nL\nL", "L"),                        # shrink/no-op
        {"tool_name": "MultiEdit", "tool_input": {"file_path": str(idx), "edits": [
            {"old_string": "L", "new_string": "L\nx", "replace_all": True}]}},
    ]
    for p in payloads:
        _write(idx, lines=198)
        _, out = _run(idx, p)
        assert _decision(out) != "allow", f"emitted allow for {p}"


# --- 0.1.9 nudges/deny name the breached dimension ---

def test_warn_names_line_dimension(tmp_path):
    idx = _write(tmp_path / "MEMORY.md", lines=40)
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 160)))  # 160 lines > 150 warn, bytes under
    assert rc == 0 and _nudges(out) and "lines >" in out["additionalContext"]


def test_warn_names_byte_dimension(tmp_path):
    idx = _write(tmp_path / "MEMORY.md", nbytes=1000)
    rc, out = _run(idx, _w(idx, "z" * 21000))  # ~21 KB > 20 KB warn, 1 line (under)
    assert rc == 0 and _nudges(out) and "KB >" in out["additionalContext"]


def test_deny_names_dimension(tmp_path):
    idx = _write(tmp_path / "MEMORY.md", lines=40)
    rc, out = _run(idx, _w(idx, "\n".join(["L"] * 250)))  # grow over hard line cap
    assert rc == 0 and _decision(out) == "deny" and "lines >" in out["permissionDecisionReason"]


# --- 0.1.11 compaction must not be blocked by the under-cap dimension ---

def test_compact_lines_while_bytes_rise_is_allowed(tmp_path):
    # 210 -> 205 lines (still over the LINE cap) while bytes RISE but stay under the
    # byte cap: a real line-compaction. Only the over-cap dimension's growth blocks, so
    # this must NOT deny (regression for the old 'either dimension grew => deny' bug).
    idx = _write(tmp_path / "MEMORY.md", lines=210)            # 210 lines of 'L'
    rc, out = _run(idx, _w(idx, "\n".join(["LL"] * 205)))      # 205 lines, more bytes, < 25 KB
    assert rc == 0 and _decision(out) != "deny" and _nudges(out)


# --- 0.1.12 deny reason names only the growing dimension ---

def test_deny_reason_names_only_growing_dimension(tmp_path):
    # both dims over cap, but lines SHRINK (210->205) while bytes GROW: deny is correct
    # (bytes), and the reason must name only the byte dim — not tell the user to cut a
    # line count that is actually shrinking.
    idx = tmp_path / "MEMORY.md"
    idx.write_bytes(("\n".join(["z" * 300] * 210)).encode("utf-8"))  # 210 lines, ~63 KB
    new = "\n".join(["z" * 314] * 205)                               # 205 lines (shrank), ~64.5 KB (grew)
    rc, out = _run(idx, _w(idx, new))
    assert _decision(out) == "deny"
    r = out["permissionDecisionReason"]
    assert "KB >" in r and "lines > 200" not in r


# --- direct runner (no pytest) ---

def _main():
    import tempfile, shutil, pathlib
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    print(f"hook: {HOOK}\nrunning {len(tests)} tests\n")
    failed = 0
    for fn in tests:
        d = pathlib.Path(tempfile.mkdtemp(prefix="engramory-t-"))
        try:
            fn(d)
            print(f"  PASS  {fn.__name__}")
        except AssertionError as ex:
            failed += 1
            print(f"  FAIL  {fn.__name__}: {ex}")
        except Exception as ex:  # noqa
            failed += 1
            print(f"  ERROR {fn.__name__}: {type(ex).__name__}: {ex}")
        finally:
            shutil.rmtree(d, ignore_errors=True)
    print("\n" + ("ALL PASS" if failed == 0 else f"{failed} FAILED"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_main())
