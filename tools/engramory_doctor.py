#!/usr/bin/env python3
"""
engramory_doctor — consistency check for an Engramory memory store (layer-4 backstop).

    python tools/engramory_doctor.py <MEMORY_ROOT>   # dir containing MEMORY.md

Catches drift the per-write checks miss: an over-cap index, index pointers to
files that no longer exist, orphan notes that nothing references, and duplicate
note slugs (two files sharing a basename, which breaks the one-file-one-slug
model). Broken [[wikilinks]] are reported as info (forward-reference stubs are
allowed by design).

Exit 0 = no issues; 1 = issues found (including an unreadable index). Caps via
ENGRAMORY_HARD / ENGRAMORY_HARD_BYTES.
"""
import os
import re
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


def _lines(t):
    return 0 if not t else t.count("\n") + (0 if t.endswith("\n") else 1)


def _read_bytes(p):
    # Return raw bytes, or None if the file can't be read (permission / race /
    # deleted between walk and read) so callers degrade to a reported issue
    # instead of crashing with a traceback.
    try:
        with open(p, "rb") as fh:
            return fh.read()
    except OSError:
        return None


def _read(p):
    raw = _read_bytes(p)
    return None if raw is None else raw.decode("utf-8", "replace")


def main(argv):
    root = argv[1] if len(argv) > 1 else "."
    idx_path = os.path.join(root, "MEMORY.md")
    if not os.path.isfile(idx_path):
        print(f"engramory-doctor: no index at {idx_path}")
        return 1

    iraw = _read_bytes(idx_path)
    if iraw is None:
        print(f"engramory-doctor: cannot read index at {idx_path}")
        return 1
    itext = iraw.decode("utf-8", "replace")
    hard = _envint("ENGRAMORY_HARD", 200)
    hard_b = _envint("ENGRAMORY_HARD_BYTES", 25600)
    issues, info = [], []

    # Byte size from the raw on-disk bytes (NOT the lossily re-decoded text), so
    # the cap math agrees with the hook and engramory_check on a non-UTF-8 index.
    nbytes = len(iraw)
    nlines = _lines(itext)
    if nlines > hard or nbytes > hard_b:
        issues.append(f"index over cap: {nlines} lines / {nbytes // 1024} KB "
                      f"(cap {hard} / {hard_b // 1024} KB) — compact it")

    # note files (by basename; a store uses unique slugs), excluding the top-level
    # templates/ & archive/ dirs only. Match on the FIRST path component, not a raw
    # string prefix, so a sibling like "templates-old/" is still checked and a
    # nested "sub/templates/" is not wrongly skipped.
    notes = {}
    for dp, _, fs in os.walk(root):
        rel = os.path.relpath(dp, root).replace("\\", "/")
        parts = rel.split("/")
        if parts and parts[0] in ("templates", "archive"):
            continue
        for f in fs:
            if f.endswith(".md"):
                if f in notes:
                    # Same slug in two dirs: the basename-keyed model can only hold
                    # one, so the other would be invisible to these checks. Surface
                    # it instead of silently overwriting.
                    issues.append(f"duplicate note slug '{f}' in multiple dirs: "
                                  f"{notes[f]} and {os.path.join(dp, f)} — slugs must be unique")
                notes[f] = os.path.join(dp, f)

    referenced = set()
    root_abs = os.path.abspath(root)
    # every index (file.md) pointer must resolve to a real file AT THE POINTED PATH.
    # Match the link target up to whitespace / '#' / ')' (so anchored `(note.md#sec)`
    # and titled `(note.md "Title")` links resolve), skip external URLs ending in
    # .md, and resolve the path itself — a bare basename match is too loose (it would
    # green-light `wrong/path/a.md` whenever some `a.md` exists elsewhere in the store).
    for tgt in sorted(set(re.findall(r"\]\(\s*<?([^)>\s#]+\.md)", itext))):
        if "://" in tgt:
            continue  # external URL, not a local note pointer
        full = os.path.abspath(os.path.join(root, tgt))
        if full != root_abs and not full.startswith(root_abs + os.sep):
            issues.append(f"index pointer escapes the store root: {tgt}")
            continue
        if os.path.isfile(full):
            referenced.add(os.path.basename(tgt))  # the slug this pointer resolves to
        else:
            issues.append(f"index points to a missing file: {tgt}")

    # wikilinks across all notes; missing targets = info (forward-ref stubs allowed)
    for base, p in notes.items():
        text = _read(p)
        if text is None:
            issues.append(f"cannot read note file: {p}")
            continue
        for w in re.findall(r"\[\[([^\]]+)\]\]", text):
            cand = os.path.basename(w if w.endswith(".md") else w + ".md")
            if cand in notes:
                referenced.add(cand)
            else:
                info.append(f"[[{w}]] in {base} has no target file yet (ok if a forward-ref stub)")

    # orphans: notes nothing references (not the index, not any wikilink)
    for base in sorted(notes):
        if base == "MEMORY.md":
            continue
        if base not in referenced:
            issues.append(f"orphan note (not in index, nothing links to it): {base}")

    for i in issues:
        print(f"ISSUE: {i}")
    for i in sorted(set(info)):
        print(f"info:  {i}")
    if issues:
        print(f"engramory-doctor: {len(issues)} issue(s).")
        return 1
    print(f"engramory-doctor: clean — index {nlines} lines / {nbytes // 1024} KB, "
          f"{len(notes) - 1} note(s), no broken pointers or orphans.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
