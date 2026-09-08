"""
Tests for tools/engramory_trace.py.

Standard pytest (test_* + tmp_path), also runnable directly:
    python tests/test_trace.py
"""
import importlib.util
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TRACE = os.path.normpath(os.path.join(HERE, "..", "tools", "engramory_trace.py"))

_spec = importlib.util.spec_from_file_location("engramory_trace", TRACE)
trace = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(trace)


def _run(*args, env=None):
    e = dict(os.environ)
    e["TERM"] = "dumb"  # keep ANSI out of the asserted output
    if env:
        e.update(env)
    p = subprocess.run([sys.executable, TRACE, *args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", env=e)
    return p.returncode, ((p.stdout or "") + (p.stderr or "")).strip()


def _rec(role, blocks, ts="2026-01-15T10:00:00.000Z"):
    return json.dumps({"type": role, "timestamp": ts, "message": {"role": role, "content": blocks}})


def _project(tmp_path, name="proj", lines=(), session="aaaaaaaa-1111-2222-3333-444444444444"):
    """Build a fake transcript root with one project and one session."""
    root = tmp_path / "projects"
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{session}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return root


# --- basic search ---

def test_finds_a_hit_and_exits_zero(tmp_path):
    root = _project(tmp_path, lines=[
        _rec("user", "why did we drop the streaming parser"),
        _rec("assistant", [{"type": "text", "text": "because it reordered chunks"}]),
    ])
    rc, out = _run("streaming parser", "--root", str(root), "--all", "--no-color")
    assert rc == 0
    assert "why did we drop the streaming parser" in out
    assert "1 hits in 1 sessions" in out


def test_no_hits_exits_one(tmp_path):
    root = _project(tmp_path, lines=[_rec("user", "unrelated chatter")])
    rc, out = _run("nonexistent-term", "--root", str(root), "--all", "--no-color")
    assert rc == trace.EXIT_NO_HITS
    assert "0 hits" in out


def test_missing_root_exits_66(tmp_path):
    rc, out = _run("anything", "--root", str(tmp_path / "nope"), "--all")
    assert rc == trace.EXIT_UNREADABLE
    assert "transcript root not found" in out


def test_bad_regex_exits_64(tmp_path):
    root = _project(tmp_path, lines=[_rec("user", "hello")])
    rc, out = _run("(unclosed", "--regex", "--root", str(root), "--all")
    assert rc == trace.EXIT_USAGE
    assert "bad regex" in out


def test_no_needle_prints_help(tmp_path):
    rc, out = _run("--root", str(tmp_path))
    assert rc == trace.EXIT_USAGE
    assert "usage:" in out


# --- the defining behavior: only what was actually said ---

def test_tool_result_excluded_by_default(tmp_path):
    """The whole point: a term re-injected by tool output must not bury real turns."""
    root = _project(tmp_path, lines=[
        _rec("user", [{"type": "tool_result", "tool_use_id": "t1",
                       "content": "retry wrapper retry wrapper retry wrapper"}]),
        _rec("assistant", [{"type": "text", "text": "keep the retry wrapper, it is a real fix"}]),
    ])
    rc, out = _run("retry wrapper", "--root", str(root), "--all", "--no-color")
    assert rc == 0
    assert "1 hits" in out                      # only the assistant turn
    assert "it is a real fix" in out
    assert "tool_result" not in out


def test_tools_flag_includes_tool_output(tmp_path):
    root = _project(tmp_path, lines=[
        _rec("user", [{"type": "tool_result", "tool_use_id": "t1", "content": "retry wrapper here"}]),
        _rec("assistant", [{"type": "text", "text": "keep the retry wrapper"}]),
    ])
    rc, out = _run("retry wrapper", "--tools", "--root", str(root), "--all", "--no-color")
    assert rc == 0
    assert "2 hits" in out
    assert "tool_result" in out


def test_injected_context_is_stripped(tmp_path):
    """Standing context rides inside the real user record and must not match."""
    root = _project(tmp_path, lines=[
        _rec("user", "what should I do about caching\n"
                     "<system-reminder>Project rule: always mention caching.</system-reminder>"),
    ])
    rc, out = _run("Project rule", "--root", str(root), "--all", "--no-color")
    assert rc == trace.EXIT_NO_HITS

    rc, out = _run("caching", "--root", str(root), "--all", "--no-color")
    assert rc == 0 and "1 hits" in out          # the real question still matches


def test_thinking_searched_by_default_and_excludable(tmp_path):
    root = _project(tmp_path, lines=[
        _rec("assistant", [{"type": "thinking", "thinking": "the lock ordering looks wrong"}]),
    ])
    rc, out = _run("lock ordering", "--root", str(root), "--all", "--no-color")
    assert rc == 0 and "1 hits" in out
    rc, _ = _run("lock ordering", "--no-thinking", "--root", str(root), "--all", "--no-color")
    assert rc == trace.EXIT_NO_HITS


def test_image_blocks_are_skipped(tmp_path):
    root = _project(tmp_path, lines=[
        _rec("user", [{"type": "image",
                       "source": {"type": "base64", "media_type": "image/png", "data": "QUJDcGF5bG9hZA=="}}]),
    ])
    rc, _ = _run("QUJDcGF5bG9hZA", "--tools", "--root", str(root), "--all", "--no-color")
    assert rc == trace.EXIT_NO_HITS


# --- filters ---

def test_role_filter(tmp_path):
    root = _project(tmp_path, lines=[
        _rec("user", "ship the migration"),
        _rec("assistant", [{"type": "text", "text": "ship the migration on friday"}]),
    ])
    rc, out = _run("ship the migration", "--role", "user", "--root", str(root), "--all", "--no-color")
    assert rc == 0 and "1 hits" in out and "friday" not in out


def test_date_range_filter(tmp_path):
    root = _project(tmp_path, lines=[
        _rec("user", "early note", ts="2026-01-01T09:00:00.000Z"),
        _rec("user", "late note", ts="2026-06-01T09:00:00.000Z"),
    ])
    rc, out = _run("note", "--since", "2026-03-01", "--root", str(root), "--all", "--no-color")
    assert rc == 0 and "late note" in out and "early note" not in out
    rc, out = _run("note", "--until", "2026-03-01", "--root", str(root), "--all", "--no-color")
    assert rc == 0 and "early note" in out and "late note" not in out


def test_case_insensitive_by_default_and_sensitive_with_s(tmp_path):
    root = _project(tmp_path, lines=[_rec("user", "the HTTPAdapter is missing")])
    rc, _ = _run("httpadapter", "--root", str(root), "--all", "--no-color")
    assert rc == 0
    rc, _ = _run("httpadapter", "-s", "--root", str(root), "--all", "--no-color")
    assert rc == trace.EXIT_NO_HITS


def test_prefilter_case_matches_the_matcher(tmp_path):
    """Regression: a prefilter stricter than the matcher silently drops files.

    The byte prefilter and the regex matcher must agree on case folding, or files
    the prefilter rejects never reach the matcher at all.
    """
    root = _project(tmp_path, lines=[_rec("user", "the HTTPAdapter is missing")])
    files = trace._prefilter([root / "proj"], "httpadapter", regex=False, case_sensitive=False)
    assert len(files) == 1
    files = trace._prefilter([root / "proj"], "httpadapter", regex=False, case_sensitive=True)
    assert files == []


def test_regex_mode(tmp_path):
    root = _project(tmp_path, lines=[_rec("user", "bumped to 1.42.7 today")])
    rc, out = _run(r"1\.\d+\.\d+", "--regex", "--root", str(root), "--all", "--no-color")
    assert rc == 0 and "1 hits" in out


def test_per_session_cap(tmp_path):
    root = _project(tmp_path, lines=[
        _rec("assistant", [{"type": "text", "text": f"marker line {i}"}]) for i in range(10)
    ])
    rc, out = _run("marker", "--per-session", "2", "--root", str(root), "--all", "--no-color")
    assert rc == 0
    assert "10 hits" in out                      # counted in full
    assert "raise --per-session" in out          # but truncated on screen, and says so


# --- prefilter internals ---

def test_file_contains_across_chunk_boundary(tmp_path):
    """A term split across two reads must still be found."""
    f = tmp_path / "big.jsonl"
    f.write_bytes(b"x" * 100 + b"needle" + b"y" * 100)
    assert trace._file_contains(f, b"needle", case_sensitive=True, chunk=64)
    assert not trace._file_contains(f, b"absent", case_sensitive=True, chunk=64)


def test_file_contains_non_ascii(tmp_path):
    """ASCII-only case folding must leave other scripts intact, not corrupt them."""
    f = tmp_path / "s.jsonl"
    f.write_text("决定放弃流式解析器", encoding="utf-8")
    assert trace._file_contains(f, "流式解析器".encode("utf-8"), case_sensitive=False)


def test_partial_trailing_line_is_tolerated(tmp_path):
    """A live session's last line can be half-written; that must not abort the scan."""
    root = tmp_path / "projects" / "proj"
    root.mkdir(parents=True)
    (root / "s.jsonl").write_text(
        _rec("user", "complete record about latency") + "\n{\"type\": \"user\", \"mess",
        encoding="utf-8")
    rc, out = _run("latency", "--root", str(tmp_path / "projects"), "--all", "--no-color")
    assert rc == 0 and "1 hits" in out


# --- other subcommands ---

def test_show_replays_a_session(tmp_path):
    root = _project(tmp_path, lines=[
        _rec("user", "can we cache the manifest"),
        _rec("assistant", [{"type": "thinking", "thinking": "hidden unless verbose"},
                           {"type": "text", "text": "yes, keyed by digest"}]),
    ])
    rc, out = _run("--show", "aaaaaaaa", "--root", str(root), "--no-color")
    assert rc == 0
    assert "can we cache the manifest" in out and "yes, keyed by digest" in out
    assert "hidden unless verbose" not in out
    rc, out = _run("--show", "aaaaaaaa", "-v", "--root", str(root), "--no-color")
    assert rc == 0 and "hidden unless verbose" in out


def test_show_unknown_session(tmp_path):
    root = _project(tmp_path, lines=[_rec("user", "hi")])
    rc, out = _run("--show", "zzzzzzzz", "--root", str(root))
    assert rc == trace.EXIT_NO_HITS and "no session matching" in out


def test_list_projects(tmp_path):
    root = _project(tmp_path, name="my-project", lines=[_rec("user", "hello")])
    rc, out = _run("--list-projects", "--root", str(root))
    assert rc == 0 and "my-project" in out and "1 sessions" in out


def test_project_selector_and_ambiguity(tmp_path):
    root = _project(tmp_path, name="alpha", lines=[_rec("user", "shared term here")])
    (root / "alpha-two").mkdir()
    (root / "alpha-two" / "b.jsonl").write_text(_rec("user", "shared term here") + "\n",
                                                encoding="utf-8")
    rc, out = _run("shared term", "--project", "alpha-two", "--root", str(root), "--no-color")
    assert rc == 0 and "1 hits" in out
    rc, out = _run("shared term", "--project", "alpha", "--root", str(root), "--no-color")
    assert rc == 0 and "1 hits" in out  # exact directory match wins over the substring
    rc, out = _run("shared term", "--project", "alph", "--root", str(root), "--no-color")
    assert rc == trace.EXIT_USAGE and "ambiguous project name" in out


def test_encode_project_dir():
    assert trace._encode_project_dir(trace.Path("/home/me/proj")) == "-home-me-proj"
    assert "src" in trace._encode_project_dir(trace.Path("C:/src/proj"))


def _main():
    import tempfile
    from pathlib import Path as _P
    failures = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            if fn.__code__.co_argcount:
                with tempfile.TemporaryDirectory() as td:
                    fn(_P(td))
            else:
                fn()
        except Exception as exc:  # noqa: BLE001 - report and keep going
            failures += 1
            print(f"FAIL {name}: {type(exc).__name__}: {exc}")
        else:
            print(f"ok   {name}")
    print("FAILED" if failures else "all passed")
    return 1 if failures else 0


# The direct runner must stay at the very END of this file: `_main()` collects the
# test_* names present in globals() at CALL time, so anything defined below this
# block is invisible to it — and CI runs this suite as a plain script.
if __name__ == "__main__":
    sys.exit(_main())
