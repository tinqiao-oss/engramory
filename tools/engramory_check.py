#!/usr/bin/env python3
"""
engramory_check — portable index-size check (the no-hard-hook degradation, layer 2).

On Claude Code the PreToolUse hook (hooks/engramory_index_guard.py) enforces the
cap deterministically on every edit. On any other host that lacks such a hook,
the agent should run THIS after writing the index, and compact if it says OVER:

    python tools/engramory_check.py <path-to-MEMORY.md>

Exit code: 0 = OK (within caps), 1 = WARN (>= soft), 2 = OVER (> hard). Error codes
(distinct from the 0/1/2 result contract, so an automated caller can tell "could
not check" from "index is fine"): 64 = usage error (no path given), 66 = the index
path could not be read. Prints a one-line verdict + advice. Caps via the same env
vars as the hook (ENGRAMORY_HARD / ENGRAMORY_WARN / ENGRAMORY_HARD_BYTES /
ENGRAMORY_WARN_BYTES).
"""
import os
import sys


def _envint(name, default):
    # Bad/empty or non-positive (0 / negative) cap -> fall back to the default,
    # matching the hook so the two layers agree.
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        val = int(raw.strip())
    except (TypeError, ValueError):
        return default
    return val if val > 0 else default


def _lines(text):
    if not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def _kb(n):
    return f"{n} B" if n < 1024 else f"{n / 1024:.1f} KB"


def _over(lines, nbytes, lcap, bcap):
    # Name the dimension(s) that crossed a cap, so the reader knows whether to cut
    # lines or bytes (the WARN/OVER text alone didn't say which tripped).
    parts = []
    if lines > lcap:
        parts.append(f"{lines} lines > {lcap}")
    if nbytes > bcap:
        parts.append(f"{_kb(nbytes)} > {_kb(bcap)}")
    return " and ".join(parts)


def _first_step(bytes_over):
    # Which compaction step pays off first given the breached dimension.
    if bytes_over:
        return "pointer-ify the longest index lines first (cuts bytes, and lines if you merge)"
    return "merge/archive notes or collapse pointers to cut the line count"


def main(argv):
    if len(argv) < 2:
        print("usage: engramory_check.py <path-to-index (MEMORY.md)>")
        return 64  # EX_USAGE — a misuse must not read as OK (exit 0) to a caller
    path = argv[1]
    hard = _envint("ENGRAMORY_HARD", 200)
    warn = _envint("ENGRAMORY_WARN", 150)
    hard_b = _envint("ENGRAMORY_HARD_BYTES", 25600)
    warn_b = _envint("ENGRAMORY_WARN_BYTES", 20480)
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as e:
        print(f"engramory: cannot read {path}: {e}")
        return 66  # EX_NOINPUT — "could not check" must be distinct from OK
    text = raw.decode("utf-8", "replace")
    lines, nbytes = _lines(text), len(raw)
    size = f"{lines} lines / {_kb(nbytes)}"
    caps = f"{hard} lines / {hard_b // 1024} KB"
    if lines > hard or nbytes > hard_b:
        print(f"OVER: index is {size} — over {_over(lines, nbytes, hard, hard_b)} "
              f"(cap {caps}), past the load window. Compact now: {_first_step(nbytes > hard_b)} "
              f"— before adding more, or the tail stops being recalled.")
        return 2
    if lines > warn or nbytes > warn_b:
        print(f"WARN: index is {size} — over {_over(lines, nbytes, warn, warn_b)} (cap {caps}). "
              f"Getting long; plan a compaction pass soon ({_first_step(nbytes > warn_b)}).")
        return 1
    print(f"OK: index is {size} (cap {caps}).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
