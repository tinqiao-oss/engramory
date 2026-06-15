#!/usr/bin/env python3
"""
engramory_init - bootstrap Engramory for an agent host.

Codex usage:

    python tools/engramory_init.py codex --project-root <repo> --install-skill

The command creates a local memory store, adds an Engramory block to AGENTS.md,
optionally installs the Engramory skill under .agents/skills/engramory, and adds
the memory store to .gitignore when the store lives inside the project.
"""
import argparse
import os
import shutil
import sys
from pathlib import Path


MARKER_BEGIN = "<!-- BEGIN ENGRAMORY CODEX -->"
MARKER_END = "<!-- END ENGRAMORY CODEX -->"


def _repo_root():
    return Path(__file__).resolve().parents[1]


def _read_text(path):
    return path.read_text(encoding="utf-8")


def _write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


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


def _replace_block(existing, block):
    # Replace only a well-formed, IN-ORDER BEGIN..END pair. Anything else — no markers, a
    # lone/duplicated marker, or END before BEGIN from a botched hand-edit — is treated as
    # "no managed block": drop any stray marker LINES and append a fresh block. This never
    # crashes on a malformed file and never silently deletes the surrounding user content.
    i = existing.find(MARKER_BEGIN)
    j = existing.find(MARKER_END)
    if 0 <= i < j:
        before, after = existing[:i], existing[j + len(MARKER_END):]
        return before.rstrip() + "\n\n" + block + "\n\n" + after.lstrip()
    cleaned = "\n".join(ln for ln in existing.splitlines()
                        if MARKER_BEGIN not in ln and MARKER_END not in ln)
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


def _render_codex_block(source_root, project_root, memory_root, install_skill):
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

    codex_note = f"""Codex-specific wiring:

- Keep this Engramory store separate from Codex native Memories; Codex native
  Memories are generated state, while Engramory is a user-auditable plain folder.
- If you edit `{index_display}` and no pre-write hook is installed, run
  `python {check_display} {index_display}` after the write; compact immediately
  if it reports `OVER`.
- Full protocol reference: `{protocol_display}`."""

    return MARKER_BEGIN + "\n" + snippet + "\n\n" + codex_note + "\n" + MARKER_END


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


def init_codex(args):
    source_root = _repo_root()
    _require_sources(source_root, args.install_skill)
    project_root = Path(args.project_root).expanduser().resolve()
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

    block = _render_codex_block(source_root, project_root, memory_root, args.install_skill)
    agents = project_root / "AGENTS.md"
    old = _read_text(agents) if agents.exists() else ""
    _write_text(agents, _replace_block(old, block))
    results.append(("AGENTS.md", "created/updated Engramory Codex block"))

    print("Engramory Codex init complete")
    print(f"project root: {_display_path(project_root, Path.cwd())}")
    print(f"memory root: {_display_path(memory_root, project_root)}")
    for label, message in results:
        print(f"- {label}: {message}")
    return 0


def build_parser():
    parser = argparse.ArgumentParser(description="Bootstrap Engramory for an agent host.")
    parser.add_argument("host", nargs="?", default="codex", choices=("codex",), help="agent host to initialize")
    parser.add_argument("--project-root", default=".", help="project/repository root to configure")
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
    # host is choices-restricted to "codex"; argparse rejects anything else.
    return init_codex(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
