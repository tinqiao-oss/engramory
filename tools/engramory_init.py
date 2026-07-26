#!/usr/bin/env python3
"""
engramory_init - bootstrap Engramory for an agent host.

Usage:

    python tools/engramory_init.py codex          --project-root <repo> --install-skill
    python tools/engramory_init.py codex          --project-root <repo> --install-hooks --mode explicit
    python tools/engramory_init.py openclaw                              --install-skill
    python tools/engramory_init.py <host>-reader   --project-root <cfg>  --memory-root <existing store>

For a WRITE host (codex, openclaw) the command creates a local memory store, adds a marked
Engramory block to the host's always-loaded AGENTS.md, optionally installs the Engramory skill
under .agents/skills/engramory (both hosts auto-discover skills there), and adds the memory
store to .gitignore when the store lives inside the project/workspace.

For the Codex writer, `--install-hooks` also installs project-scoped
SessionStart/UserPromptSubmit/PreCompact assistance under `.codex/`. The hooks
track only synchronization bookkeeping; the agent still performs the semantic
Engramory sync. `--mode explicit` is the default; `assisted` adds proactive
milestone guidance.

A READ-ONLY reader host `<host>-reader` (codex-reader, claude-reader, cursor-reader, kiro-reader,
cline-reader, windsurf-reader, openclaw-reader, hermes-reader) instead wires that host to *recall*
from a store ANOTHER agent (typically Claude Code) owns and writes — one writer, N readers. It
creates no store, touches no .gitignore, installs no write tools, and uses a recall-only snippet
(no write protocol). `--memory-root` MUST point at an existing store (e.g. Claude Code's memory
dir). It injects into the host's own always-loaded rules file (AGENTS.md / CLAUDE.md / .clinerules
/ Cursor .mdc / Kiro steering …); a marked block coexists with other Engramory blocks. Only the
codex-reader wiring is dogfooded here — the others are built from each host's documented
rules-file format but printed with an "unverified" note. See adapters/reader/README.md.

Defaults: --project-root '.', except openclaw (~/.openclaw/workspace).
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


def _write_text(path, text):
    """Every install write is atomic — several targets are USER-OWNED files.

    `AGENTS.md`, a dedicated rules file, and `.gitignore` routinely already exist
    and hold content this installer did not write. A plain `open(..., "w")`
    truncates before writing, so a disk-full, an I/O error, or a killed process
    in between leaves the user's rules file empty or half-written. Staging into a
    temp file and `os.replace`-ing means the previous content survives any
    failure.
    """
    _write_text_atomic(path, text)


def _write_text_atomic(path, text):
    """Atomically replace a managed file without following a final symlink/hardlink."""
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
    i = existing.find(begin)
    j = existing.find(end)
    if 0 <= i < j:
        before, after = existing[:i], existing[j + len(end):]
        return before.rstrip() + "\n\n" + block + "\n\n" + after.lstrip()
    cleaned = "\n".join(ln for ln in existing.splitlines()
                        if begin not in ln and end not in ln)
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
    )
    return f"added {rel}"


def _ensure_memory_store(source_root, memory_root):
    memory_root.mkdir(parents=True, exist_ok=True)
    index = memory_root / "MEMORY.md"
    if index.exists():
        # `exists()` follows symlinks, so a planted `MEMORY.md -> /etc/passwd`
        # used to be reported as "kept existing" and every later recall would
        # read that file into the model's context. The store is
        # attacker-influenceable input (SECURITY.md), so refuse an index that is
        # a symlink or that resolves outside the store instead of adopting it.
        if index.is_symlink():
            raise SystemExit(
                f"refusing to adopt {index}: it is a symlink. The memory index "
                f"must be a real file inside the store.")
        if not index.is_file():
            raise SystemExit(
                f"refusing to adopt {index}: it is not a regular file.")
        if not _same_or_inside(index, memory_root):
            raise SystemExit(
                f"refusing to adopt {index}: it resolves outside the memory root "
                f"({memory_root}).")
        return "kept existing MEMORY.md"
    template = source_root / "templates" / "MEMORY.md"
    shutil.copy2(template, index)
    return "created MEMORY.md from template"


def _copy_skill(source_root, project_root, force):
    skill_root = project_root / ".agents" / "skills" / "engramory"
    if skill_root.exists():
        if not force:
            return "kept existing .agents/skills/engramory (use --force to replace)"
        shutil.rmtree(skill_root)

    skill_root.mkdir(parents=True, exist_ok=True)
    for name in ("SKILL.md", "rules-snippet.md", "PORTING.md", "LICENSE"):
        shutil.copy2(source_root / name, skill_root / name)
    for dirname in ("templates", "tools"):
        shutil.copytree(
            source_root / dirname,
            skill_root / dirname,
            ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"),
        )
    return "installed .agents/skills/engramory"


def _codex_note(
        index_display,
        check_display,
        protocol_display,
        mode="explicit",
        hooks_installed=False,
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
- Full protocol reference: `{protocol_display}`."""


def _openclaw_note(index_display, check_display, protocol_display, **_kwargs):
    return f"""OpenClaw-specific wiring:

- Keep this Engramory store separate from OpenClaw's own memory; OpenClaw auto-writes
  daily logs under `memory/YYYY-MM-DD.md` (plus an optional curated `MEMORY.md`), while
  Engramory is a user-curated plain folder you control.
- After editing `{index_display}`, run `python {check_display} {index_display}` and
  compact immediately if it reports `OVER`. OpenClaw's deterministic deny path is a
  `before_tool_call` *plugin* hook (TypeScript), NOT Engramory's Python shell hook — so
  the cap here is rules + this check unless you write that plugin (see
  adapters/openclaw/README.md).
- Full protocol reference: `{protocol_display}`."""


def _reader_note(index_display, check_display, protocol_display, **_kwargs):
    # Read-only reader (host-agnostic): it never writes, so there is no engramory_check
    # step and check_display is intentionally unused (signature kept uniform for _render_block).
    return f"""Read-only wiring:

- Recall from `{index_display}` — the memory index of a store another agent (typically
  Claude Code's native auto-memory) owns and writes. You have READ access only.
- NEVER create, edit, move, or delete anything in this store (no new notes, no edits to
  `MEMORY.md`). If you learn something durable, surface it to the user instead of writing it.
- Full protocol reference (recall + the write side you do NOT use): `{protocol_display}`."""


# Per-host wiring. Both Codex and OpenClaw use an always-loaded AGENTS.md and auto-discover
# Agent Skills from .agents/skills, so the only differences are the block markers, the
# default root, and the host-specific note appended under the shared rules snippet.
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


def _render_block(
        cfg,
        source_root,
        project_root,
        memory_root,
        install_skill,
        mode="explicit",
        install_hooks=False):
    snippet = _read_text(source_root / cfg.get("snippet", "rules-snippet.md")).strip()
    memory_display = _display_path(memory_root, project_root)
    index_display = (Path(memory_display) / "MEMORY.md").as_posix()
    snippet = snippet.replace("<MEMORY_ROOT>", memory_display)

    if install_skill:
        protocol_display = ".agents/skills/engramory/SKILL.md"
        check_display = ".agents/skills/engramory/tools/engramory_check.py"
    else:
        protocol_display = _display_path(source_root / "SKILL.md", project_root)
        check_display = _display_path(source_root / "tools" / "engramory_check.py", project_root)

    note = cfg["note"](
        index_display,
        check_display,
        protocol_display,
        mode=mode,
        hooks_installed=install_hooks,
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


def _copy_managed_file(source, target, force):
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


def _ensure_codex_hooks_gitignored(project_root, hooks_path, merged):
    entry = "/.codex/hooks.json"
    if not _codex_hooks_are_machine_local(merged):
        return (
            "NOT gitignored: this file also holds non-Engramory handlers, so it "
            "looks shared; the Engramory entries in it are machine-local and will "
            "not work on another machine")
    gitignore = project_root / ".gitignore"
    old = _read_text(gitignore) if gitignore.exists() else ""
    if entry in old.splitlines():
        return "already gitignored"
    prefix = old.rstrip() + "\n\n" if old.strip() else ""
    _write_text(
        gitignore,
        prefix
        + "# Engramory Codex hooks (absolute machine-local paths, not portable)\n"
        + entry
        + "\n",
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
    )
    sync_status = _copy_managed_file(
        source_root / "tools" / "engramory_sync.py",
        sync_path,
        force,
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
    root_arg = args.project_root if args.project_root is not None else cfg["default_root"]
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
        skill_root = project_root / ".agents" / "skills" / "engramory"
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

    # Preflight EVERY path this run will write — BEFORE any side effect (mkdir, store,
    # gitignore, skill, rules file) — so a symlink-escape refusal can never leave a
    # partial init behind. The gitignore/skill checks mirror the conditions under which
    # those writes actually happen, so an escaped-but-unused path is not a false refusal.
    _refuse_symlink_escape(target, project_root, rules_file)
    if creates_store and _same_or_inside(memory_root, project_root):
        _refuse_symlink_escape(project_root / ".gitignore", project_root, ".gitignore")
    if args.install_skill:
        _refuse_symlink_escape(project_root / ".agents" / "skills" / "engramory",
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
    if creates_store:
        results.append(("memory", _ensure_memory_store(source_root, memory_root)))
        results.append(("gitignore", _ensure_gitignore(project_root, memory_root)))
    else:
        results.append(("memory", f"read-only — using existing store at {memory_root} (not created/modified)"))
        results.append(("gitignore", "skipped (read-only host does not manage the store)"))

    skill_result = "not requested"
    if args.install_skill:
        skill_result = _copy_skill(source_root, project_root, args.force)
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
        _write_text(target, block)
        results.append((rules_file, f"wrote Engramory {cfg['label']} rule file"))
    else:
        old = _read_text(target) if target.exists() else ""
        _write_text(target, _replace_block(old, block, cfg["begin"], cfg["end"],
                                           heading=Path(rules_file).name))
        results.append((rules_file, f"created/updated Engramory {cfg['label']} block"))

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


def build_parser():
    parser = argparse.ArgumentParser(description="Bootstrap Engramory for an agent host.")
    parser.add_argument("host", nargs="?", default="codex", choices=tuple(HOST_CONFIG),
                        help="host to initialize: write hosts (codex, openclaw) or a read-only "
                             "reader host '<host>-reader' (codex-reader, claude-reader, "
                             "cursor-reader, kiro-reader, cline-reader, etc.)")
    parser.add_argument("--project-root", default=None,
                        help="project/workspace root (default: '.'; openclaw defaults to ~/.openclaw/workspace)")
    parser.add_argument(
        "--memory-root",
        default=".engramory-memory",
        help="memory store path; relative paths are resolved under --project-root. For a "
             "read-only '<host>-reader' this MUST be an EXISTING store (it is not created), "
             "e.g. Claude Code's memory dir ~/.claude/projects/<project>/memory",
    )
    parser.add_argument("--install-skill", action="store_true", help="copy Engramory into .agents/skills/engramory")
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
