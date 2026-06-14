"""
Tests for tools/engramory_check.py and tools/engramory_doctor.py.

Standard pytest (test_* + tmp_path), also runnable directly:
    python tests/test_tools.py
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CHECK = os.path.normpath(os.path.join(HERE, "..", "tools", "engramory_check.py"))
DOCTOR = os.path.normpath(os.path.join(HERE, "..", "tools", "engramory_doctor.py"))


def _run(script, *args, env=None):
    e = dict(os.environ)
    if env:
        e.update(env)
    p = subprocess.run([sys.executable, script, *args], capture_output=True, text=True, env=e)
    return p.returncode, (p.stdout or "").strip()


# --- engramory_check (layer-2 degradation) ---

def test_check_ok(tmp_path):
    idx = tmp_path / "MEMORY.md"
    idx.write_text("\n".join(["L"] * 50), encoding="utf-8")
    rc, out = _run(CHECK, str(idx))
    assert rc == 0 and out.startswith("OK")


def test_check_warn(tmp_path):
    idx = tmp_path / "MEMORY.md"
    idx.write_text("\n".join(["L"] * 160), encoding="utf-8")
    rc, out = _run(CHECK, str(idx))
    assert rc == 1 and out.startswith("WARN")


def test_check_over_lines(tmp_path):
    idx = tmp_path / "MEMORY.md"
    idx.write_text("\n".join(["L"] * 250), encoding="utf-8")
    rc, out = _run(CHECK, str(idx))
    assert rc == 2 and out.startswith("OVER")


def test_check_over_bytes(tmp_path):
    idx = tmp_path / "MEMORY.md"
    idx.write_text("z" * 30000, encoding="utf-8")  # 1 line, ~29 KB
    rc, out = _run(CHECK, str(idx))
    assert rc == 2 and out.startswith("OVER")


def test_check_env_override(tmp_path):
    idx = tmp_path / "MEMORY.md"
    idx.write_text("\n".join(["L"] * 130), encoding="utf-8")
    rc, out = _run(CHECK, str(idx), env={"ENGRAMORY_HARD": "120"})
    assert rc == 2 and out.startswith("OVER")


# --- engramory_doctor (layer-4 backstop) ---

def _note(p, name, ntype="reference", desc="a note", body="body"):
    p.write_text(f"---\nname: {name}\ndescription: {desc}\ntype: {ntype}\n"
                 f"created: 2026-01-01\nupdated: 2026-01-01\n---\n{body}\n", encoding="utf-8")
    return p


def test_doctor_clean(tmp_path):
    _note(tmp_path / "a-note.md", "a-note")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [A](a-note.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 0 and "clean" in out


def test_doctor_broken_pointer(tmp_path):
    (tmp_path / "MEMORY.md").write_text("# Index\n- [Gone](missing.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "missing" in out


def test_doctor_orphan(tmp_path):
    (tmp_path / "orphan.md").write_text("nobody links me", encoding="utf-8")
    (tmp_path / "MEMORY.md").write_text("# Index\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "orphan" in out


def test_doctor_oversize(tmp_path):
    (tmp_path / "x.md").write_text("x", encoding="utf-8")
    (tmp_path / "MEMORY.md").write_text("\n".join(["- [x](x.md) — h"] * 250), encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "over cap" in out


def test_doctor_forward_ref_is_info_not_issue(tmp_path):
    # a [[wikilink]] with no target file yet is allowed (forward-ref stub) -> still clean
    _note(tmp_path / "a-note.md", "a-note", body="see [[future-note]]")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [A](a-note.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 0 and "clean" in out


# --- 0.1.2 hardening regressions ---

def test_check_no_arg(tmp_path):
    rc, out = _run(CHECK)  # no path argument
    assert rc == 64 and out.startswith("usage")


def test_check_unreadable(tmp_path):
    rc, out = _run(CHECK, str(tmp_path / "nope.md"))  # missing path
    assert rc == 66 and "cannot read" in out


def test_doctor_excludes_templates_and_archive(tmp_path):
    (tmp_path / "templates").mkdir()
    (tmp_path / "templates" / "MEMORY.md").write_text("# scaffold\n", encoding="utf-8")
    (tmp_path / "templates" / "example.md").write_text("x", encoding="utf-8")
    (tmp_path / "archive").mkdir()
    (tmp_path / "archive" / "old.md").write_text("retired", encoding="utf-8")
    _note(tmp_path / "a-note.md", "a-note")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [A](a-note.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 0 and "clean" in out  # templates/ & archive/ notes not flagged orphan


def test_doctor_sibling_templates_dir_is_checked(tmp_path):
    # a sibling dir whose name merely STARTS WITH 'templates' must NOT be excluded
    (tmp_path / "templates-old").mkdir()
    (tmp_path / "templates-old" / "stray.md").write_text("orphan", encoding="utf-8")
    (tmp_path / "MEMORY.md").write_text("# Index\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "orphan" in out and "stray.md" in out


def test_doctor_anchored_pointer_resolves(tmp_path):
    _note(tmp_path / "a-note.md", "a-note")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [A](a-note.md#section) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 0 and "clean" in out  # anchor stripped, note counts as referenced


def test_doctor_external_md_url_not_flagged(tmp_path):
    _note(tmp_path / "a-note.md", "a-note")
    (tmp_path / "MEMORY.md").write_text(
        "# Index\n- [A](a-note.md) — hook\n\nSee [spec](https://example.com/page.md).\n",
        encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 0 and "clean" in out  # external .md URL is not a missing local file


def test_doctor_duplicate_slug_reported(tmp_path):
    (tmp_path / "sub1").mkdir()
    (tmp_path / "sub2").mkdir()
    (tmp_path / "sub1" / "dup.md").write_text("one", encoding="utf-8")
    (tmp_path / "sub2" / "dup.md").write_text("two", encoding="utf-8")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [D](sub1/dup.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "duplicate" in out  # second dup.md must not be silently masked


def test_doctor_wrong_subpath_pointer_flagged(tmp_path):
    # real note at root/a.md, but the index points to sub/a.md (does NOT exist):
    # must be flagged missing (a loose basename match would have hidden it).
    (tmp_path / "a.md").write_text("body", encoding="utf-8")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [A](sub/a.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "missing" in out and "sub/a.md" in out


def test_doctor_pointer_escaping_root_flagged(tmp_path):
    # a pointer resolving outside the store root must be flagged, not silently followed.
    (tmp_path / "MEMORY.md").write_text("# Index\n- [Out](../outside.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "escapes the store root" in out


# --- 0.1.4 protocol-lint (doctor schema validation) ---

def test_doctor_invalid_type_is_issue(tmp_path):
    _note(tmp_path / "a-note.md", "a-note", ntype="bogus")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [A](a-note.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "invalid type" in out


def test_doctor_missing_description_is_issue(tmp_path):
    (tmp_path / "a-note.md").write_text("---\nname: a-note\ntype: reference\n---\nbody\n", encoding="utf-8")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [A](a-note.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "description" in out


def test_doctor_no_frontmatter_is_issue(tmp_path):
    (tmp_path / "a-note.md").write_text("just a body, no frontmatter\n", encoding="utf-8")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [A](a-note.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "frontmatter" in out


def test_doctor_name_mismatch_is_info(tmp_path):
    _note(tmp_path / "a-note.md", "WRONG-NAME")  # name != slug -> info, exit still 0
    (tmp_path / "MEMORY.md").write_text("# Index\n- [A](a-note.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 0 and "filename slug" in out and "clean" in out


def test_doctor_feedback_missing_whyhow_is_issue(tmp_path):
    _note(tmp_path / "fb.md", "fb", ntype="feedback", body="do the thing")  # no Why/How (MUST)
    (tmp_path / "MEMORY.md").write_text("# Index\n- [F](fb.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "Why:" in out


def test_doctor_feedback_with_whyhow_clean(tmp_path):
    _note(tmp_path / "fb.md", "fb", ntype="feedback",
          body="do it\n\n**Why:** reason\n**How to apply:** step")  # bold variant tolerated
    (tmp_path / "MEMORY.md").write_text("# Index\n- [F](fb.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 0 and "clean" in out


def test_doctor_missing_dates_is_issue(tmp_path):
    (tmp_path / "a-note.md").write_text("---\nname: a-note\ndescription: x\ntype: reference\n---\nbody\n", encoding="utf-8")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [A](a-note.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "missing required 'created'" in out


def test_doctor_impossible_date_is_issue(tmp_path):
    (tmp_path / "a-note.md").write_text(
        "---\nname: a-note\ndescription: x\ntype: reference\ncreated: 2026-99-99\nupdated: 2026-01-01\n---\nbody\n",
        encoding="utf-8")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [A](a-note.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "not a valid" in out and "2026-99-99" in out


def test_doctor_unclosed_quote_is_issue(tmp_path):
    (tmp_path / "a-note.md").write_text(
        "---\nname: a-note\ndescription: \"oops no close\ntype: reference\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\nbody\n",
        encoding="utf-8")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [A](a-note.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 1 and "unclosed quote" in out


def test_doctor_name_hyphen_underscore_tolerated(tmp_path):
    # host convention: '-' in name, '_' in filename (e.g. Claude Code) -> not flagged
    _note(tmp_path / "a_b_c.md", "a-b-c")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [X](a_b_c.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 0 and "filename slug" not in out and "clean" in out


def test_doctor_linked_but_not_in_index_is_info(tmp_path):
    # a.md is indexed and wikilinks b.md; b.md is NOT in the index -> info (won't load at start)
    _note(tmp_path / "a.md", "a", body="see [[b]]")
    _note(tmp_path / "b.md", "b")
    (tmp_path / "MEMORY.md").write_text("# Index\n- [A](a.md) — hook\n", encoding="utf-8")
    rc, out = _run(DOCTOR, str(tmp_path))
    assert rc == 0 and "not in MEMORY.md" in out and "clean" in out


# --- direct runner (no pytest) ---

def _main():
    import tempfile, shutil, pathlib
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    print(f"running {len(tests)} tool tests")
    failed = 0
    for fn in tests:
        d = pathlib.Path(tempfile.mkdtemp(prefix="engo-t-"))
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
    print("\nALL PASS" if failed == 0 else f"\n{failed} FAILED")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_main())
