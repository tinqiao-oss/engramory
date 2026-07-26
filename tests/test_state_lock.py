"""Concurrency semantics of the Codex sync state lock.

Separate from test_codex_hooks.py, which is deliberately black-box: mutual
exclusion has no CLI surface, so these tests drive `_state_lock` directly and use
a REAL second process — the failure they guard against (two writers inside the
critical section at once) cannot be reproduced any other way.

    python tests/test_state_lock.py
"""
import importlib.util
import os
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SYNC = REPO_ROOT / "tools" / "engramory_sync.py"

# A holder that takes the lock, announces it, then sleeps — so the parent can test
# what happens while another process is genuinely inside the critical section.
_HOLDER = (
    "import importlib.util,sys,time;"
    "s=importlib.util.spec_from_file_location('sy',sys.argv[1]);"
    "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
    "ctx=m._state_lock(__import__('pathlib').Path(sys.argv[2]));ctx.__enter__();"
    "print('HELD',flush=True);time.sleep(60)"
)


def _sync():
    spec = importlib.util.spec_from_file_location("_sync_under_test", SYNC)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _start_holder(root):
    proc = subprocess.Popen(
        [sys.executable, "-c", _HOLDER, str(SYNC), str(root)],
        stdout=subprocess.PIPE, text=True)
    assert proc.stdout.readline().strip() == "HELD"
    return proc


def test_live_holder_is_never_displaced_however_long_it_pauses(tmp_path):
    # The replaced scheme declared a lock stale after 30s of mtime age and unlinked
    # it, so a writer that merely PAUSED was displaced and both processes then ran
    # the same read/modify/write. Age must not decide ownership; liveness must.
    m = _sync()
    holder = _start_holder(tmp_path)
    try:
        lock = tmp_path / m.LOCK_FILENAME
        stale = time.time() - 10_000
        os.utime(lock, (stale, stale))  # far past any plausible staleness window
        try:
            with m._state_lock(tmp_path, timeout=0.4):
                raise AssertionError("took a lock still held by a live process")
        except m.SyncError as exc:
            assert "timed out" in str(exc)
    finally:
        holder.kill()
        holder.wait()


def test_lock_is_released_when_its_holder_dies(tmp_path):
    # Automatic recovery from a crash is the one real problem the stale-takeover
    # solved, so removing the takeover must not reintroduce a wedged store: the
    # kernel drops the lock with the process.
    m = _sync()
    holder = _start_holder(tmp_path)
    holder.kill()
    holder.wait()
    deadline = time.monotonic() + 5.0
    while True:
        try:
            with m._state_lock(tmp_path, timeout=0.5):
                return  # acquired after the holder died
        except m.SyncError:
            if time.monotonic() >= deadline:
                raise AssertionError("lock stayed held after its owner died")
            time.sleep(0.05)


def test_lock_is_reusable_across_sequential_holders(tmp_path):
    m = _sync()
    for _ in range(3):
        with m._state_lock(tmp_path):
            pass


def test_fallback_file_lock_is_still_exclusive(tmp_path):
    # Neither backend exists (not CPython on POSIX/Windows): degrade to an
    # exclusive-CREATE marker. It can strand on a crash, but it must never
    # displace a live writer.
    m = _sync()
    m._fcntl = None
    m._msvcrt = None
    with m._state_lock(tmp_path):
        try:
            with m._state_lock(tmp_path, timeout=0.2):
                raise AssertionError("fallback lock allowed a second writer")
        except m.SyncError as exc:
            assert "timed out" in str(exc)
    with m._state_lock(tmp_path):  # released cleanly
        pass


def _main():
    # No pytest: CI runs these suites as plain, dependency-free scripts.
    import shutil
    import tempfile

    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    print("running {0} state-lock tests".format(len(tests)))
    failed = 0
    for fn in tests:
        tmp = Path(tempfile.mkdtemp(prefix="engo-lock-"))
        try:
            fn(tmp)
            print("  PASS  {0}".format(fn.__name__))
        except AssertionError as exc:
            failed += 1
            print("  FAIL  {0}: {1}".format(fn.__name__, exc))
        except Exception as exc:  # noqa: BLE001 - report, don't mask
            failed += 1
            print("  ERROR {0}: {1}: {2}".format(
                fn.__name__, type(exc).__name__, exc))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    print("\nALL PASS" if failed == 0 else "\n{0} FAILED".format(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_main())
