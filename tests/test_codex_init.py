"""Tests for Codex installer stability."""

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
INIT = REPO / "tools" / "engramory_init.py"
def _run_init(project, *extra):
    proc = subprocess.run(
        [
            sys.executable,
            str(INIT),
            "codex",
            "--project-root",
            str(project),
            *map(str, extra),
        ],
        capture_output=True,
        text=True,
    )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


# --- direct runner (no pytest) ---
# CI runs the suites as plain zero-dependency scripts; without this block the file
# exits 0 silently having run NOTHING (that near-miss shipped: the suite existed
# for two releases while CI never executed a single test in it).

def test_reinstalling_is_byte_identical(tmp_path):
    """A second init must not change the rules file at all.

    The block-replacement path appended a blank-line separator even when the block
    ended the file, so the first re-run added one blank line that every later run then
    preserved - a one-line diff appearing out of nowhere in a file people keep in git.
    """
    import subprocess
    import sys as _sys

    rules = tmp_path / "AGENTS.md"
    rules.write_text("# Mine\n\nKeep this.\n", encoding="utf-8")

    def run():
        proc = subprocess.run(
            [_sys.executable, str(INIT), "codex", "--project-root", str(tmp_path)],
            capture_output=True, text=True)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        return rules.read_bytes()

    first = run()
    assert run() == first, "a second init changed the rules file"
    assert run() == first, "a third init changed the rules file"
    assert b"Keep this." in first


def _main():
    import pathlib
    import shutil
    import tempfile

    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    print(f"init: {INIT}\nrunning {len(tests)} tests\n")
    failed = 0
    for fn in tests:
        # resolve(): CI's %TEMP% is a DOS 8.3 alias (RUNNER~1); the tools
        # canonicalise to the long form, so path assertions need the same spelling.
        d = pathlib.Path(tempfile.mkdtemp(prefix="engramory-ci-")).resolve()
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
