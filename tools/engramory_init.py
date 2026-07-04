#!/usr/bin/env python3
"""
engramory_init - bootstrap Engramory for an agent host.

Usage:

    python tools/engramory_init.py codex        --project-root <repo> --install-skill
    python tools/engramory_init.py openclaw                           --install-skill
    python tools/engramory_init.py codex-reader --project-root <repo> --memory-root <existing store>

For a WRITE host (codex, openclaw) the command creates a local memory store, adds a marked
Engramory block to the host's always-loaded AGENTS.md, optionally installs the Engramory skill
under .agents/skills/engramory (both hosts auto-discover skills there), and adds the memory
store to .gitignore when the store lives inside the project/workspace.

The READ-ONLY host `codex-reader` instead wires Codex to *recall* from a store another agent
(typically Claude Code) owns and writes: it creates no store, touches no .gitignore, and uses a
recall-only snippet (no write protocol). `--memory-root` MUST point at an existing store (e.g.
Claude Code's memory dir). Its marker is distinct, so it coexists with a write `codex` block in
the same AGENTS.md. See adapters/codex-reader/README.md.

Defaults: codex/codex-reader use --project-root '.', openclaw uses ~/.openclaw/workspace.
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


def _codex_reader_note(index_display, check_display, protocol_display):
    # Read-only reader: it never writes, so there is no engramory_check step and
    # check_display is intentionally unused (signature kept uniform for _render_block).
    return f"""Codex read-only wiring:

- Recall from `{index_display}` — this is another agent's memory index (typically Claude
  Code's native auto-memory). You have READ access only; Claude Code is the sole writer.
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
    # Read-only reader: wire Codex to RECALL from a store another agent (Claude Code) owns
    # and writes. It creates no store, touches no .gitignore, and uses a recall-only snippet
    # (no write protocol). Distinct markers so it coexists with the write `codex` block in the
    # same AGENTS.md. `--memory-root` MUST point at an existing store (e.g. Claude Code's
    # memory dir). See adapters/codex-reader/README.md.
    "codex-reader": {
        "label": "Codex (read-only)",
        "begin": "<!-- BEGIN ENGRAMORY CODEX-READER -->",
        "end": "<!-- END ENGRAMORY CODEX-READER -->",
        "default_root": ".",
        "creates_store": False,
        "snippet": "adapters/codex-reader/recall-snippet.md",
        "note": _codex_reader_note,
    },
}


def _render_block(cfg, source_root, project_root, memory_root, install_skill):
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

    note = cfg["note"](index_display, check_display, protocol_display)
    return cfg["begin"] + "\n" + snippet + "\n\n" + note + "\n" + cfg["end"]


def _require_sources(source_root, install_skill, snippet_rel="rules-snippet.md"):
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


def init_host(args, host):
    cfg = HOST_CONFIG[host]
    source_root = _repo_root()
    _require_sources(source_root, args.install_skill, cfg.get("snippet", "rules-snippet.md"))
    root_arg = args.project_root if args.project_root is not None else cfg["default_root"]
    project_root = Path(root_arg).expanduser().resolve()
    memory_root = Path(args.memory_root).expanduser()
    if not memory_root.is_absolute():
        memory_root = project_root / memory_root
    memory_root = memory_root.resolve()

    if memory_root == project_root:
        raise SystemExit("memory root must be a directory inside or outside the project, not the project root itself")

    # A read-only host (creates_store=False) never creates or touches the store — it only
    # wires the host to RECALL from a store another agent owns and writes. Enforce that up
    # front (before any side effect / directory creation) with clear messages:
    creates_store = cfg.get("creates_store", True)
    if not creates_store:
        # It installs no skill and no write tools — only a recall block. Passing
        # --install-skill would copy engramory_check/doctor etc., contradicting that.
        if args.install_skill:
            raise SystemExit(
                f"read-only host '{host}': --install-skill is not supported — a reader installs "
                f"no skill and no write tools, it only adds a recall block to AGENTS.md. "
                f"Re-run without --install-skill.")
        # AGENTS.md is written under --project-root; if that is inside the store, the write
        # would modify the very store the reader must not touch. Refuse it.
        if _same_or_inside(project_root, memory_root):
            raise SystemExit(
                f"read-only host '{host}': --project-root ({project_root}) is inside the memory "
                f"store ({memory_root}) — writing AGENTS.md there would modify the read-only "
                f"store. Point --project-root outside the store (e.g. ~/.codex).")
        # The store must already exist; this host never creates one.
        if not (memory_root / "MEMORY.md").is_file():
            raise SystemExit(
                f"read-only host '{host}': no MEMORY.md at {memory_root} — pass --memory-root "
                f"pointing at an EXISTING memory store (e.g. Claude Code's memory directory, "
                f"~/.claude/projects/<project>/memory). This host never creates a store.")

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
                        help="agent host to initialize (codex, openclaw, codex-reader)")
    parser.add_argument("--project-root", default=None,
                        help="project/workspace root (default: '.' for codex/codex-reader, ~/.openclaw/workspace for openclaw)")
    parser.add_argument(
        "--memory-root",
        default=".engramory-memory",
        help="memory store path; relative paths are resolved under --project-root. For the "
             "read-only 'codex-reader' host this MUST be an existing store (it is not created), "
             "e.g. Claude Code's memory dir ~/.claude/projects/<project>/memory",
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
