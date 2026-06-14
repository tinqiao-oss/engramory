#!/usr/bin/env python3
"""
Engramory index-size guard — a Claude Code PreToolUse hook.

Keeps the memory index (MEMORY.md) from growing past the window the host actually
loads. Claude Code loads the first 200 lines / 25 KB of MEMORY.md at the start of
every conversation (documented behavior; configurable below for other hosts), so
anything past EITHER limit silently stops being recalled. Lines alone are not
enough: an index can be well under the line cap yet over the byte cap because its
lines are long (content leaked into the index). This hook predicts the index size
*after* the pending edit on BOTH dimensions, then:

  - over a HARD cap AND the edit GROWS the index -> DENY (compact first; SKILL §6).
  - over a cap but the edit SHRINKS/keeps size (compaction in progress), or only
    over the WARN cap -> inject a non-blocking nudge to compact via
    additionalContext with NO permissionDecision (omitting the decision = "no
    opinion -> normal permission flow", the documented way to add context without
    affecting the decision; unambiguous across interactive & non-interactive
    modes). It never returns "allow" (which AUTO-APPROVES and bypasses the user's
    permission prompt) and avoids "defer" (whose effect differs between modes).
  - otherwise -> silent pass-through.

Shrinking edits are always allowed even while still over a cap, so the index can
be compacted incrementally (e.g. 210 -> 205 -> 198) instead of in one edit.

Edit/MultiEdit are predicted by *simulating* the sub-edits sequentially on a copy
of the current text (honouring uniqueness / replace_all, skipping sub-edits whose
old_string is absent or non-unique), because Claude Code applies MultiEdit
sub-edits in order, each on the previous result.

Fail-SAFE, not fail-open, for the things that matter: an unreadable / non-UTF-8
index is treated as empty (so any non-empty write counts as growth and is still
gated), and a malformed numeric env var falls back to its default. Only a genuine
unexpected exception falls open (a guard must never brick the user's editing).

Wire it up in settings.json (PreToolUse, matcher "Edit|Write|MultiEdit"):
  "command": "python /ABSOLUTE/PATH/TO/engramory/hooks/engramory_index_guard.py"
  (Windows: use forward slashes, e.g. python E:/path/to/engramory/hooks/...py)

Config via environment variables (all optional):
  ENGRAMORY_HARD          hard line ceiling,  default 200
  ENGRAMORY_WARN          soft line warning,  default 150
  ENGRAMORY_HARD_BYTES    hard byte ceiling,  default 25600  (25 KB)
  ENGRAMORY_WARN_BYTES    soft byte warning,  default 20480  (20 KB)
  ENGRAMORY_INDEX_NAME    index filename to guard, default "MEMORY.md"
  ENGRAMORY_INDEX_PATH    absolute path of the one index to guard (overrides name
                       matching; use when several MEMORY.md exist)
"""
import json
import os
import sys


def _allow_silently():
    # No output + exit 0 == "no opinion", tool proceeds through normal flow.
    sys.exit(0)


def _emit(decision=None, reason=None, context=None):
    # decision="deny" blocks the tool call. For a non-blocking nudge we pass NO
    # decision and only additionalContext: omitting permissionDecision means "no
    # opinion -> normal permission flow", the documented way to surface context to
    # the model without affecting the decision. We never emit "allow" (auto-approve)
    # and deliberately avoid "defer", whose runtime effect differs between Claude
    # Code's interactive and non-interactive modes.
    hso = {"hookEventName": "PreToolUse"}
    if decision is not None:
        hso["permissionDecision"] = decision
    if reason is not None:
        hso["permissionDecisionReason"] = reason
    if context is not None:
        hso["additionalContext"] = context
    print(json.dumps({"hookSpecificOutput": hso}))
    sys.exit(0)


def _envint(name, default):
    # A bad/empty env var must fall back to the default, not disable the guard.
    # A non-positive cap (0 / negative) is nonsensical: it would make every growing
    # edit "over cap" and brick all index editing, so it also falls back to the
    # default rather than being taken at face value.
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        val = int(raw.strip())
    except (TypeError, ValueError):
        return default
    return val if val > 0 else default


def _lines(text):
    # Logical lines counted by newline only. NOT str.splitlines(): that also
    # breaks on Unicode line boundaries (U+0085, U+2028, U+000B, ...) common in
    # CJK/emoji indexes and would inflate the count -> false deny. A trailing
    # newline is not a separate line (file of "a\nb\n" == 2 lines).
    if not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def _bytes(text):
    return len(text.encode("utf-8"))


def _kb(n):
    return f"{n} B" if n < 1024 else f"{n / 1024:.1f} KB"


def _plural(n, word):
    # "1 line", "2 lines" — avoid the ungrammatical "1 lines" in reason text.
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def _which(p_lines, p_bytes, line_cap, byte_cap, cur_lines=None, cur_bytes=None):
    # Name the dimension(s) over their cap, so a nudge says whether to cut lines or
    # bytes. When cur_* are given (the deny path), name only dimensions that ALSO grew —
    # so a deny triggered by bytes doesn't tell the user to cut a line count that is
    # actually shrinking. Caller uses it only when at least one applies, so never empty.
    parts = []
    if p_lines > line_cap and (cur_lines is None or p_lines > cur_lines):
        parts.append(f"{_plural(p_lines, 'line')} > {line_cap}")
    if p_bytes > byte_cap and (cur_bytes is None or p_bytes > cur_bytes):
        parts.append(f"{_kb(p_bytes)} > {_kb(byte_cap)}")
    return " and ".join(parts)


def _apply_edits(current, edits):
    # Simulate the sub-edits sequentially, the way Claude Code applies them: each
    # on the result of the previous. Skip a sub-edit the real tool wouldn't apply
    # (empty/absent old_string, or non-unique without replace_all).
    result = current
    for e in edits:
        old = e.get("old_string", "") or ""
        new = e.get("new_string", "") or ""
        if not old:
            continue
        if e.get("replace_all"):
            result = result.replace(old, new)
        elif result.count(old) == 1:
            result = result.replace(old, new, 1)
        # else: absent or non-unique -> real tool errors/doesn't apply -> skip
    return result


def main():
    data = json.loads(sys.stdin.read())

    tool = data.get("tool_name", "")
    ti = data.get("tool_input", {}) or {}
    file_path = ti.get("file_path", "") or ""
    if not file_path:
        _allow_silently()

    index_name = os.environ.get("ENGRAMORY_INDEX_NAME", "MEMORY.md")
    index_path = os.environ.get("ENGRAMORY_INDEX_PATH", "")

    # Is this edit targeting the index we guard?
    if index_path:
        # normcase + realpath so a case difference (E:\Memory vs e:\memory on
        # Windows) or a symlink doesn't let an edit to the guarded index slip past.
        def _key(p):
            return os.path.normcase(os.path.realpath(p))
        if _key(file_path) != _key(index_path):
            _allow_silently()
    else:
        if os.path.basename(file_path).lower() != index_name.lower():
            _allow_silently()

    hard = _envint("ENGRAMORY_HARD", 200)
    warn = _envint("ENGRAMORY_WARN", 150)
    hard_b = _envint("ENGRAMORY_HARD_BYTES", 25600)
    warn_b = _envint("ENGRAMORY_WARN_BYTES", 20480)

    # Current index. Read raw bytes so a non-UTF-8 / corrupt index can't throw and
    # silently disable the guard: decode lossily for line/edit math, size by bytes.
    try:
        with open(file_path, "rb") as fh:
            raw = fh.read()
    except OSError:
        raw = b""
    current = raw.decode("utf-8", "replace")
    cur_lines = _lines(current)
    cur_bytes = len(raw)

    # Predict line count AND byte size AFTER this edit.
    if tool == "Write":
        # Write payload key is "content" in current Claude Code; some docs say
        # "file_text". Accept either.
        new_text = ti.get("content")
        if new_text is None:
            new_text = ti.get("file_text", "")
        result = new_text or ""
    elif tool in ("Edit", "MultiEdit"):
        edits = [ti] if tool == "Edit" else (ti.get("edits", []) or [])
        result = _apply_edits(current, edits)
    else:
        _allow_silently()

    p_lines = _lines(result)
    p_bytes = _bytes(result)

    # Boundary: the host loads the FIRST `hard` lines / `hard_b` bytes, so being
    # exactly at the cap is fine; only strictly over it loses recall.
    over_hard = p_lines > hard or p_bytes > hard_b
    over_warn = p_lines > warn or p_bytes > warn_b
    # Deny only when the edit pushes a dimension that is ALREADY over its own cap
    # further past it. A genuine compaction that shrinks the over-cap dimension is
    # allowed even if the other (under-cap) dimension ticks up — otherwise cutting line
    # count while bytes rise a little would be wrongly blocked, breaking the documented
    # promise that shrinking/compaction edits always pass.
    worsens_cap = ((p_lines > hard and p_lines > cur_lines)
                   or (p_bytes > hard_b and p_bytes > cur_bytes))

    size = f"{_plural(p_lines, 'line')} / {_kb(p_bytes)}"
    caps = f"{hard} lines / {_kb(hard_b)}"

    if worsens_cap:
        which = _which(p_lines, p_bytes, hard, hard_b, cur_lines, cur_bytes)
        _emit(
            "deny",
            reason=(
                f"Engramory: this edit would GROW the memory index to {size}, past the "
                f"host's load window ({which}; cap {caps}). Beyond it the "
                f"tail of the index is silently truncated and those memories stop being "
                f"recalled. Do NOT append. Run the compaction procedure (SKILL.md §6): "
                f"(1) pointer-ify prose that leaked into index lines (biggest win when the "
                f"byte cap is exceeded), (2) merge duplicate pointers, (3) archive "
                f"cold/superseded memories. Shrinking edits ARE allowed, so you can "
                f"compact step by step; only growth while over the cap is blocked. If you "
                f"still cannot get under the cap, ask the user which memories to retire. "
                f"(If this file is NOT your memory index, set the ENGRAMORY_INDEX_PATH env "
                f"var to your real index's absolute path so the hook only gates that file.)"
            ),
        )
    elif over_hard:
        _emit(
            context=(
                f"Engramory: index will be {size}, still over the load window "
                f"({_which(p_lines, p_bytes, hard, hard_b)}; cap {caps}), but this edit "
                f"shrinks/keeps it so it's allowed. Keep compacting (pointer-ify / merge / "
                f"archive) until it's at or under {caps}."
            ),
        )
    elif over_warn:
        _emit(
            context=(
                f"Engramory: index will be {size} — over "
                f"{_which(p_lines, p_bytes, warn, warn_b)} (caps {caps}). Allowed, but tell "
                f"the user the index is getting long and offer a compaction pass — pointer-ify "
                f"over-long index lines, merge duplicates, archive cold notes — before it "
                f"hits the hard cap."
            ),
        )
    else:
        _allow_silently()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Fail-open on genuinely unexpected errors: never block a real edit
        # because the guard itself crashed.
        sys.exit(0)
