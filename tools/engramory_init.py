#!/usr/bin/env python3
"""
engramory_init - bootstrap Engramory for an agent host.

Usage:

    python tools/engramory_init.py codex          --project-root <repo> --install-skill
    python tools/engramory_init.py codex          --project-root <repo> --install-hooks --mode explicit
    python tools/engramory_init.py openclaw                              --install-skill
    python tools/engramory_init.py dsh                                   --install-skill
    python tools/engramory_init.py <host>-reader   --project-root <cfg>  --memory-root <existing store>

For a WRITE host (codex, openclaw, dsh) the command creates a local memory store, adds a marked
Engramory block to the host's always-loaded AGENTS.md, optionally installs the Engramory skill
where that host's loader actually scans (`.agents/skills/engramory` for Codex and OpenClaw,
`<DSH_HOME>/skills/engramory` for dsh), and adds the memory store to .gitignore when the store
lives inside the project/workspace.

For the Codex writer, `--install-hooks` also installs project-scoped
SessionStart/UserPromptSubmit/PreCompact assistance under `.codex/`. The hooks
track only synchronization bookkeeping; the agent still performs the semantic
Engramory sync. `--mode explicit` is the default; `assisted` adds proactive
milestone guidance.

A READ-ONLY reader host `<host>-reader` (codex-reader, claude-reader, cursor-reader, kiro-reader,
cline-reader, windsurf-reader, openclaw-reader, hermes-reader, dsh-reader) instead wires that host to *recall*
from a store ANOTHER agent (typically Claude Code) owns and writes — one writer, N readers. It
creates no store, touches no .gitignore, installs no write tools, and uses a recall-only snippet
(no write protocol). `--memory-root` MUST point at an existing store (e.g. Claude Code's memory
dir). It injects into the host's own always-loaded rules file (AGENTS.md / CLAUDE.md / .clinerules
/ Cursor .mdc / Kiro steering …); a marked block coexists with other Engramory blocks. Only the
codex-reader and dsh-reader wirings are verified against their real hosts — the others are
built from each host's documented
rules-file format but printed with an "unverified" note. See adapters/reader/README.md.

Defaults: --project-root '.', except openclaw (~/.openclaw/workspace) and dsh (~/.dsh).
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
        after = "\n".join(lines[ends[0] + 1:])
        return before.rstrip() + "\n\n" + block + "\n\n" + after.lstrip()
    # Malformed: drop the stray marker LINES only. A line that merely mentions a marker
    # is left alone — it is user prose, not a marker.
    cleaned = "\n".join(ln for ln in lines
                        if ln.strip() != begin and ln.strip() != end)
    if cleaned.strip():
        return cleaned.rstrip() + "\n\n" + block + "\n"
    return f"# {heading}\n\n" + block + "\n"


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
        shutil.rmtree(skill_root)

    skill_root.mkdir(parents=True, exist_ok=True)
    # AGENT-SETUP.md travels with the install so the runbook is still reachable
    # afterwards — an agent asked to check, repair, or upgrade an existing setup needs
    # it exactly then, and the source checkout is often long gone.
    for name in ("SKILL.md", "rules-snippet.md", "PORTING.md", "AGENT-SETUP.md", "LICENSE"):
        shutil.copy2(source_root / name, skill_root / name)
    for dirname in ("templates", "tools"):
        shutil.copytree(
            source_root / dirname,
            skill_root / dirname,
            ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"),
        )
    return f"installed {rel}"


def _codex_note(
        index_display,
        check_display,
        protocol_display,
        mode="explicit",
        hooks_installed=False,
        setup_display="AGENT-SETUP.md",
        **_kwargs):
    hook_lines = ""
    if hooks_installed:
        hook_lines = f"""
- Project lifecycle hooks are installed in `.codex/hooks.json`. Inspect and trust
  them with `/hooks`; untrusted project hooks do not run.
- `SessionStart` points Codex back to the index, and `PreCompact` stops a dirty
  *manual* compact. Automatic compaction warns and marks reconciliation pending
  instead of hard-blocking at an already-full context window.
- After the Engramory sync workflow is genuinely complete, run the exact
  `mark-synced` command supplied by the hook. It includes the current session
  identifier and only records the completed sync; it does not create or
  summarize memory for you."""
    else:
        hook_lines = """
- Codex lifecycle hooks were not installed. Before compact, clear, or a fresh
  thread, explicitly run the Engramory sync workflow from the protocol."""

    return f"""Codex-specific wiring:

- Keep this Engramory store separate from Codex native Memories; Codex native
  Memories are generated state, while Engramory is a user-auditable plain folder.
- Capture mode is `{mode}`: `explicit` syncs on request or at a continuity
  boundary; `assisted` also asks Codex to sync proactively at meaningful
  milestones. Neither mode silently invents a semantic summary.
- If you edit `{index_display}` and no pre-write hook is installed, run
  `python {check_display} {index_display}` after the write; compact immediately
  if it reports `OVER`.{hook_lines}
- Full protocol reference: `{protocol_display}`.
- Asked to check, repair, or upgrade this Engramory install itself? Follow
  `{setup_display}` — it is the procedure for that, and it is not optional
  guidance: it exists because agents reliably get this wrong unprompted."""


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
  immediately if it reports `OVER`. dsh's deterministic deny path is `ctx.tools.guard()`
  inside a *TypeScript* plugin — `dsh-engramory` ships exactly that, but until it is
  installed AND running in your profile (upstream `dsh plugin` cannot mount third-party
  plugins yet), the cap here is rules + this check (see adapters/dsh/README.md).
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

- Recall from `{index_display}` — the memory index of a store another agent (typically
  Claude Code's native auto-memory) owns and writes. You have READ access only.
- NEVER create, edit, move, or delete anything in this store (no new notes, no edits to
  `MEMORY.md`). If you learn something durable, surface it to the user instead of writing it.
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
# ANOTHER agent (typically Claude Code) owns and writes — one writer, N readers. The recall
# discipline is identical and host-agnostic; the ONLY per-host difference is which
# always-loaded rules file it lands in (and, for Cursor/Kiro, the frontmatter that file
# needs). Every reader creates no store, touches no .gitignore, installs no write tools, and
# uses the shared read-only snippet (no write protocol). It injects either as a marked block
# in a shared rules file (default) or — when `frontmatter` is set — as a dedicated
# always-loaded rule file. `tested` marks the wiring dogfooded on a real machine here; the
# rest are built from each host's DOCUMENTED rules-file format but NOT verified to load
# (Engramory's honesty rule — see adapters/reader/README.md).
READER_HOSTS = {
    "codex":    {"label": "Codex",       "rules_file": "AGENTS.md",      "tested": True},
    "claude":   {"label": "Claude Code", "rules_file": "CLAUDE.md",      "tested": False},
    "openclaw": {"label": "OpenClaw",    "rules_file": "AGENTS.md",      "tested": False},
    "hermes":   {"label": "Hermes",      "rules_file": "AGENTS.md",      "tested": False},
    "dsh":      {"label": "DeepSeek Harness", "rules_file": "AGENTS.md", "tested": True},
    "cline":    {"label": "Cline",       "rules_file": ".clinerules",    "tested": False},
    "windsurf": {"label": "Windsurf",    "rules_file": ".windsurfrules", "tested": False},
    "cursor":   {"label": "Cursor",      "rules_file": ".cursor/rules/engramory-recall.mdc",
                 "frontmatter": "---\ndescription: Engramory read-only memory recall\nalwaysApply: true\n---",
                 "tested": False},
    "kiro":     {"label": "Kiro",        "rules_file": ".kiro/steering/engramory-recall.md",
                 "frontmatter": "---\ninclusion: always\n---", "tested": False},
}


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


# codex-reader, claude-reader, cursor-reader, kiro-reader, … alongside the write hosts.
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
        install_skill,
        mode="explicit",
        install_hooks=False):
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
        mode=mode,
        hooks_installed=install_hooks,
        setup_display=setup_display,
    )
    body = snippet + "\n\n" + note
    fm = cfg.get("frontmatter")
    if fm:
        # A dedicated always-loaded rule file (e.g. Cursor `.mdc` / Kiro steering): the whole
        # file is ours, so no markers — just the host-required frontmatter + the recall body.
        return fm + "\n\n" + body + "\n"
    return cfg["begin"] + "\n" + body + "\n" + cfg["end"]


def _require_sources(
        source_root,
        install_skill,
        snippet_rel="rules-snippet.md",
        install_hooks=False):
    # Fail fast with a clear message (before any side effects) if the repo this tool
    # ships in is incomplete, instead of a raw FileNotFoundError mid-copy. `snippet_rel`
    # is the host's rules snippet (default rules-snippet.md; a read-only host uses its own).
    required = ["templates/MEMORY.md", "rules-snippet.md", "SKILL.md",
                "tools/engramory_check.py", "tools/engramory_doctor.py", snippet_rel]
    if install_skill:
        required += ["PORTING.md", "LICENSE"]
    if install_hooks:
        required += [
            "hooks/codex/engramory_codex_hook.py",
            "tools/engramory_sync.py",
        ]
    required = list(dict.fromkeys(required))  # dedup (snippet_rel may be rules-snippet.md)
    missing = [r for r in required if not (source_root / r).exists()]
    if missing:
        raise SystemExit("Engramory source files missing (reinstall the repo): "
                         + ", ".join(missing))


_CODEX_HOOK_EVENTS = ("SessionStart", "UserPromptSubmit", "PreCompact")
_CODEX_HOOK_STATUSES = {
    "SessionStart": "Engramory: load continuity context (managed v1)",
    "UserPromptSubmit": "Engramory: track sync state (managed v1)",
    "PreCompact": "Engramory: check continuity before compaction (managed v1)",
}
_CODEX_LEGACY_HOOK_STATUSES = {
    "SessionStart": "Loading Engramory continuity context",
    "UserPromptSubmit": "Tracking Engramory sync state",
    "PreCompact": "Checking Engramory before compaction",
}


def _load_codex_hooks(path):
    """Load an existing project hooks file without mutating it on malformed input."""
    if not path.exists():
        return {}
    if not path.is_file():
        raise SystemExit(f"cannot install Codex hooks: {path} is not a file")
    try:
        data = json.loads(_read_text(path))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SystemExit(
            f"cannot install Codex hooks: existing {path} is not valid JSON: {exc}")
    if not isinstance(data, dict):
        raise SystemExit(
            f"cannot install Codex hooks: existing {path} must contain a JSON object")
    hooks = data.get("hooks")
    if hooks is None:
        data["hooks"] = {}
    elif not isinstance(hooks, dict):
        raise SystemExit(
            f"cannot install Codex hooks: 'hooks' in {path} must be a JSON object")
    else:
        # Validate every event this installer will merge before any store/rules
        # side effect. The merge helper performs the same checks and returns a
        # copy; calling it here is deliberately read-only.
        for event in _CODEX_HOOK_EVENTS:
            _remove_managed_hook_handlers(hooks.get(event, []), path, event)
    return data


def _powershell_literal(value):
    """Return one PowerShell single-quoted literal."""
    return "'" + str(value).replace("'", "''") + "'"


def _hook_command(argv, windows=False):
    if not windows:
        return shlex.join([str(value) for value in argv])

    # Codex 0.144.1 executes commandWindows through `cmd.exe /C`, not directly
    # through CreateProcess. C-runtime quoting (subprocess.list2cmdline) leaves
    # cmd metacharacters such as `&` and `%NAME%` active. Keep every dynamic path
    # inside a UTF-16LE PowerShell EncodedCommand; its base64 alphabet is inert to
    # cmd, while PowerShell single-quoted literals safely carry the real argv.
    invocation = "& " + " ".join(_powershell_literal(value) for value in argv)
    script = (
        "$ErrorActionPreference = 'Stop'\n"
        "$env:PYTHONUTF8 = '1'\n"
        "$env:PYTHONIOENCODING = 'utf-8'\n"
        "$utf8 = [System.Text.UTF8Encoding]::new($false)\n"
        "[Console]::InputEncoding = $utf8\n"
        "[Console]::OutputEncoding = $utf8\n"
        "$OutputEncoding = $utf8\n"
        + invocation
        + "\nexit $LASTEXITCODE\n"
    )
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    return (
        "powershell.exe -NoLogo -NoProfile -NonInteractive "
        "-EncodedCommand " + encoded
    )


def _engramory_hook_handler(command, command_windows, status):
    handler = {
        "type": "command",
        "command": command,
        "timeout": 10,
        "statusMessage": status,
    }
    if command_windows:
        handler["commandWindows"] = command_windows
    return handler


def _remove_managed_hook_handlers(groups, path, event):
    if not isinstance(groups, list):
        raise SystemExit(
            f"cannot install Codex hooks: hooks.{event} in {path} must be a JSON array")
    kept_groups = []
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get("hooks", []), list):
            raise SystemExit(
                f"cannot install Codex hooks: every hooks.{event} entry in {path} "
                "must be an object with a 'hooks' array")
        kept_handlers = []
        for handler in group.get("hooks", []):
            if not isinstance(handler, dict):
                raise SystemExit(
                    f"cannot install Codex hooks: every hooks.{event} handler in "
                    f"{path} must be a JSON object")
            managed_statuses = (
                _CODEX_HOOK_STATUSES[event],
                _CODEX_LEGACY_HOOK_STATUSES[event],
            )
            is_managed = (
                handler.get("type") == "command"
                and handler.get("statusMessage") in managed_statuses
            )
            if not is_managed:
                kept_handlers.append(handler)
        if kept_handlers:
            updated = dict(group)
            updated["hooks"] = kept_handlers
            kept_groups.append(updated)
    return kept_groups


def _merge_codex_hooks(
        existing, path, hook_path, sync_path, memory_root, mode, hook_python=None):
    data = dict(existing)
    hooks = dict(data.get("hooks", {}))
    argv = [
        hook_python or sys.executable,
        hook_path,
        "--memory-root",
        memory_root,
        "--sync-tool",
        sync_path,
        "--mode",
        mode,
    ]
    command = _hook_command(argv)
    command_windows = _hook_command(argv, windows=True) if os.name == "nt" else None

    matchers = {
        "SessionStart": "startup|resume|clear|compact",
        "UserPromptSubmit": None,
        # Do not filter PreCompact here: the runtime must see future/unknown
        # trigger values so it can fail open visibly instead of silently
        # bypassing reconciliation bookkeeping.
        "PreCompact": None,
    }
    for event in _CODEX_HOOK_EVENTS:
        groups = _remove_managed_hook_handlers(hooks.get(event, []), path, event)
        group = {
            "hooks": [
                _engramory_hook_handler(
                    command, command_windows, _CODEX_HOOK_STATUSES[event])
            ]
        }
        if matchers[event]:
            group["matcher"] = matchers[event]
        groups.append(group)
        hooks[event] = groups

    data["hooks"] = hooks
    if "description" not in data:
        data["description"] = (
            "Project lifecycle hooks, including Engramory continuity checks.")
    return data


def _copy_managed_file(source, target, force, guard_root=None):
    if guard_root is not None:
        # Re-checked here, immediately before the write (see _write_text_atomic).
        _refuse_symlink_escape(target, guard_root, f"managed file {target.name}")
    if target.is_symlink():
        raise SystemExit(
            f"cannot install Codex hooks: managed target {target} is a symlink")
    if target.exists():
        if not target.is_file():
            raise SystemExit(
                f"cannot install Codex hooks: managed target {target} is not a file")
        if target.read_bytes() == source.read_bytes():
            return "already current"
        if not force:
            return "kept existing (use --force to replace)"
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_name = None
    try:
        fd, temp_name = tempfile.mkstemp(
            prefix=".engramory-install-", suffix=".tmp", dir=str(target.parent))
        os.close(fd)
        shutil.copy2(source, temp_name)
        # Replaces a target directory entry rather than following a symlink or
        # hardlink that may have appeared after preflight.
        os.replace(temp_name, target)
        temp_name = None
    except OSError as exc:
        raise SystemExit(
            f"cannot install managed Codex hook file {target}: {exc}")
    finally:
        if temp_name is not None:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
    return "installed"


def _codex_hooks_are_machine_local(data):
    """True when only Engramory owns this file, so gitignoring it is safe.

    `.codex/hooks.json` is a normal Codex project-configuration surface a team may
    legitimately share. The generated Engramory entries can never be shared —
    Codex 0.144.1 has no project-dir variable for hook commands, so the
    interpreter, hook script, sync tool, and memory root are all baked in as
    absolute machine-local paths. Ignoring the file is therefore right when it
    holds nothing else, and wrong the moment a teammate's handler lives there.
    """
    for groups in (data.get("hooks") or {}).values():
        for group in groups if isinstance(groups, list) else []:
            for handler in (group or {}).get("hooks", []) or []:
                status = (handler or {}).get("statusMessage")
                if status not in set(_CODEX_HOOK_STATUSES.values()) | set(
                        _CODEX_LEGACY_HOOK_STATUSES.values()):
                    return False
    return True


_CODEX_HOOKS_IGNORE_ENTRY = "/.codex/hooks.json"
_CODEX_HOOKS_IGNORE_COMMENT = (
    "# Engramory Codex hooks (absolute machine-local paths, not portable)")


def _drop_codex_hooks_gitignore_entry(project_root):
    """Remove an entry THIS installer added once the file stops being ours.

    Ownership can flip after the first install: a teammate adds their own handler
    to `.codex/hooks.json`, making it a shared config that must stay in version
    control. Merely declining to add the rule is not enough — the rule added by
    an earlier Engramory-only install is still in `.gitignore`, so the now-shared
    file keeps being ignored.
    """
    gitignore = project_root / ".gitignore"
    if not gitignore.exists():
        return None
    lines = _read_text(gitignore).splitlines()
    if _CODEX_HOOKS_IGNORE_ENTRY not in lines:
        return None
    # Only remove a rule THIS installer wrote. Provenance is the comment we emit
    # directly above it: without that marker the line may be the user's own
    # deliberate choice to ignore the file, and silently un-ignoring it would be
    # its own kind of damage.
    kept = []
    removed = False
    for line in lines:
        if (line == _CODEX_HOOKS_IGNORE_ENTRY
                and kept and kept[-1] == _CODEX_HOOKS_IGNORE_COMMENT):
            kept.pop()  # drop our comment header too
            while kept and kept[-1].strip() == "":
                kept.pop()
            removed = True
            continue
        kept.append(line)
    if not removed:
        return ("left the existing {0} ignore rule alone: it carries no Engramory "
                "marker, so it looks like your own".format(_CODEX_HOOKS_IGNORE_ENTRY))
    _write_text(gitignore, ("\n".join(kept).rstrip() + "\n") if kept else "",
                guard_root=project_root)
    return "removed the stale {0} ignore rule".format(_CODEX_HOOKS_IGNORE_ENTRY)


def _ensure_codex_hooks_gitignored(project_root, hooks_path, merged):
    entry = _CODEX_HOOKS_IGNORE_ENTRY
    if not _codex_hooks_are_machine_local(merged):
        note = (
            "NOT gitignored: this file also holds non-Engramory handlers, so it "
            "looks shared; the Engramory entries in it are machine-local and will "
            "not work on another machine")
        dropped = _drop_codex_hooks_gitignore_entry(project_root)
        return "{0} ({1})".format(note, dropped) if dropped else note
    gitignore = project_root / ".gitignore"
    old = _read_text(gitignore) if gitignore.exists() else ""
    if entry in old.splitlines():
        return "already gitignored"
    prefix = old.rstrip() + "\n\n" if old.strip() else ""
    _write_text(
        gitignore,
        prefix + _CODEX_HOOKS_IGNORE_COMMENT + "\n" + entry + "\n",
        guard_root=project_root,
    )
    return "gitignored {0}".format(entry)


def _install_codex_hooks(
        source_root,
        project_root,
        memory_root,
        mode,
        force,
        existing,
        hook_python=None):
    managed_root = project_root / ".codex" / "engramory"
    hook_path = managed_root / "engramory_codex_hook.py"
    sync_path = managed_root / "engramory_sync.py"
    hook_status = _copy_managed_file(
        source_root / "hooks" / "codex" / "engramory_codex_hook.py",
        hook_path,
        force,
        guard_root=project_root,
    )
    sync_status = _copy_managed_file(
        source_root / "tools" / "engramory_sync.py",
        sync_path,
        force,
        guard_root=project_root,
    )

    hooks_path = project_root / ".codex" / "hooks.json"
    merged = _merge_codex_hooks(
        existing,
        hooks_path,
        hook_path.resolve(),
        sync_path.resolve(),
        memory_root,
        mode,
        hook_python=hook_python,
    )
    _write_text_atomic(
        hooks_path,
        json.dumps(merged, ensure_ascii=False, indent=2) + "\n",
        guard_root=project_root,
    )
    ignore_status = _ensure_codex_hooks_gitignored(project_root, hooks_path, merged)
    interpreter = hook_python or sys.executable
    return (
        f"configured .codex/hooks.json; hook script {hook_status}; "
        f"sync helper {sync_status}; {ignore_status}; "
        f"interpreter baked in: {interpreter}; "
        f"NOT active until you trust it in Codex's /hooks")


def init_host(args, host):
    cfg = HOST_CONFIG[host]
    source_root = _repo_root()
    if args.install_hooks and host != "codex":
        raise SystemExit(
            "--install-hooks is supported only for the Codex write host")
    if args.mode != "explicit" and host != "codex":
        raise SystemExit(
            "--mode assisted is supported only for the Codex write host")
    _require_sources(
        source_root,
        args.install_skill,
        cfg.get("snippet", "rules-snippet.md"),
        install_hooks=args.install_hooks,
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
    if args.install_hooks:
        hook_root = project_root / ".codex" / "engramory"
        if (_same_or_inside(memory_root, hook_root)
                or _same_or_inside(hook_root, memory_root)):
            raise SystemExit(
                f"--memory-root ({memory_root}) overlaps the managed Codex hook dir "
                f"({hook_root}); keep executable hook code separate from memory data.")

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
    existing_hooks = None
    if args.install_hooks:
        hook_root = project_root / ".codex" / "engramory"
        hooks_path = project_root / ".codex" / "hooks.json"
        _refuse_symlink_escape(hook_root, project_root, "the Codex hook install dir")
        _refuse_symlink_escape(hooks_path, project_root, ".codex/hooks.json")
        if hooks_path.is_symlink():
            raise SystemExit(
                f"cannot install Codex hooks: {hooks_path} is a symlink")
        for managed_name in ("engramory_codex_hook.py", "engramory_sync.py"):
            managed_target = hook_root / managed_name
            _refuse_symlink_escape(
                managed_target, project_root, f"managed Codex hook file {managed_name}")
            if managed_target.is_symlink():
                raise SystemExit(
                    f"cannot install Codex hooks: managed target "
                    f"{managed_target} is a symlink")
            if managed_target.exists() and not managed_target.is_file():
                raise SystemExit(
                    f"cannot install Codex hooks: managed target "
                    f"{managed_target} is not a file")
        # Parse and validate the file before creating the store, gitignore, skill, or
        # AGENTS block. A malformed user hooks file must never leave a partial init.
        existing_hooks = _load_codex_hooks(hooks_path)

    project_root.mkdir(parents=True, exist_ok=True)

    results = []
    try:
        _run_install_steps(args, cfg, source_root, project_root, memory_root,
                           creates_store, rules_file, target, existing_hooks, results)
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
                       creates_store, rules_file, target, existing_hooks, results):
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

    hook_result = "not requested"
    if args.install_hooks:
        hook_result = _install_codex_hooks(
            source_root,
            project_root,
            memory_root,
            args.mode,
            args.force,
            existing_hooks,
            hook_python=args.hook_python,
        )
    results.append(("hooks", hook_result))

    block = _render_block(
        cfg,
        source_root,
        project_root,
        memory_root,
        args.install_skill,
        mode=args.mode,
        install_hooks=args.install_hooks,
    )
    if cfg.get("frontmatter"):
        # A dedicated rule file we own (Cursor/Kiro): write it whole (idempotent overwrite).
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
                             "cursor-reader, kiro-reader, cline-reader, etc.)")
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
    parser.add_argument(
        "--install-hooks",
        action="store_true",
        help="install Codex SessionStart/UserPromptSubmit/PreCompact project hooks "
             "under .codex (Codex write host only)",
    )
    parser.add_argument(
        "--hook-python",
        default=None,
        help="interpreter baked into the generated hook command (default: the "
             "Python running this installer). Pass an explicit path when that "
             "default is a throwaway/project-local virtualenv — if it is deleted "
             "or renamed later, every hook silently stops working.",
    )
    parser.add_argument(
        "--mode",
        choices=("explicit", "assisted"),
        default="explicit",
        help="Codex capture policy: explicit syncs on request/boundaries; assisted also "
             "asks Codex to sync at meaningful milestones (default: explicit)",
    )
    parser.add_argument("--force", action="store_true",
                        help="replace the installed skill and managed Codex hook scripts")
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
    return init_host(args, args.host)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
