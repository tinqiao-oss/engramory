#!/usr/bin/env python3
"""
engramory_init - bootstrap Engramory for an agent host.

Usage:

    python tools/engramory_init.py codex          --project-root <repo> --install-skill
    python tools/engramory_init.py openclaw                              --install-skill
    python tools/engramory_init.py dsh                                   --install-skill
    python tools/engramory_init.py <host>-reader   --project-root <cfg>  --memory-root <existing store>

For a WRITE host (codex, openclaw, dsh) the command creates a local memory store, adds a marked
Engramory block to the host's always-loaded AGENTS.md, optionally installs the Engramory skill
where that host's loader actually scans (`.agents/skills/engramory` for Codex and OpenClaw;
for dsh, `<DSH_HOME>/skills/engramory` globally and `<project>/.dsh/skills/engramory` with
--project-root), and adds the memory store to .gitignore when the store
lives inside the project/workspace.

A READ-ONLY reader host `<host>-reader` (codex-reader, claude-reader, cursor-reader,
cline-reader, windsurf-reader, openclaw-reader, hermes-reader, dsh-reader) instead wires that host to *recall*
from a store ANOTHER agent (Claude Code, dsh, …) owns and writes — one writer, N readers. It
creates no store, touches no .gitignore, installs no write tools, and uses a recall-only snippet
(no write protocol). `--memory-root` MUST point at an existing store (e.g. Claude Code's memory
dir). It injects into the host's own always-loaded rules file (AGENTS.md / CLAUDE.md / .clinerules
/ Cursor .mdc …); a marked block coexists with other Engramory blocks. Only the
codex-reader, claude-reader and dsh-reader wirings are verified against their real hosts — the others are
built from each host's documented
rules-file format but printed with an "unverified" note. See adapters/reader/README.md.

Defaults: --project-root '.', except openclaw (~/.openclaw/workspace) and dsh
($DSH_HOME when set, else ~/.dsh). dsh's user-global block renders absolute paths;
project blocks stay relative.
"""
import argparse
import base64
import json
import os
import shlex
import shutil
import sys
import tempfile
from pathlib import Path


def _repo_root():
    return Path(__file__).resolve().parents[1]


def _read_text(path):
    return path.read_text(encoding="utf-8")


def _write_text(path, text, guard_root=None):
    """Every install write is atomic — several targets are USER-OWNED files.

    `AGENTS.md`, a dedicated rules file, and `.gitignore` routinely already exist
    and hold content this installer did not write. A plain `open(..., "w")`
    truncates before writing, so a disk-full, an I/O error, or a killed process
    in between leaves the user's rules file empty or half-written. Staging into a
    temp file and `os.replace`-ing means the previous content survives any
    failure.
    """
    _write_text_atomic(path, text, guard_root=guard_root)


def _write_text_atomic(path, text, guard_root=None):
    """Atomically replace a managed file without following a final symlink/hardlink.

    `guard_root` re-checks containment HERE, immediately before the write, rather
    than trusting the run's preflight: a parent directory swapped for a symlink in
    between would otherwise redirect this write outside the tree. This narrows the
    window to the gap between the check and the `mkstemp` below — it does not close
    it. Closing it needs fd-relative, reparse-point-refusing directory handles that
    the stdlib does not offer portably, so this stays best-effort (SECURITY.md).
    """
    if guard_root is not None:
        _refuse_symlink_escape(path, guard_root, path.name)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name = None
    try:
        fd, temp_name = tempfile.mkstemp(
            prefix=".engramory-install-", suffix=".tmp", dir=str(path.parent))
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
        temp_name = None
    except OSError as exc:
        raise SystemExit(f"cannot atomically write managed file {path}: {exc}")
    finally:
        if temp_name is not None:
            try:
                os.unlink(temp_name)
            except OSError:
                pass


def _same_or_inside(child, parent):
    child = child.resolve()
    parent = parent.resolve()
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _refuse_symlink_escape(target, project_root, what):
    # Every file init writes under --project-root (AGENTS.md / .gitignore / a dedicated
    # rule file / the skill dir) must actually RESOLVE inside it. If the target or one of
    # its parent dirs is a symlink pointing elsewhere, writing "through" it would rewrite
    # an unrelated external file — the same boundary doctor enforces on the store
    # (SECURITY.md). A deliberate out-of-tree layout should point --project-root at the
    # real location instead.
    if not _same_or_inside(target, project_root):
        raise SystemExit(
            f"refusing to write {what} at {target}: it resolves to "
            f"{Path(os.path.realpath(target)).as_posix()}, outside --project-root "
            f"({project_root.as_posix()}) — a symlink escape. Edit the real file "
            f"directly, or point --project-root at the real location.")


def _display_path(path, base):
    path = path.resolve()
    base = base.resolve()
    try:
        rel = path.relative_to(base)
        return rel.as_posix() or "."
    except ValueError:
        return path.as_posix()


def _replace_block(existing, block, begin, end, heading="AGENTS.md"):
    # Replace only a well-formed, IN-ORDER BEGIN..END pair. Anything else — no markers, a
    # lone/duplicated marker, or END before BEGIN from a botched hand-edit — is treated as
    # "no managed block": drop any stray marker LINES and append a fresh block. This never
    # crashes on a malformed file and never silently deletes the surrounding user content.
    # `heading` titles a freshly-created empty file, so a new CLAUDE.md / .clinerules isn't
    # mislabelled "# AGENTS.md".
    # A marker counts only when it is the WHOLE line — which is how this installer
    # writes it. Matching the raw substring conflated two very different files: one
    # with a genuinely duplicated marker, and one where the user merely QUOTES the
    # marker in prose ("wrap it in `<!-- BEGIN … -->`"). The first must take the
    # conservative path; the second is an ordinary single-block file, and treating it
    # as malformed both skipped the real replacement and deleted the user's line.
    lines = existing.splitlines()
    begins = [n for n, ln in enumerate(lines) if ln.strip() == begin]
    ends = [n for n, ln in enumerate(lines) if ln.strip() == end]
    if len(begins) == 1 and len(ends) == 1 and begins[0] < ends[0]:
        before = "\n".join(lines[:begins[0]])
        # A block at the END of the file has nothing to separate from, so it gets a
        # single trailing newline - the same ending the append paths below produce.
        # Emitting "\n\n" unconditionally left one blank line the first re-run added
        # and every later run kept, which showed up as a spurious one-line diff on a
        # rules file people keep in git. Only blank lines are dropped: an indented
        # code block right after the marker keeps its indentation, which lstrip() took.
        rest = lines[ends[0] + 1:]
        while rest and not rest[0].strip():
            rest.pop(0)
        tail = "\n\n" + "\n".join(rest) if rest else "\n"
        return before.rstrip() + "\n\n" + block + tail
    # Malformed: drop the stray marker LINES only. A line that merely mentions a marker
    # is left alone — it is user prose, not a marker.
    cleaned = "\n".join(ln for ln in lines
                        if ln.strip() != begin and ln.strip() != end)
    if cleaned.strip():
        return cleaned.rstrip() + "\n\n" + block + "\n"
    return f"# {heading}\n\n" + block + "\n"


def _remove_block(existing, begin, end):
    """Cut a well-formed BEGIN..END pair out entirely. Mirror of `_replace_block`.

    Returns `(new_text, status)`, status one of `removed` / `absent` / `malformed`.

    The well-formedness bar is deliberately the SAME one `_replace_block` uses to decide
    it may overwrite that span: exactly one BEGIN and one END, in order, each its own
    whole line. Install and uninstall disagreeing about what "the block" is would be the
    worst bug available here — one of them would be operating on a span the other never
    wrote.

    Where the two differ is the fallback. `_replace_block` may REPAIR a malformed file
    (drop stray marker lines, append a fresh block) because its job is to end with a
    correct block present. Uninstall's job is to DELETE from a user-owned file, so an
    ambiguous file is exactly where guessing is unaffordable: leave it byte-identical and
    report `malformed`. A block the user must remove by hand is recoverable; content this
    tool deleted on a guess is not.
    """
    lines = existing.splitlines()
    begins = [n for n, ln in enumerate(lines) if ln.strip() == begin]
    ends = [n for n, ln in enumerate(lines) if ln.strip() == end]
    if len(begins) == 1 and len(ends) == 1 and begins[0] < ends[0]:
        before = "\n".join(lines[:begins[0]]).rstrip()
        # Drop only the blank separator lines the writer put around the block. `strip()`
        # here also ate the LEADING WHITESPACE of the first surviving line, silently
        # re-indenting a user's nested list item or code block that followed the marker.
        tail = lines[ends[0] + 1:]
        while tail and not tail[0].strip():
            tail.pop(0)
        while tail and not tail[-1].strip():
            tail.pop()
        after = "\n".join(tail)
        if before and after:
            return before + "\n\n" + after + "\n", "removed"
        remainder = before or after
        return (remainder + "\n" if remainder else ""), "removed"
    if not begins and not ends:
        return existing, "absent"
    return existing, "malformed"


def _ensure_gitignore(project_root, memory_root):
    if not _same_or_inside(memory_root, project_root):
        return "skipped (memory root is outside project)"
    if memory_root.resolve() == project_root.resolve():
        return "skipped (memory root is the project root)"

    rel = "/" + _display_path(memory_root, project_root).rstrip("/") + "/"
    gitignore = project_root / ".gitignore"
    old = _read_text(gitignore) if gitignore.exists() else ""
    lines = old.splitlines()
    if rel in lines:
        return "already present"
    prefix = old.rstrip() + "\n\n" if old.strip() else ""
    _write_text(
        gitignore,
        prefix
        + "# Engramory live memory store (plain text, machine-local)\n"
        + rel
        + "\n",
        guard_root=project_root,
    )
    return f"added {rel}"


def _ensure_memory_store(source_root, memory_root):
    memory_root.mkdir(parents=True, exist_ok=True)
    index = memory_root / "MEMORY.md"
    # is_symlink() FIRST, and unconditionally. `exists()` follows the link, so a
    # DANGLING `MEMORY.md -> /outside/anything.md` answered False, fell through to the
    # create path, and `copy2` then wrote the template THROUGH the link — creating a
    # file outside the store, which every later recall would read. A planted symlink is
    # exactly the attacker-influenceable input SECURITY.md covers, dangling or not.
    if index.is_symlink():
        raise SystemExit(
            f"refusing to adopt {index}: it is a symlink. The memory index "
            f"must be a real file inside the store.")
    if index.exists():
        # `exists()` follows symlinks, so a planted `MEMORY.md -> /etc/passwd`
        # used to be reported as "kept existing" and every later recall would
        # read that file into the model's context. The store is
        # attacker-influenceable input (SECURITY.md), so refuse an index that
        # resolves outside the store instead of adopting it.
        if not index.is_file():
            raise SystemExit(
                f"refusing to adopt {index}: it is not a regular file.")
        if not _same_or_inside(index, memory_root):
            raise SystemExit(
                f"refusing to adopt {index}: it resolves outside the memory root "
                f"({memory_root}).")
        return "kept existing MEMORY.md"
    template = source_root / "templates" / "MEMORY.md"
    # Stage + os.replace rather than copy2: a copy interrupted by a full disk, an I/O
    # error, or a kill leaves a TRUNCATED index — which the branch above then adopts
    # ("kept existing") on every later run, so the damage is permanent and silent.
    # Either the index appears whole or it does not appear at all.
    _write_text_atomic(index, _read_text(template), guard_root=memory_root)
    return "created MEMORY.md from template"


# Where each host's skill loader actually looks. Codex and OpenClaw follow the Agent
# Skills convention (`.agents/skills`); dsh's filesystem provider scans `<root>/skills`
# instead — project `.dsh/skills`, project `.agents/skills`, then user `<DSH_HOME>/skills`
# and `<AGENTS_HOME>/skills`. Getting this wrong fails SILENTLY: the copy lands and the
# host simply never lists the skill, which is exactly what a dsh dogfood run showed
# before this was parameterised.
DEFAULT_SKILL_DIR = ".agents/skills"


def _host_home(cfg):
    # The host's user-global root: the root_env override when set, else default_root.
    env_var = cfg.get("root_env")
    home = (os.environ.get(env_var, "").strip() if env_var else "") or cfg.get("default_root", ".")
    return Path(home).expanduser()


def _at_host_home(cfg, project_root):
    # Is this install targeting the host's user-global home (vs a single project)?
    try:
        return Path(project_root).resolve() == _host_home(cfg).resolve()
    except OSError:
        return False


def _skill_dir(cfg, project_root=None):
    # Some hosts (dsh) scan DIFFERENT skill roots for the user-global home vs a
    # project: `$DSH_HOME/skills` globally but `<project>/.dsh/skills` in a project.
    # One fixed dir put a project install where the host never looks.
    psd = cfg.get("project_skill_dir")
    if psd and project_root is not None and not _at_host_home(cfg, project_root):
        return psd
    return cfg.get("skill_dir", DEFAULT_SKILL_DIR)


def _skill_root(project_root, cfg):
    return project_root.joinpath(*_skill_dir(cfg, project_root).split("/"), "engramory")


# Exactly what _copy_skill writes into the skill directory. Uninstall removes these
# entries and nothing else, so user files are not removed:
# a user may legitimately keep a memory store at the same path
# (`--memory-root .agents/skills/engramory`), and the fingerprint check below proves
# the directory IS an Engramory skill install - it says nothing about whatever else
# has been put beside it. An rmtree took the notes with it and the report still said
# the store was untouched.
_SKILL_FILES = ("SKILL.md", "rules-snippet.md", "PORTING.md", "AGENT-SETUP.md", "LICENSE")
_SKILL_DIRS = ("templates", "tools")


# What `_copy_skill` puts in each payload directory, by name. A test pins this to the
# repo. Anything else found there is not ours: the store check of a run knows only the
# store THIS run names, and a store another run made inside `tools/` went whole with
# an rmtree of it. Deciding by what we shipped, not by what a store looks like, also
# holds when this script runs from the installed copy itself.
_PAYLOAD_FILES = {
    "templates": ("MEMORY.md", "example-feedback.md", "example-project.md",
                  "knowledge-README.md"),
    "tools": ("engramory_check.py", "engramory_doctor.py", "engramory_init.py",
              "engramory_trace.py"),
}
# Payload files an earlier release shipped and this one does not: still ours to replace or
# remove, so that a reinstall over, or an uninstall of, an older copy is not refused for them.
_FORMER_PAYLOAD_FILES = {
    "tools": ("engramory_sync.py",),  # 1.x: the Codex lifecycle hooks' sync tool, gone in 2.0
}
# Every version of every file in templates/ a release has shipped (sha256, line
# endings as LF). One that matches none has been edited and may be a store's index
# or note (`--memory-root .agents/skills/engramory/templates`). A test checks the
# current files are listed.
_TEMPLATE_SHA256 = frozenset((
    "0dccdd0d50a19182aaba95b224c52b0069505617954f5deea2482acd835c8803",
    "2fc64d4e1e978dcf158a223bc8dc587a5a588ba3c422a4e2603bae89e2cbd3c2",
    "5cdafdd92ebf471b627f234912789ef8eb49ebc64986c9e4c9416b1e7f80783f",
    "64b06a7cf9d3beebc2df33a8e25aa7e06e5d3a835aeadcb471d8ddcb168071bb",
    "6e35ee15a078889dc2d6f648d3706aeba3b6cf3d7f5229de9f1cd55f278db3e0",
    "71e772b5094c228109ca1585dd39a1711093d12b7c8e0d136a3590c6a865941c",
    "c1bea38ce92398022936613603d06106f1fa1f7519c3f284273b219d64d75250",
    "c4e2436b5f432cd26d2e56c82175a4ec39be5091e04f9e8039fd9a86fc1e72fa",
    "d56698204467948cf5103c92570f0b52af3f01ffcbc10790c47f6c179fa1ac2d",
    "dab0b0de71ad4ab1817bd42435b5c3e687914580cac257291c060a3f985cc38a",
    "e3b67068dcd79adb9426f2ef634e4a297f7030ef76dd60e1377b699db6c4b616",
    "e6143c526d55475743d87391bdcf569a2143f88d5d0fadede4b0a8a919367dea",
    "e7e39e046b8cba0f697628443b3b98c56152cb2a89445e96e5403304dbbcbf9d",
))
# No shipped template comes near this; a larger one is not read to be hashed.
_TEMPLATE_MAX_BYTES = 1 << 20


def _not_ours(skill_root, name):
    """Entries at payload name `name` that this installer did not put there.

    Ours: a skill file that is a regular file; a payload directory whose entries are
    the files in _PAYLOAD_FILES (a template only as some release shipped it) and a
    `__pycache__` holding nothing but `.pyc` files. A directory with anything else in
    it is kept whole: deleting around a user's files gains nothing. What cannot be
    read is not known to be ours.
    """
    import hashlib

    path = skill_root / name
    if name in _SKILL_FILES:
        return [name + "/"] if path.is_dir() and not path.is_symlink() else []
    if not path.is_dir() or path.is_symlink():
        return []
    others = []
    try:
        for entry in sorted(path.iterdir()):
            if entry.is_symlink():
                others.append(entry.name)
            elif entry.is_dir():
                if entry.name != "__pycache__" or any(
                        not f.is_file() or f.is_symlink() or f.suffix != ".pyc"
                        for f in entry.iterdir()):
                    others.append(entry.name + "/")
            elif (entry.name not in _PAYLOAD_FILES[name] + _FORMER_PAYLOAD_FILES.get(name, ())
                  or not entry.is_file()):
                # not a regular file (a FIFO would block the read below): not ours
                others.append(entry.name)
            elif name == "templates":
                if entry.stat().st_size > _TEMPLATE_MAX_BYTES:
                    others.append(entry.name + " (edited)")
                    continue
                digest = hashlib.sha256(entry.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
                if digest not in _TEMPLATE_SHA256:
                    others.append(entry.name + " (edited)")
    except OSError as exc:
        others.append("unreadable: %s" % exc)
    return others


def _copy_skill(source_root, project_root, force, skill_dir=DEFAULT_SKILL_DIR):
    rel = f"{skill_dir}/engramory"
    skill_root = project_root.joinpath(*skill_dir.split("/"), "engramory")
    # Re-check containment immediately before the rmtree/copytree, not just in the
    # run's preflight: with --force this DELETES a tree, and a parent swapped for a
    # symlink in between would aim that delete outside the project. Best-effort
    # narrowing, not a closed window — see _write_text_atomic.
    _refuse_symlink_escape(skill_root, project_root, "the skill install dir")
    if skill_root.exists():
        if not force:
            return f"kept existing {rel} (use --force to replace)"
        # Replace our own files only, as uninstall removes them: a store kept at this
        # path (`--memory-root .agents/skills/engramory`) survives, which an rmtree of
        # the whole directory did not; anything not ours inside a payload dir refuses.
        for name in _SKILL_FILES + _SKILL_DIRS:
            others = _not_ours(skill_root, name)
            if others:
                raise SystemExit(
                    "refusing to replace %s: %s holds files this installer did not put "
                    "there (%s) - a memory store, perhaps. Move them out of the skill "
                    "directory first." % (rel, name, ", ".join(others[:3])))
        for name in _SKILL_FILES + _SKILL_DIRS:
            _refuse_symlink_escape(skill_root, project_root, "the skill install dir")
            target = skill_root / name
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            elif target.exists() or target.is_symlink():
                target.unlink()

    skill_root.mkdir(parents=True, exist_ok=True)
    # AGENT-SETUP.md travels with the install so the runbook is still reachable
    # afterwards — an agent asked to check, repair, or upgrade an existing setup needs
    # it exactly then, and the source checkout is often long gone.
    for name in _SKILL_FILES:
        shutil.copy2(source_root / name, skill_root / name)
    for dirname in _SKILL_DIRS:
        shutil.copytree(
            source_root / dirname,
            skill_root / dirname,
            ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"),
        )
    return f"installed {rel}"


def _codex_note(index_display, check_display, protocol_display,
                setup_display="AGENT-SETUP.md", **_kwargs):
    return f"""Codex-specific wiring:

- Keep this store separate from Codex native Memories.
- Before compact, clear, or a fresh thread, run the continuity sync in the protocol.
- After editing `{index_display}`, run `python {check_display} {index_display}`.
- Full protocol reference: `{protocol_display}`.
- To check, repair, or upgrade this install, follow `{setup_display}`."""


def _openclaw_note(index_display, check_display, protocol_display,
                   setup_display="AGENT-SETUP.md", **_kwargs):
    return f"""OpenClaw-specific wiring:

- Keep this Engramory store separate from OpenClaw's own memory; OpenClaw auto-writes
  daily logs under `memory/YYYY-MM-DD.md` (plus an optional curated `MEMORY.md`), while
  Engramory is a user-curated plain folder you control.
- After editing `{index_display}`, run `python {check_display} {index_display}` and
  compact immediately if it reports `OVER`. OpenClaw's deterministic deny path is a
  `before_tool_call` *plugin* hook (TypeScript), NOT Engramory's Python shell hook — so
  the cap here is rules + this check unless you write that plugin (see
  adapters/openclaw/README.md).
- Full protocol reference: `{protocol_display}`.
- Asked to check, repair, or upgrade this Engramory install itself? Follow
  `{setup_display}` — it is the procedure for that, and it is not optional
  guidance: it exists because agents reliably get this wrong unprompted."""


def _dsh_note(index_display, check_display, protocol_display,
              setup_display="AGENT-SETUP.md", **_kwargs):
    return f"""DeepSeek Harness (dsh) specifics:

- This block lives in `$DSH_HOME/AGENTS.md` (default `~/.dsh/AGENTS.md`), which dsh's
  `agent-instructions` plugin loads at the start of every session — its candidate list is
  the hardcoded `["AGENTS.md", "CLAUDE.md"]`, so nothing needs registering.
- Do NOT copy this block into a sibling `CLAUDE.md`. dsh collapses same-directory
  candidates only while they stay byte-identical after trimming; once the two drift, BOTH
  load and the discipline is injected twice.
- The loader enforces a `maxBytes` prompt budget (65536 in the shipped web profile), and
  over budget it drops broader files first, then truncates the most specific one — an
  oversized project `AGENTS.md` can silently cut this block. Keep the memory index inside
  its own cap and this block short.
- After editing `{index_display}`, run `python {check_display} {index_display}` and compact
  immediately if it reports `OVER`. dsh's deterministic deny is the `dsh-engramory`
  plugin (`ctx.tools.guard()`); until it is installed AND running in your profile, the
  cap here is rules + this check (see adapters/dsh/plugin/README.md).
- Full protocol reference: `{protocol_display}`. dsh's filesystem skill provider scans
  `$DSH_HOME/skills` (user-global) and `<project>/.dsh/skills` (project) among its
  roots, so an install there is discovered and offered by relevance; you can also just
  open that path when you want the protocol in full.
- Asked to check, repair, or upgrade this Engramory install itself? Follow
  `{setup_display}` — it is the procedure for that, and it is not optional
  guidance: it exists because agents reliably get this wrong unprompted."""


def _reader_note(index_display, check_display, protocol_display,
                 setup_display="AGENT-SETUP.md", **_kwargs):
    # Read-only reader (host-agnostic): it never writes, so there is no engramory_check
    # step and check_display is intentionally unused (signature kept uniform for _render_block).
    return f"""Read-only wiring:

- Recall from `{index_display}` — the memory index of a store another agent owns and
  writes (Claude Code's auto-memory, a dsh plugin's store, …). You have READ access only.
- NEVER create, edit, move, or delete anything in this store (no new notes, no edits to
  `MEMORY.md`). If you learn something durable, surface it to the user, or keep it in your
  host's own memory if it has one — never in this store.
- Full protocol reference (recall + the write side you do NOT use): `{protocol_display}`.
- Asked to check or change this wiring itself? Follow `{setup_display}`. You are a
  READER here: it will tell you to confirm ownership before anything else."""


# Per-host wiring. All three writers use an always-loaded AGENTS.md, so the only differences
# are the block markers, the default root, and the host-specific note appended under the
# shared rules snippet — plus `skill_dir` where the host scans somewhere other than the
# Agent Skills default (see DEFAULT_SKILL_DIR).
HOST_CONFIG = {
    "codex": {
        "label": "Codex",
        "begin": "<!-- BEGIN ENGRAMORY CODEX -->",
        "end": "<!-- END ENGRAMORY CODEX -->",
        "default_root": ".",
        "note": _codex_note,
    },
    "openclaw": {
        "label": "OpenClaw",
        "begin": "<!-- BEGIN ENGRAMORY OPENCLAW -->",
        "end": "<!-- END ENGRAMORY OPENCLAW -->",
        "default_root": "~/.openclaw/workspace",
        "note": _openclaw_note,
    },
    "dsh": {
        "label": "DeepSeek Harness",
        "begin": "<!-- BEGIN ENGRAMORY DSH -->",
        "end": "<!-- END ENGRAMORY DSH -->",
        # $DSH_HOME: both the user-global instruction scope dsh reads every session
        # (AGENTS.md) and, under `skills/`, its rank-400 user skill root. The env var
        # is dsh's own contract for relocating that home, so honour it (root_env);
        # hardcoding `~/.dsh` wrote a config dsh would then never read.
        "default_root": "~/.dsh",
        "root_env": "DSH_HOME",
        "skill_dir": "skills",
        # A PROJECT's skill roots are `<project>/.dsh/skills` / `<project>/.agents/skills`
        # — NOT `<project>/skills`. Installing there succeeded and was never discovered:
        # installable-but-inert, the same failure class as the missing bundle manifest.
        "project_skill_dir": ".dsh/skills",
        # dsh's file tools resolve relative paths against the SESSION cwd, and the
        # user-global AGENTS.md is read from any cwd — a relative store path in that
        # block pointed at `<whatever-repo>/.engramory-memory`. Global installs render
        # absolute paths; a project block stays relative (its session cwd IS the
        # project) so the repo can move without the wiring going stale.
        "absolute_paths": True,
        "note": _dsh_note,
    },
}


# Read-only READER hosts ("<host>-reader"): wire an agent to RECALL from a store that
# ANOTHER agent (Claude Code, dsh, …) owns and writes — one writer, N readers. The recall
# discipline is identical and host-agnostic; the ONLY per-host difference is which
# always-loaded rules file it lands in (and, for Cursor, the frontmatter that file
# needs). Every reader creates no store, touches no .gitignore, installs no write tools, and
# uses the shared read-only snippet (no write protocol). It injects either as a marked block
# in a shared rules file (default) or — when `frontmatter` is set — as a dedicated
# always-loaded rule file. `tested` marks the wiring dogfooded on a real machine here; the
# rest are built from each host's DOCUMENTED rules-file format but NOT verified to load
# (Engramory's honesty rule — see adapters/reader/README.md).
READER_HOSTS = {
    "codex":    {"label": "Codex",       "rules_file": "AGENTS.md",      "tested": True},
    "claude":   {"label": "Claude Code", "rules_file": "CLAUDE.md",      "tested": True},
    "openclaw": {"label": "OpenClaw",    "rules_file": "AGENTS.md",      "tested": False},
    "hermes":   {"label": "Hermes",      "rules_file": "AGENTS.md",      "tested": False},
    "dsh":      {"label": "DeepSeek Harness", "rules_file": "AGENTS.md", "tested": True},
    "cline":    {"label": "Cline",       "rules_file": ".clinerules",    "tested": False},
    "windsurf": {"label": "Windsurf",    "rules_file": ".windsurfrules", "tested": False},
    "cursor":   {"label": "Cursor",      "rules_file": ".cursor/rules/engramory-recall.mdc",
                 "frontmatter": "---\ndescription: Engramory read-only memory recall\nalwaysApply: true\n---",
                 "tested": False},
}

# The first line under the frontmatter of a dedicated rule file (Cursor `.mdc`) this
# installer writes. A file at that path without it may be the user's:
# init keeps it unless --force, --uninstall leaves it. That includes one an older
# version wrote, which had no mark: its content cannot tell it from a user's edit.
GENERATED_MARK = ("<!-- Written by engramory_init.py: running it again rewrites this file "
                  "and --uninstall deletes it. Keep your own rules in another file. -->")


def _generated_rule_file(text, cfg):
    """Did this installer write this dedicated rule file?"""
    head = cfg["frontmatter"] + "\n\n"
    text = text.lstrip("\ufeff").replace("\r\n", "\n")
    return text.startswith(head + GENERATED_MARK)


def _reader_config(host, spec):
    up = host.upper()
    cfg = {
        "label": f"{spec['label']} (read-only)",
        "begin": f"<!-- BEGIN ENGRAMORY {up}-READER -->",
        "end": f"<!-- END ENGRAMORY {up}-READER -->",
        "default_root": ".",
        "creates_store": False,
        "snippet": "adapters/reader/reader-snippet.md",
        "note": _reader_note,
        "rules_file": spec["rules_file"],
        "tested": spec["tested"],
    }
    if "frontmatter" in spec:
        cfg["frontmatter"] = spec["frontmatter"]
    return cfg


# codex-reader, claude-reader, cursor-reader, … alongside the write hosts.
HOST_CONFIG.update({f"{h}-reader": _reader_config(h, s) for h, s in READER_HOSTS.items()})


def _snippet_body(text):
    """Drop the human-facing install header above the snippet's first `---` rule.

    Each snippet opens with instructions for the PERSON deciding where to paste it
    ("Paste this into your host's **always-loaded** rules (Claude Code: `CLAUDE.md` …)").
    That header used to be rendered verbatim into the block the AGENT reads at the start
    of every session: wasted tokens, and on a non-Claude host it actively misdirects —
    telling the agent to go paste something into a file its host never reads. A captured
    dsh request confirmed it was reaching the model. Only what follows the rule is
    protocol; a snippet without one is used whole.
    """
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if i and line.strip() == "---":  # `if i`: a first-line rule would be frontmatter
            return "\n".join(lines[i + 1:]).strip()
    return text.strip()


def _render_block(
        cfg,
        source_root,
        project_root,
        memory_root,
        install_skill):
    snippet = _snippet_body(_read_text(source_root / cfg.get("snippet", "rules-snippet.md")))
    # absolute_paths (dsh): the host resolves relative paths against the SESSION cwd,
    # not against the file carrying this block — a relative path in a USER-GLOBAL
    # block silently points into whatever repo the session happens to run in. Only
    # the global install goes absolute: a project block keeps relative paths (its
    # session cwd IS the project), so the repo can move or be cloned without the
    # wiring going stale.
    absolute = bool(cfg.get("absolute_paths")) and _at_host_home(cfg, project_root)
    if absolute:
        memory_display = Path(memory_root).expanduser().resolve().as_posix()
    else:
        memory_display = _display_path(memory_root, project_root)
    index_display = (Path(memory_display) / "MEMORY.md").as_posix()
    snippet = snippet.replace("<MEMORY_ROOT>", memory_display)

    if install_skill:
        skill_dir = _skill_dir(cfg, project_root)
        if absolute:
            skill_rel = (Path(project_root) / skill_dir / "engramory").resolve().as_posix()
        else:
            skill_rel = f"{skill_dir}/engramory"
        protocol_display = f"{skill_rel}/SKILL.md"
        check_display = f"{skill_rel}/tools/engramory_check.py"
        setup_display = f"{skill_rel}/AGENT-SETUP.md"
    elif absolute:
        protocol_display = (source_root / "SKILL.md").resolve().as_posix()
        check_display = (source_root / "tools" / "engramory_check.py").resolve().as_posix()
        setup_display = (source_root / "AGENT-SETUP.md").resolve().as_posix()
    else:
        protocol_display = _display_path(source_root / "SKILL.md", project_root)
        check_display = _display_path(source_root / "tools" / "engramory_check.py", project_root)
        setup_display = _display_path(source_root / "AGENT-SETUP.md", project_root)

    note = cfg["note"](
        index_display,
        check_display,
        protocol_display,
        setup_display=setup_display,
    )
    body = snippet + "\n\n" + note
    fm = cfg.get("frontmatter")
    if fm:
        # A dedicated always-loaded rule file (e.g. Cursor `.mdc`): the whole
        # file is ours, so no block markers — the host-required frontmatter, the mark that
        # says who wrote it, and the recall body.
        return fm + "\n\n" + GENERATED_MARK + "\n\n" + body + "\n"
    return cfg["begin"] + "\n" + body + "\n" + cfg["end"]


def _require_sources(
        source_root,
        install_skill,
        snippet_rel="rules-snippet.md"):
    # Fail fast with a clear message (before any side effects) if the repo this tool
    # ships in is incomplete, instead of a raw FileNotFoundError mid-copy. `snippet_rel`
    # is the host's rules snippet (default rules-snippet.md; a read-only host uses its own).
    required = ["templates/MEMORY.md", "rules-snippet.md", "SKILL.md",
                "tools/engramory_check.py", "tools/engramory_doctor.py", snippet_rel]
    if install_skill:
        required += ["PORTING.md", "LICENSE"]
    required = list(dict.fromkeys(required))  # dedup (snippet_rel may be rules-snippet.md)
    missing = [r for r in required if not (source_root / r).exists()]
    if missing:
        raise SystemExit("Engramory source files missing (reinstall the repo): "
                         + ", ".join(missing))


# --- Uninstall -------------------------------------------------------------------
#
# The store is NEVER touched. Everything below removes only wiring this installer
# wrote: the marked rules block, and the copied skill tree.
# Memories are the user's data and the only artefact here that cannot be regenerated
# from the repo, so "uninstall" means "unwire the host", never "delete the notes".


def _refuse_store_overlap(path, memory_root, what):
    """Refuse to delete anything that is, or contains, the memory store.

    The install-time overlap guards only fire for the flags that create the artefact
    (`--install-skill`), so a plain `init` accepts
    `--memory-root .codex/engramory` and a later uninstall would have recursively
    deleted the store. Nothing here is worth a note.
    """
    if _same_or_inside(memory_root, path) or _same_or_inside(path, memory_root):
        raise SystemExit(
            "refusing to remove %s (%s): it overlaps the memory store at %s. "
            "Move the store, or delete the wiring by hand — uninstall never deletes "
            "memories." % (what, path, memory_root))


def _write_hosts_still_using_skill(host, cfg, project_root):
    """Other WRITE hosts whose rules block is still installed at the same skill root.

    `codex` and `openclaw` resolve the same `.agents/skills/engramory` AND the same
    AGENTS.md, so uninstalling one deleted the skill the other was still using: its
    block stayed in the rules file, the skill that block refers to did not, and
    nothing said so - the silent-failure shape this project keeps running into. The
    reader/writer version of this collision was already handled next door; this is its
    write-host twin.

    Checked AFTER the rules block for THIS host has been removed, so a leftover block
    means another host genuinely still wants the skill.
    """
    mine = _skill_root(project_root, cfg)
    still = []
    for name, other in HOST_CONFIG.items():
        if name == host or not other.get("creates_store", True):
            continue
        if _skill_root(project_root, other) != mine:
            continue
        rules = project_root / other.get("rules_file", "AGENTS.md")
        try:
            if rules.is_file() and other["begin"] in _read_text(rules):
                still.append(name)
        except OSError:
            continue  # unreadable rules file: cannot prove it is in use, do not guess
    return still


def _uninstall_skill(project_root, cfg, memory_root, dry_run):
    # `_skill_root` consults $DSH_HOME to decide whether this root is the host's home
    # (`<DSH_HOME>/skills`) or a project (`<project>/.dsh/skills`), so an uninstall run
    # with a DIFFERENT $DSH_HOME than the install resolves a different directory. It
    # then finds nothing to remove and says so; the fingerprint check below is what
    # keeps that miss from turning into a delete of whatever else lives at the new path.
    skill_root = _skill_root(project_root, cfg)
    display = _display_path(skill_root, project_root)
    if not skill_root.exists():
        return "absent (%s)" % display
    # Only delete a directory that is recognisably THIS installer's output. A lone
    # SKILL.md proves the directory is *a* skill, not that it is ours — someone else's
    # skill that happens to be named `engramory` would have been rmtree'd. Require the
    # full set `_copy_skill` writes; a partially-copied install is reported, not deleted.
    fingerprint = ("SKILL.md", "rules-snippet.md", "PORTING.md", "AGENT-SETUP.md")
    missing = [n for n in fingerprint if not (skill_root / n).is_file()]
    if missing:
        return ("left %s (missing %s - not recognisable as an Engramory skill install)"
                % (display, ", ".join(missing)))
    _refuse_store_overlap(skill_root, memory_root, "the skill install dir")
    try:
        entries = sorted(e.name for e in skill_root.iterdir())
    except OSError as exc:
        return "left %s (could not read it: %s)" % (display, exc)
    # Our own payload, and nothing else. A store kept at this same path shows up in
    # `others` and survives - which is the whole point. (`templates/` legitimately
    # contains a MEMORY.md of its own, so "holds an index" is not a usable signal for
    # the payload directories; the store that matters sits at the root.)
    payload = [n for n in (_SKILL_FILES + _SKILL_DIRS) if n in entries]
    held = {n: _not_ours(skill_root, n) for n in payload}
    held = {n: o for n, o in held.items() if o}
    payload = [n for n in payload if n not in held]
    others = [n for n in entries if n not in payload]
    kept = "".join("; KEPT %s whole: it holds files this installer did not put there (%s)"
                   % (n, ", ".join(o[:3])) for n, o in held.items())
    if dry_run:
        if payload and not others:
            return "would remove %s" % display
        if payload:
            return ("would remove %d entr%s from %s and keep %d other%s (%s)%s"
                    % (len(payload), "y" if len(payload) == 1 else "ies", display,
                       len(others), "" if len(others) == 1 else "s",
                       ", ".join(others[:3]), kept))
        return "would leave %s (nothing in it is recognisably ours)%s" % (display, kept)
    removed, failed = [], []
    for name in payload:
        # Re-check containment immediately before each delete, exactly as _copy_skill
        # does: a parent swapped for a symlink in between would aim it outside the
        # project.
        _refuse_symlink_escape(skill_root, project_root, "the skill install dir")
        target = skill_root / name
        try:
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            else:
                target.unlink()
            removed.append(name)
        except OSError as exc:
            failed.append("%s (%s)" % (name, exc))
    note = kept
    if failed:
        note += "; could NOT remove %s" % "; ".join(failed)
    if removed and not others and not failed:
        try:
            skill_root.rmdir()
            return "removed %s" % display
        except OSError as exc:
            return "emptied %s but kept the directory (%s)" % (display, exc)
    if removed:
        return ("removed the skill payload from %s; KEPT the directory - %d entr%s in "
                "it %s not ours (%s)%s"
                % (display, len(others), "y" if len(others) == 1 else "ies",
                   "is" if len(others) == 1 else "are", ", ".join(others[:3]), note))
    return "left %s (nothing in it is recognisably ours)%s" % (display, note)


def uninstall_host(args, host):
    """Remove the wiring `init_host` installed for `host`. Never touches the store."""
    cfg = HOST_CONFIG[host]
    if args.install_skill:
        raise SystemExit(
            "--uninstall removes whatever this host installed; do not combine it "
            "with --install-skill")
    root_arg = args.project_root
    if root_arg is None:
        root_arg = str(_host_home(cfg))
    project_root = Path(root_arg).expanduser().resolve()
    rules_file = cfg.get("rules_file", "AGENTS.md")
    target = project_root / rules_file
    dry = args.dry_run
    # Resolved up front: every deletion below is checked against it, so it cannot be
    # computed after the fact.
    memory_root = Path(args.memory_root).expanduser()
    if not memory_root.is_absolute():
        memory_root = project_root / memory_root
    memory_root = memory_root.resolve()

    # Preflight, before ANY side effect - the same order init_host uses. Every path this
    # run could delete is checked against the store first, so an overlap refuses the whole
    # uninstall instead of taking the rules block with it and then stopping. The
    # install-time guards only fire for the flags that create the artefact, so a plain
    # `init --memory-root .codex/engramory` is accepted and only shows up here.
    doomed = [(target, "the host rule file")]
    if cfg.get("creates_store", True):
        doomed.append((_skill_root(project_root, cfg), "the skill install dir"))
    for path, what in doomed:
        _refuse_store_overlap(path, memory_root, what)

    results = []

    # 1. The rules wiring.
    if cfg.get("frontmatter"):
        # A dedicated file this installer writes whole (Cursor .mdc): it is
        # ours only when it starts the way init writes it (_generated_rule_file).
        display = _display_path(target, project_root)
        if not target.exists():
            results.append((rules_file, "absent (%s)" % display))
        elif not _generated_rule_file(_read_text(target), cfg):
            results.append((rules_file,
                            "left %s (it does not carry the mark of this installer - "
                            "versions before 1.0.3 wrote none; delete it yourself if one "
                            "of them wrote it)" % display))
        elif dry:
            results.append((rules_file, "would remove %s" % display))
        else:
            # A parent of this dedicated file (e.g. `.cursor/rules`) may be a symlink
            # out of the project; unlink() would then delete a file outside it.
            _refuse_symlink_escape(target, project_root, "the host rule file")
            _refuse_store_overlap(target, memory_root, "the host rule file")
            target.unlink()
            results.append((rules_file, "removed %s" % display))
    elif not target.exists():
        results.append((rules_file, "absent (%s)" % _display_path(target, project_root)))
    else:
        old = _read_text(target)
        new, status = _remove_block(old, cfg["begin"], cfg["end"])
        display = _display_path(target, project_root)
        if status == "absent":
            results.append((rules_file, "no Engramory block in %s" % display))
        elif status == "malformed":
            results.append((rules_file,
                            "LEFT UNTOUCHED: %s has stray/duplicated Engramory markers, "
                            "so the block's extent is ambiguous - remove the %s .. %s "
                            "span by hand" % (display, cfg["begin"], cfg["end"])))
        elif dry:
            results.append((rules_file,
                            "would remove the Engramory block from %s" % display))
        elif new.strip():
            _write_text(target, new, guard_root=project_root)
            results.append((rules_file,
                            "removed the Engramory block from %s" % display))
        else:
            # Nothing of the user's was in there - the file existed only to carry it.
            target.unlink()
            results.append((rules_file, "removed %s (it held only the block)" % display))

    # 2. The skill copy — write hosts only. A reader is REFUSED --install-skill at
    #    install time, so it has none of its own; letting it delete one would have had
    #    `codex-reader --uninstall` wipe the skill that the Codex WRITE host installed
    #    at the same shared `.agents/skills/engramory` path.
    if cfg.get("creates_store", True):
        shared_with = _write_hosts_still_using_skill(host, cfg, project_root)
        if shared_with:
            results.append(("skill", "left %s (still wired up for %s)" % (
                _display_path(_skill_root(project_root, cfg), project_root),
                ", ".join(shared_with))))
        else:
            results.append(("skill", _uninstall_skill(project_root, cfg, memory_root, dry)))
    else:
        results.append(("skill", "skipped (a reader installs none)"))

    verb = "Would uninstall" if dry else "Uninstalled"
    print("%s Engramory wiring for %s in %s" % (verb, cfg["label"], project_root))
    for label, detail in results:
        print("  %s: %s" % (label, detail))
    print("")
    # Only claim the store is safe when we can see the store. `memory_root` is
    # resolved from THIS invocation, so an uninstall run without the original
    # `--memory-root` names the default path — and printing "your notes are fine"
    # about a directory that does not exist is a promise about the wrong place.
    if memory_root.is_dir():
        print("  memory store: NOT touched - %s" % memory_root)
        print("  Your notes, the store's .gitignore entry, and any git history are left "
              "exactly as they are.")
        print("  Delete the store yourself if you truly want the memories gone.")
    else:
        print("  memory store: no store found at %s" % memory_root)
        print("  Uninstall deletes only files it recognises as its own (by name and "
              "content), so a store kept somewhere else was not touched either -")
        print("  but nothing was verified about it. Pass --memory-root <path> to have "
              "this report name your real store.")
    if dry:
        print("")
        print("  (--dry-run: nothing was written)")
    return 0


def init_host(args, host):
    cfg = HOST_CONFIG[host]
    source_root = _repo_root()
    _require_sources(
        source_root,
        args.install_skill,
        cfg.get("snippet", "rules-snippet.md"),
    )
    root_arg = args.project_root
    if root_arg is None:
        # No explicit root: the host's own relocation env var (e.g. $DSH_HOME) wins
        # over the baked-in default — otherwise the config lands where the host
        # never reads it.
        root_arg = str(_host_home(cfg))
    project_root = Path(root_arg).expanduser().resolve()
    memory_root = Path(args.memory_root).expanduser()
    if not memory_root.is_absolute():
        memory_root = project_root / memory_root
    memory_root = memory_root.resolve()

    if memory_root == project_root:
        raise SystemExit("memory root must be a directory inside or outside the project, not the project root itself")

    # --install-skill (re)creates .agents/skills/engramory — with --force by rmtree'ing
    # it first. If the memory store overlaps that directory, installing the skill would
    # DELETE the store (--force), or mistake a store-only dir for an installed skill
    # (without it). Refuse the overlap up front, before any side effect.
    if args.install_skill:
        skill_root = _skill_root(project_root, cfg)
        if _same_or_inside(memory_root, skill_root) or _same_or_inside(skill_root, memory_root):
            raise SystemExit(
                f"--memory-root ({memory_root}) overlaps the skill install dir "
                f"({skill_root}); --install-skill (re)creates that directory and with "
                f"--force would delete the memory store inside it. Put the store "
                f"somewhere else (default: .engramory-memory).")
    # A read-only host (creates_store=False) never creates or touches the store — it only
    # wires the host to RECALL from a store another agent owns and writes. Enforce that up
    # front (before any side effect / directory creation) with clear messages:
    creates_store = cfg.get("creates_store", True)
    rules_file = cfg.get("rules_file", "AGENTS.md")
    target = project_root / rules_file
    if not creates_store:
        # It installs no skill and no write tools — only a recall block. Passing
        # --install-skill would copy engramory_check/doctor etc., contradicting that.
        if args.install_skill:
            raise SystemExit(
                f"read-only host '{host}': --install-skill is not supported — a reader installs "
                f"no skill and no write tools, it only adds a recall block to the host's rules "
                f"file. Re-run without --install-skill.")
        # The reader writes its rules file (project_root / rules_file) and mkdir's the dirs to
        # it. If EITHER that file or --project-root resolves inside the store, the write would
        # modify the very store the reader must not touch — refuse. Checking the resolved TARGET
        # (not just project_root) also catches a nested rules file (e.g. Cursor
        # .cursor/rules/*.mdc) landing inside a store like <root>/.cursor.
        if _same_or_inside(project_root, memory_root) or _same_or_inside(target, memory_root):
            raise SystemExit(
                f"read-only host '{host}': its rules file ({target}) or --project-root "
                f"({project_root}) resolves inside the memory store ({memory_root}) — writing "
                f"there would modify the read-only store. Point --project-root outside the store "
                f"(e.g. ~/.codex).")
        # The store must already exist; this host never creates one.
        if not (memory_root / "MEMORY.md").is_file():
            raise SystemExit(
                f"read-only host '{host}': no MEMORY.md at {memory_root} — pass --memory-root "
                f"pointing at an EXISTING memory store (e.g. Claude Code's memory directory, "
                f"~/.claude/projects/<project>/memory). This host never creates a store.")
        # …and its index must actually RESOLVE inside the store. `is_file()` follows
        # symlinks, so a planted MEMORY.md -> /outside/file passed, and the generated
        # read-only rules then directed every session to read an arbitrary external
        # file — the exact read primitive root confinement exists to stop (the doctor
        # and the writer paths already enforce this same boundary).
        if not _same_or_inside(memory_root / "MEMORY.md", memory_root):
            raise SystemExit(
                f"read-only host '{host}': MEMORY.md at {memory_root} resolves outside "
                f"the memory store (symlink escape) — refusing to wire recall to it. "
                f"Point --memory-root at a store whose index is a regular file inside it.")

    # Preflight EVERY path this run will write — BEFORE any side effect (mkdir, store,
    # gitignore, skill, rules file) — so a symlink-escape refusal can never leave a
    # partial init behind. The gitignore/skill checks mirror the conditions under which
    # those writes actually happen, so an escaped-but-unused path is not a false refusal.
    _refuse_symlink_escape(target, project_root, rules_file)
    if creates_store and _same_or_inside(memory_root, project_root):
        _refuse_symlink_escape(project_root / ".gitignore", project_root, ".gitignore")
    if args.install_skill:
        _refuse_symlink_escape(_skill_root(project_root, cfg),
                               project_root, "the skill install dir")
    project_root.mkdir(parents=True, exist_ok=True)

    results = []
    try:
        _run_install_steps(args, cfg, source_root, project_root, memory_root,
                           creates_store, rules_file, target, results)
    # UnicodeError too: _read_text is strict UTF-8, so an existing .gitignore or rules
    # file in another encoding raises UnicodeDecodeError (a ValueError, not an OSError)
    # AFTER earlier steps have already written — exactly when the report is needed.
    except (SystemExit, KeyboardInterrupt, OSError, UnicodeError, shutil.Error):
        # Nothing is rolled back: several targets are user-owned files that this
        # installer must not delete on the way out. Say exactly what did land, so the
        # user is never left guessing which half of an install they have.
        _report_partial(results, args, _skill_dir(cfg, project_root))
        raise

    print(f"Engramory {cfg['label']} init complete")
    print(f"project root: {_display_path(project_root, Path.cwd())}")
    print(f"memory root: {_display_path(memory_root, project_root)}")
    for label, message in results:
        print(f"- {label}: {message}")
    # A reader host whose wiring hasn't been dogfooded here: write it per the documented
    # rules-file format, but tell the user plainly it's unverified (honesty rule).
    if "tested" in cfg and not cfg["tested"]:
        print(f"NOTE: this reader wiring for {cfg['label']} is written from {rules_file}'s "
              f"documented format but has NOT been verified on a real host here — confirm your "
              f"host actually loads {rules_file} as an always-on rule.")
    return 0


def _report_partial(results, args, skill_dir=DEFAULT_SKILL_DIR):
    """Report a half-finished install honestly. Re-running is NOT unconditionally safe.

    Each step is individually recoverable, but two of them keep whatever a failed
    earlier run left behind — a truncated `MEMORY.md` is adopted as "kept existing",
    and a half-copied skill dir is kept without `--force`. Naming those two beats a
    blanket "just re-run it".
    """
    out = sys.stderr
    print("Engramory init FAILED partway. Nothing was rolled back.", file=out)
    if results:
        print("completed before the failure:", file=out)
        for label, message in results:
            print(f"- {label}: {message}", file=out)
    else:
        print("- (no step completed)", file=out)
    print("the step that failed may have written PART of its output; every later step "
          "did not run at all.", file=out)
    print("re-running is safe for .gitignore and the rules block, but check by hand "
          "first:", file=out)
    print("  - MEMORY.md: a truncated index is KEPT ('kept existing MEMORY.md') on the "
          "next run — open it, and delete it if it is incomplete", file=out)
    if args.install_skill:
        print(f"  - {skill_dir}/engramory: a half-copied dir is KEPT without --force "
              "— re-run with --force to replace it", file=out)


def _run_install_steps(args, cfg, source_root, project_root, memory_root,
                       creates_store, rules_file, target, results):
    """Perform the writes, appending each completed step to `results` as it lands."""
    if creates_store:
        results.append(("memory", _ensure_memory_store(source_root, memory_root)))
        results.append(("gitignore", _ensure_gitignore(project_root, memory_root)))
    else:
        results.append(("memory", f"read-only — using existing store at {memory_root} (not created/modified)"))
        results.append(("gitignore", "skipped (read-only host does not manage the store)"))

    skill_result = "not requested"
    if args.install_skill:
        skill_result = _copy_skill(source_root, project_root, args.force,
                                   _skill_dir(cfg, project_root))
    results.append(("skill", skill_result))

    block = _render_block(
        cfg,
        source_root,
        project_root,
        memory_root,
        args.install_skill,
    )
    if cfg.get("frontmatter"):
        # A dedicated rule file (Cursor): written whole, but over another file at that
        # path only with --force — it may be the user's own.
        # a link whose target is missing is something there too, and not ours to replace
        if ((target.exists() or target.is_symlink()) and not args.force
                and not (target.exists() and _generated_rule_file(_read_text(target), cfg))):
            results.append((rules_file, "kept existing %s (it does not carry the mark of this "
                            "installer - versions before 1.0.3 wrote none; use --force to "
                            "replace)" % _display_path(target, project_root)))
        else:
            _write_text(target, block, guard_root=project_root)
            results.append((rules_file, f"wrote Engramory {cfg['label']} rule file"))
    else:
        old = _read_text(target) if target.exists() else ""
        _write_text(target, _replace_block(old, block, cfg["begin"], cfg["end"],
                                           heading=Path(rules_file).name),
                    guard_root=project_root)
        results.append((rules_file, f"created/updated Engramory {cfg['label']} block"))


def build_parser():
    parser = argparse.ArgumentParser(description="Bootstrap Engramory for an agent host.")
    parser.add_argument("host", nargs="?", default="codex", choices=tuple(HOST_CONFIG),
                        help="host to initialize: write hosts (codex, openclaw, dsh) or a read-only "
                             "reader host '<host>-reader' (codex-reader, claude-reader, "
                             "cursor-reader, cline-reader, etc.)")
    parser.add_argument("--project-root", default=None,
                        help="project/workspace root (default: '.'; openclaw defaults to "
                             "~/.openclaw/workspace, dsh to ~/.dsh)")
    parser.add_argument(
        "--memory-root",
        default=".engramory-memory",
        help="memory store path; relative paths are resolved under --project-root. For a "
             "read-only '<host>-reader' this MUST be an EXISTING store (it is not created), "
             "e.g. Claude Code's memory dir ~/.claude/projects/<project>/memory",
    )
    parser.add_argument("--install-skill", action="store_true",
                        help="copy Engramory into the host's skill root (.agents/skills/engramory; "
                             "dsh: <DSH_HOME>/skills/engramory)")
    parser.add_argument("--force", action="store_true",
                        help="replace the installed skill and "
                             "a Cursor rule file this installer did not write")
    parser.add_argument(
        "--uninstall",
        action="store_true",
        help="remove this host's Engramory wiring (rules block and installed skill). The memory store is never touched - delete it yourself if you "
             "want the notes gone.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="with --uninstall: report what would be removed without writing anything",
    )
    return parser


def main(argv):
    # Keep stdout from crashing on a strict OEM/ascii console (Windows cp437/cp850 or a POSIX
    # C/ascii locale): --help and the result lines use an em-dash / other non-ASCII, which those
    # codepages can't encode and would otherwise raise UnicodeEncodeError. Matches engramory_doctor
    # / engramory_check. Run before parse_args so --help output is guarded too.
    try:
        sys.stdout.reconfigure(errors="backslashreplace")
    except (AttributeError, ValueError, OSError):
        pass
    args = build_parser().parse_args(argv[1:])
    if args.uninstall:
        return uninstall_host(args, args.host)
    # --dry-run describes an uninstall plan; there is no install equivalent, and silently
    # ignoring it on an install would let a cautious "let me preview this" run write to
    # the user's rules file for real.
    if args.dry_run:
        raise SystemExit("--dry-run is only meaningful with --uninstall")
    return init_host(args, args.host)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
