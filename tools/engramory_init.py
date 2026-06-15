#!/usr/bin/env python3
"""
engramory_init - bootstrap Engramory for an agent host.

Usage:

    python tools/engramory_init.py codex    --project-root <repo> --install-skill
    python tools/engramory_init.py openclaw                       --install-skill

For each host the command creates a local memory store, adds a marked Engramory block
to the host's always-loaded AGENTS.md, optionally installs the Engramory skill under
.agents/skills/engramory (both hosts auto-discover skills there), and adds the memory
store to .gitignore when the store lives inside the project/workspace.

Defaults: codex uses --project-root '.', openclaw uses ~/.openclaw/workspace.
"""
import argparse
import os
import shutil
import sys
from pathlib import Path


def _repo_root():
    return Path(__file__).resolve().parents[1]


def _read_text(path):
    return path.read_text(encoding="utf-8")


def _write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    # open(newline="\n") rather than Path.write_text(newline=...) — the latter's newline
    # kwarg only exists on Python 3.10+, and the project floor is 3.9.
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def _same_or_inside(child, parent):
    child = child.resolve()
    parent = parent.resolve()
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _display_path(path, base):
    path = path.resolve()
    base = base.resolve()
    try:
        rel = path.relative_to(base)
        return rel.as_posix() or "."
    except ValueError:
        return path.as_posix()


def _replace_block(existing, block, begin, end):
    # Replace only a well-formed, IN-ORDER BEGIN..END pair. Anything else — no markers, a
    # lone/duplicated marker, or END before BEGIN from a botched hand-edit — is treated as
    # "no managed block": drop any stray marker LINES and append a fresh block. This never
    # crashes on a malformed file and never silently deletes the surrounding user content.
    i = existing.find(begin)
    j = existing.find(end)
    if 0 <= i < j:
        before, after = existing[:i], existing[j + len(end):]
        return before.rstrip() + "\n\n" + block + "\n\n" + after.lstrip()
    cleaned = "\n".join(ln for ln in existing.splitlines()
                        if begin not in ln and end not in ln)
    if cleaned.strip():
        return cleaned.rstrip() + "\n\n" + block + "\n"
    return "# AGENTS.md\n\n" + block + "\n"


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


def _codex_note(index_display, check_display, protocol_display):
    return f"""Codex-specific wiring:

- Keep this Engramory store separate from Codex native Memories; Codex native
  Memories are generated state, while Engramory is a user-auditable plain folder.
- If you edit `{index_display}` and no pre-write hook is installed, run
  `python {check_display} {index_display}` after the write; compact immediately
  if it reports `OVER`.
- Full protocol reference: `{protocol_display}`."""


def _openclaw_note(index_display, check_display, protocol_display):
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


def _render_block(cfg, source_root, project_root, memory_root, install_skill):
    snippet = _read_text(source_root / "rules-snippet.md").strip()
    memory_display = _display_path(memory_root, project_root)
    index_display = (Path(memory_display) / "MEMORY.md").as_posix()
    snippet = snippet.replace("<MEMORY_ROOT>", memory_display)

    if install_skill:
        protocol_display = ".agents/skills/engramory/SKILL.md"
        check_display = ".agents/skills/engramory/tools/engramory_check.py"
    else:
        protocol_display = _display_path(source_root / "SKILL.md", project_root)
        check_display = _display_path(source_root / "tools" / "engramory_check.py", project_root)

    note = cfg["note"](index_display, check_display, protocol_display)
    return cfg["begin"] + "\n" + snippet + "\n\n" + note + "\n" + cfg["end"]


def _require_sources(source_root, install_skill):
    # Fail fast with a clear message (before any side effects) if the repo this tool
    # ships in is incomplete, instead of a raw FileNotFoundError mid-copy.
    required = ["templates/MEMORY.md", "rules-snippet.md", "SKILL.md",
                "tools/engramory_check.py", "tools/engramory_doctor.py"]
    if install_skill:
        required += ["PORTING.md", "LICENSE"]
    missing = [r for r in required if not (source_root / r).exists()]
    if missing:
        raise SystemExit("Engramory source files missing (reinstall the repo): "
                         + ", ".join(missing))


def init_host(args, host):
    cfg = HOST_CONFIG[host]
    source_root = _repo_root()
    _require_sources(source_root, args.install_skill)
    root_arg = args.project_root if args.project_root is not None else cfg["default_root"]
    project_root = Path(root_arg).expanduser().resolve()
    memory_root = Path(args.memory_root).expanduser()
    if not memory_root.is_absolute():
        memory_root = project_root / memory_root
    memory_root = memory_root.resolve()

    if memory_root == project_root:
        raise SystemExit("memory root must be a directory inside or outside the project, not the project root itself")

    project_root.mkdir(parents=True, exist_ok=True)

    results = []
    results.append(("memory", _ensure_memory_store(source_root, memory_root)))
    results.append(("gitignore", _ensure_gitignore(project_root, memory_root)))

    skill_result = "not requested"
    if args.install_skill:
        skill_result = _copy_skill(source_root, project_root, args.force)
    results.append(("skill", skill_result))

    block = _render_block(cfg, source_root, project_root, memory_root, args.install_skill)
    agents = project_root / "AGENTS.md"
    old = _read_text(agents) if agents.exists() else ""
    _write_text(agents, _replace_block(old, block, cfg["begin"], cfg["end"]))
    results.append(("AGENTS.md", f"created/updated Engramory {cfg['label']} block"))

    print(f"Engramory {cfg['label']} init complete")
    print(f"project root: {_display_path(project_root, Path.cwd())}")
    print(f"memory root: {_display_path(memory_root, project_root)}")
    for label, message in results:
        print(f"- {label}: {message}")
    return 0


def build_parser():
    parser = argparse.ArgumentParser(description="Bootstrap Engramory for an agent host.")
    parser.add_argument("host", nargs="?", default="codex", choices=tuple(HOST_CONFIG),
                        help="agent host to initialize (codex, openclaw)")
    parser.add_argument("--project-root", default=None,
                        help="project/workspace root (default: '.' for codex, ~/.openclaw/workspace for openclaw)")
    parser.add_argument(
        "--memory-root",
        default=".engramory-memory",
        help="memory store path; relative paths are resolved under --project-root",
    )
    parser.add_argument("--install-skill", action="store_true", help="copy Engramory into .agents/skills/engramory")
    parser.add_argument("--force", action="store_true",
                        help="remove and recreate the entire .agents/skills/engramory directory")
    return parser


def main(argv):
    args = build_parser().parse_args(argv[1:])
    return init_host(args, args.host)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
