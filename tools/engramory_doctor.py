#!/usr/bin/env python3
"""
engramory_doctor — consistency + protocol check for an Engramory memory store.

    python tools/engramory_doctor.py <MEMORY_ROOT>              # structure + schema
    python tools/engramory_doctor.py <MEMORY_ROOT> --no-schema  # structure only

`--no-schema` skips the per-note frontmatter/protocol checks and runs only the
structural checks (over-cap index, broken pointers, orphans, duplicate slugs) — use
it to health-check a store that isn't (yet) in strict Engramory format, e.g. a
host-native auto-memory store.

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
# Why / How-to-apply labels (feedback & project MUST carry them). Match a line whose
# content — after an optional Markdown prefix (#, >, *, -, whitespace) and optional **
# bolding — is the label followed by an ASCII ':' OR a full-width '：' (CJK keyboards
# emit the latter; that was a false-positive). Anchored to the line start (re.M) so
# incidental prose ("...the Why: is below") doesn't satisfy it, and the FULL
# "How to apply" label is still required — a bare "How:" drops the deliberate
# "what do I concretely do next" cue and stays an ISSUE. See SKILL.md §1/§2.
_LABEL = r"^[ \t#>*\-]*\*{0,2}\s*"
_WHY_RE = re.compile(_LABEL + r"Why\s*\*{0,2}\s*[:：]", re.I | re.M)
_HOW_RE = re.compile(_LABEL + r"How\s+to\s+apply\s*\*{0,2}\s*[:：]", re.I | re.M)
# Near-miss detectors: only to enrich the error message (guide the fix) when the
# strict label above is absent — a 'Why'/'How' line that looks like a label attempt.
_WHY_NEAR = re.compile(_LABEL + r"Why\b", re.I | re.M)
_HOW_NEAR = re.compile(_LABEL + r"How\b", re.I | re.M)
# Index pointer target `](path.md)`: lazy + a real terminator after `.md` so a backup
# like `note.md.bak` isn't truncated to `note.md`; control chars (incl. NUL) excluded so
# a malformed pointer can't reach realpath and throw. `<?` tolerates an angle-bracket link.
_PTR_RE = re.compile(r"\]\(\s*<?([^)>\s#?\x00-\x1f]+?\.md)(?=[)>\s#?]|$)")


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


def _kb(n):
    # Human-readable bytes, matching engramory_check.py and the hook so all three tools
    # render the same size string (doctor used to use integer `//1024`, showing a sub-1KB
    # index as "0 KB" and an over-by-1-byte cap as a contradictory "25 KB > 25 KB").
    return f"{n} B" if n < 1024 else f"{n / 1024:.1f} KB"


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
    # utf-8-sig strips a leading BOM if present (a no-op otherwise) — a BOM'd but
    # otherwise-valid note must not read as "no frontmatter". Windows editors / PowerShell
    # write UTF-8-BOM by default, so adopter notes routinely carry one.
    return None if raw is None else raw.decode("utf-8-sig", "replace")


def _frontmatter(text):
    # Validate + parse Engramory's restricted `key: value` frontmatter between
    # leading `---` fences. Indentation is ignored (so a nested `metadata:` block's
    # keys are still read). Returns (fields, problems, body): `fields` is a dict, or
    # None if there is no opening fence; `body` is the text AFTER the closing fence
    # (or the whole text when there's no frontmatter) so body-only checks can't be
    # satisfied by a frontmatter line. Each fence line must be EXACTLY `---` (trailing
    # whitespace allowed) — `----` or `---x` is not a fence, so a Markdown horizontal
    # rule isn't mistaken for one. `problems` lists a missing closing fence, malformed
    # (non-`key: value`) lines, and unclosed quotes — so the caller can fail on
    # malformed frontmatter instead of silently accepting it.
    nl = text.find("\n")
    head = text if nl == -1 else text[:nl]
    if head.strip() != "---":
        return None, [], text  # opening line isn't a bare '---'
    if nl == -1:
        return None, ["frontmatter opening '---' has no closing '---'"], text
    m = re.compile(r"^---[ \t]*\r?$", re.M).search(text, nl + 1)  # tolerate CRLF
    if m is None:
        return None, ["frontmatter opening '---' has no closing '---'"], text
    fm, problems = {}, []
    for raw in text[nl + 1:m.start()].splitlines():
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
    return fm, problems, text[m.end():]


def main(argv):
    args = argv[1:]
    schema = "--no-schema" not in args  # default: validate frontmatter too
    positional = [a for a in args if not a.startswith("-")]
    root = positional[0] if positional else "."
    idx_path = os.path.join(root, "MEMORY.md")
    if not os.path.isfile(idx_path):
        print(f"engramory-doctor: no index at {idx_path}")
        return 1

    iraw = _read_bytes(idx_path)
    if iraw is None:
        print(f"engramory-doctor: cannot read index at {idx_path}")
        return 1
    itext = iraw.decode("utf-8-sig", "replace")  # strip a leading BOM if present
    hard = _envint("ENGRAMORY_HARD", 200)
    hard_b = _envint("ENGRAMORY_HARD_BYTES", 25600)
    issues, info = [], []

    # Byte size from the raw on-disk bytes (NOT the lossily re-decoded text), so
    # the cap math agrees with the hook and engramory_check on a non-UTF-8 index.
    nbytes = len(iraw)
    nlines = _lines(itext)
    if nlines > hard or nbytes > hard_b:
        over = []
        if nlines > hard:
            over.append(f"{nlines} lines > {hard}")
        if nbytes > hard_b:
            over.append(f"{_kb(nbytes)} > {_kb(hard_b)}")
        issues.append(f"index over cap ({' and '.join(over)}): {nlines} lines / "
                      f"{_kb(nbytes)} (cap {hard} lines / {_kb(hard_b)}) — compact it")

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
            if f.lower().endswith(".md"):  # tolerate .MD/.Md so they aren't skipped (and bypass schema) on case-insensitive FS
                if f in notes:
                    # Same slug in two dirs: the basename-keyed model can only hold
                    # one, so the other would be invisible to these checks. Surface
                    # it instead of silently overwriting.
                    issues.append(f"duplicate note slug '{f}' in multiple dirs: "
                                  f"{notes[f]} and {os.path.join(dp, f)} — slugs must be unique")
                notes[f] = os.path.join(dp, f)

    referenced, indexed = set(), set()
    # realpath (not abspath) so a symlinked pointer can't resolve outside the store
    # while still passing the escape check; the root is resolved the same way so a
    # store reached via a symlink/junction stays consistent.
    root_abs = os.path.realpath(root)
    # every index (file.md) pointer must resolve to a real file AT THE POINTED PATH.
    # Match the link target up to whitespace / '#' / ')' (so anchored `(note.md#sec)`
    # and titled `(note.md "Title")` links resolve), skip external URLs ending in
    # .md, and resolve the path itself — a bare basename match is too loose (it would
    # green-light `wrong/path/a.md` whenever some `a.md` exists elsewhere in the store).
    for tgt in sorted(set(_PTR_RE.findall(itext))):
        if "://" in tgt:
            continue  # external URL, not a local note pointer
        full = os.path.realpath(os.path.join(root, tgt.replace("\\", "/")))
        if full != root_abs and not full.startswith(root_abs + os.sep):
            issues.append(f"index pointer escapes the store root: {tgt}")
            continue
        if os.path.isfile(full):
            # the resolved real name — realpath canonicalises case on case-insensitive
            # filesystems, so this matches the notes-dict key (from os.walk) instead of
            # the pointer's possibly-miscased text, avoiding a false 'orphan'.
            base = os.path.basename(full)
            referenced.add(base)
            indexed.add(base)
        else:
            issues.append(f"index points to a missing file: {tgt}")

    # duplicate index pointers: the same note pointed to from more than one index line
    # is redundant (INFO — a thematic index may cross-reference on purpose, so it does
    # not fail). Count the raw (non-deduped) targets that resolved to a real note.
    ptr_counts = {}
    for tgt in _PTR_RE.findall(itext):
        if "://" in tgt:
            continue
        b = os.path.basename(os.path.realpath(os.path.join(root, tgt.replace("\\", "/"))))
        if b in indexed:
            ptr_counts[b] = ptr_counts.get(b, 0) + 1
    for b, n in sorted(ptr_counts.items()):
        if n > 1:
            info.append(f"index points to '{b}' {n} times (one pointer per note is the norm)")

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
            if cand == base:
                continue  # a note linking to itself isn't "referenced by another note"
            if cand in notes:
                referenced.add(cand)
            else:
                info.append(f"[[{w}]] in {base} has no target file yet (ok if a forward-ref stub)")

        if not schema:
            continue  # --no-schema: structural checks only, skip frontmatter validation
        # --- protocol schema: the spec's MUST fields are ISSUE (exit 1); soft
        # hygiene (name<->filename) is info. See SKILL.md §1/§2. ---
        slug = base[:-3]  # strip .md
        fm, fm_problems, body = _frontmatter(text)
        for prob in fm_problems:
            issues.append(f"{base}: {prob}")
        if fm is None and not fm_problems:
            issues.append(f"{base}: no frontmatter block (needs name/description/type/created/updated)")
        elif fm is not None:
            for field in ("name", "description", "type"):
                if not fm.get(field):
                    issues.append(f"{base}: frontmatter missing required '{field}'")
            t = fm.get("type", "")
            if t and t not in VALID_TYPES:
                issues.append(f"{base}: invalid type '{t}' (must be one of {'|'.join(sorted(VALID_TYPES))})")
            name = fm.get("name", "")
            if name:
                # tolerate the host convention of '-' in names vs '_' in filenames
                # (e.g. Claude Code) and case; also tolerate a leading type-prefix the
                # host adds to filenames (CC: name 'audit-methodology' vs file
                # 'feedback_audit_methodology'). Only flag a real mismatch (soft).
                nslug = slug.replace("_", "-").lower()
                nname = name.replace("_", "-").lower()
                for pre in ("feedback-", "project-", "reference-", "user-"):
                    if nslug.startswith(pre) and not nname.startswith(pre):
                        nslug = nslug[len(pre):]
                        break
                if nname != nslug:
                    info.append(f"{base}: name '{name}' != filename slug '{slug}'")
            for dk in ("created", "updated"):
                dv = fm.get(dk, "")
                if not dv:
                    issues.append(f"{base}: frontmatter missing required '{dk}'")
                elif not _valid_date(dv):
                    issues.append(f"{base}: '{dk}' is not a valid YYYY-MM-DD date ('{dv}')")
            if t in ("feedback", "project"):
                # scan the BODY only — a Why:/How to apply: line in the frontmatter
                # doesn't count as the required reflection.
                if not _WHY_RE.search(body):
                    msg = f"{base}: type {t} must carry a 'Why:' line"
                    if _WHY_NEAR.search(body):
                        msg += " (found a 'Why' label without the 'Why:' form — add a colon, e.g. **Why:**)"
                    issues.append(msg)
                if not _HOW_RE.search(body):
                    msg = f"{base}: type {t} must carry a 'How to apply:' line"
                    if _HOW_NEAR.search(body):
                        msg += " (found 'How' but not the full 'How to apply:' label, e.g. **How to apply:**)"
                    issues.append(msg)

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
        # Bucket the issues so an adopter triaging a big existing store sees the shape
        # ("211 missing-date, 84 missing-why-how, 3 broken-pointer") instead of a flat
        # wall, plus a one-line manual fix per non-empty bucket. Pure string tally —
        # no new dependency, no change to what counts as an issue or the exit code.
        buckets = {}
        for s in issues:
            if ("missing required 'created'" in s or "missing required 'updated'" in s
                    or "not a valid YYYY-MM-DD" in s):
                b = "missing-date"
            elif "'Why:' line" in s or "'How to apply:' line" in s:
                b = "missing-why-how"
            elif "points to a missing file" in s or "escapes the store root" in s:
                b = "broken-pointer"
            elif "orphan note" in s:
                b = "orphan"
            elif "duplicate note slug" in s:
                b = "duplicate-slug"
            elif "index over cap" in s:
                b = "over-cap"
            else:
                b = "other"
            buckets[b] = buckets.get(b, 0) + 1
        order = ["over-cap", "broken-pointer", "duplicate-slug", "orphan",
                 "missing-date", "missing-why-how", "other"]
        fixhints = {
            "over-cap": "compact MEMORY.md — pointer-ify long lines, merge, archive cold notes",
            "broken-pointer": "repair or remove the MEMORY.md pointer (needs a human)",
            "duplicate-slug": "rename one of the clashing note files so each slug is unique",
            "orphan": "link it from the index or another note, or move it under archive/",
            "missing-date": "add 'created:'/'updated:' (YYYY-MM-DD) to each note's frontmatter",
            "missing-why-how": "add a 'Why:' / 'How to apply:' line to the note (SKILL.md §2)",
            "other": "see the ISSUE lines above",
        }
        summary = ", ".join(f"{buckets[b]} {b}" for b in order if b in buckets)
        print(f"engramory-doctor: {len(issues)} issue(s) — {summary}")
        for b in order:
            if b in buckets:
                print(f"  fix {b}: {fixhints[b]}")
        return 1
    tail = ("no broken pointers, orphans, or schema errors." if schema
            else "no broken pointers or orphans (schema checks skipped via --no-schema).")
    print(f"engramory-doctor: clean — index {nlines} lines / {_kb(nbytes)}, "
          f"{len(notes) - 1} note(s), {tail}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
