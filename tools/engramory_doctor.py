#!/usr/bin/env python3
"""
engramory_doctor — consistency + protocol check for an Engramory memory store.

    python tools/engramory_doctor.py <MEMORY_ROOT>   # dir containing MEMORY.md

Catches drift the per-write checks miss, on two levels:

STRUCTURE (ISSUE -> exit 1): an over-cap index, index pointers to files that no
longer exist, pointers that escape the store root, orphan notes that nothing
references, and duplicate note slugs (two files sharing a basename).

PROTOCOL SCHEMA (ISSUE -> exit 1): the spec's required fields are enforced — each
note must have well-formed frontmatter (no malformed lines, unclosed quotes, or a
missing closing fence) carrying a non-empty `name`, `description`, a valid `type`
(user|feedback|project|reference), and real-calendar `created` + `updated` dates;
feedback/project notes must carry `Why:` + `How to apply:`. Soft hygiene is INFO
(exit 0): a `name` not matching the filename slug (tolerating `-`/`_`/case), and a
note reachable only via a `[[wikilink]]` (not in the index, so it won't load at
session start). Broken `[[wikilinks]]` are INFO (forward-reference stubs allowed).

Note: indentation is ignored, so fields nested under a host's `metadata:` block
(e.g. Claude Code's) are read; the name<->filename check ignores `-`/`_`/case so
CC's `a-b` name vs `a_b.md` file isn't flagged. The frontmatter grammar is the
restricted `key: value` form, not full YAML (so the tool keeps zero dependencies).

Exit 0 = no issues; 1 = issues found (incl. an unreadable index). Caps via
ENGRAMORY_HARD / ENGRAMORY_HARD_BYTES.
"""
import datetime
import os
import re
import sys

VALID_TYPES = {"user", "feedback", "project", "reference"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _valid_date(s):
    # YYYY-MM-DD format AND a real calendar date (so 2026-99-99 fails).
    if not DATE_RE.match(s):
        return False
    try:
        datetime.date(*(int(x) for x in s.split("-")))
        return True
    except ValueError:
        return False


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


def _frontmatter(text):
    # Validate + parse Engramory's restricted `key: value` frontmatter between
    # leading `---` fences. Indentation is ignored (so a nested `metadata:` block's
    # keys are still read). Returns (fields, problems): `fields` is a dict, or None
    # if there is no opening fence. `problems` lists a missing closing fence,
    # malformed (non-`key: value`) lines, and unclosed quotes — so the caller can
    # fail on malformed frontmatter instead of silently accepting it.
    if not text.startswith("---"):
        return None, []
    end = text.find("\n---", 3)
    if end == -1:
        return None, ["frontmatter opening '---' has no closing '---'"]
    fm, problems = {}, []
    for raw in text[3:end].splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            problems.append(f"malformed frontmatter line (not 'key: value'): {line!r}")
            continue
        k, v = line.split(":", 1)
        v = v.strip()
        if v[:1] in ("'", '"') and not (len(v) >= 2 and v[-1] == v[0]):
            problems.append(f"unclosed quote in frontmatter value for '{k.strip()}'")
        fm[k.strip()] = v.strip('"').strip("'")
    return fm, problems


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

    referenced, indexed = set(), set()
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
            base = os.path.basename(tgt)  # the slug this pointer resolves to
            referenced.add(base)
            indexed.add(base)
        else:
            issues.append(f"index points to a missing file: {tgt}")

    # one pass per note: wikilink graph + frontmatter/protocol validation.
    for base, p in sorted(notes.items()):
        if base == "MEMORY.md":
            continue
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

        # --- protocol schema: the spec's MUST fields are ISSUE (exit 1); soft
        # hygiene (name<->filename) is info. See SKILL.md §1/§2. ---
        slug = base[:-3]  # strip .md
        fm, fm_problems = _frontmatter(text)
        for prob in fm_problems:
            issues.append(f"{base}: {prob}")
        if fm is None and not fm_problems:
            issues.append(f"{base}: no YAML frontmatter (needs name/description/type/created/updated)")
        elif fm is not None:
            for field in ("name", "description", "type"):
                if not fm.get(field):
                    issues.append(f"{base}: frontmatter missing required '{field}'")
            t = fm.get("type", "")
            if t and t not in VALID_TYPES:
                issues.append(f"{base}: invalid type '{t}' (must be one of {'|'.join(sorted(VALID_TYPES))})")
            name = fm.get("name", "")
            if name and name.replace("_", "-").lower() != slug.replace("_", "-").lower():
                # tolerate the host convention of '-' in names vs '_' in filenames
                # (e.g. Claude Code) and case; only flag a real mismatch (soft).
                info.append(f"{base}: name '{name}' != filename slug '{slug}'")
            for dk in ("created", "updated"):
                dv = fm.get(dk, "")
                if not dv:
                    issues.append(f"{base}: frontmatter missing required '{dk}'")
                elif not _valid_date(dv):
                    issues.append(f"{base}: '{dk}' is not a valid YYYY-MM-DD date ('{dv}')")
            if t in ("feedback", "project"):
                stripped = text.replace("*", "")  # tolerate **Why:** / **Why**: bolding
                if "Why:" not in stripped:
                    issues.append(f"{base}: type {t} must carry a 'Why:' line")
                if "How to apply:" not in stripped:
                    issues.append(f"{base}: type {t} must carry a 'How to apply:' line")

    # orphans (ISSUE) and in-graph-but-not-in-index notes (INFO: won't load at start)
    for base in sorted(notes):
        if base == "MEMORY.md":
            continue
        if base not in referenced:
            issues.append(f"orphan note (not in index, nothing links to it): {base}")
        elif base not in indexed:
            info.append(f"{base}: linked from another note but not in MEMORY.md "
                        f"(won't load at session start — add an index pointer)")

    for i in issues:
        print(f"ISSUE: {i}")
    for i in sorted(set(info)):
        print(f"info:  {i}")
    if issues:
        print(f"engramory-doctor: {len(issues)} issue(s).")
        return 1
    print(f"engramory-doctor: clean — index {nlines} lines / {nbytes // 1024} KB, "
          f"{len(notes) - 1} note(s), no broken pointers, orphans, or schema errors.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
