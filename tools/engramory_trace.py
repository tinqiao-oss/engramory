#!/usr/bin/env python3
"""
engramory_trace — search the raw agent transcripts behind your memories.

Engramory stores *conclusions*: "the retry wrapper must stay — it is a correctness
fix, not defensive noise". This searches the layer underneath — what was actually
said, in which session, on which day. The two answer different questions: a memory
says what to do, a transcript says what it was decided from.

Use it when a memory is terse and you need the reasoning, when you suspect a memory
is stale and want the original evidence, or when something was discussed but never
written down.

    python tools/engramory_trace.py "streaming parser"     # search this project
    python tools/engramory_trace.py rate-limit --role user # only what the user said
    python tools/engramory_trace.py --show 5735e29e        # replay one session
    python tools/engramory_trace.py --list-projects

Host support: Claude Code only. It reads that host's JSONL transcripts under
`~/.claude/projects/<encoded-cwd>/`; point `--root` elsewhere if yours differ. Other
hosts keep transcripts in their own formats and are not parsed here. Everything is
local and read-only — nothing is uploaded, indexed, or embedded.

Exit code: 0 = hits found, 1 = no hits, 64 = usage error, 66 = transcript root
unreadable. (0/1 mirrors grep, so a caller can branch on "found anything".)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

DEFAULT_ROOT = Path.home() / ".claude" / "projects"

# Blocks above this are truncated before matching. The big ones are tool results
# (test runs, HTTP dumps) and base64 screenshots; a single session can reach
# hundreds of MB, and expanding those would flood the terminal.
HUGE_BLOCK = 60_000

# Default to what was actually *said*. In a tool-heavy session the large majority of
# `user` records are tool results rather than user turns, and a host that injects
# standing context (an auto-loaded MEMORY.md, a rules file) re-injects it every turn
# — so searching everything makes any term drawn FROM a memory match dozens of copies
# of that memory's own history, burying the discussion that produced it.
SPEECH_KINDS = {"text", "thinking"}

# Injected context rides inside the same record as the real user turn, so it has to
# be stripped out rather than the whole record dropped.
SYSREM_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL)

EXIT_NO_HITS = 1
EXIT_USAGE = 64
EXIT_UNREADABLE = 66

ROLE_COLORS = {"user": "\033[36m", "assistant": "\033[32m"}
DIM = "\033[2m"
HIT = "\033[43;30m"
RESET = "\033[0m"


def _strip_injected(text: str) -> str:
    return SYSREM_RE.sub("", text)


def _supports_color() -> bool:
    return sys.stdout.isatty() and os.environ.get("TERM") != "dumb"


def _encode_project_dir(path: Path) -> str:
    """Map a working directory to the host's transcript directory name.

    `/home/me/proj` -> `-home-me-proj`; `C:\\src\\proj` -> `C--src-proj`.
    """
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def _resolve_dirs(root: Path, all_projects: bool, project: str | None) -> list[Path]:
    if not root.is_dir():
        print(f"transcript root not found: {root}", file=sys.stderr)
        raise SystemExit(EXIT_UNREADABLE)
    if project:
        exact = root / project
        if exact.is_dir():
            return [exact]
        matches = [p for p in root.iterdir() if p.is_dir() and project.lower() in p.name.lower()]
        if len(matches) == 1:
            return matches
        if not matches:
            print(f"no project directory matching {project!r} (try --list-projects)", file=sys.stderr)
            raise SystemExit(EXIT_USAGE)
        print("ambiguous project name:\n  " + "\n  ".join(p.name for p in matches), file=sys.stderr)
        raise SystemExit(EXIT_USAGE)
    if all_projects:
        return sorted(p for p in root.iterdir() if p.is_dir())
    here = root / _encode_project_dir(Path.cwd())
    if here.is_dir():
        return [here]
    print("no transcripts for the current directory; searching all projects", file=sys.stderr)
    return sorted(p for p in root.iterdir() if p.is_dir())


def _file_contains(path: Path, needle: bytes, case_sensitive: bool, chunk: int = 8 << 20) -> bool:
    """Byte-level prefilter: does this file mention the term at all?

    Deliberately not ripgrep. It is absent from many real PATHs (it often exists only
    inside a host's bundled environment), so shelling out silently degrades to a full
    parse of every transcript. Worse, two matching engines means two case-folding
    rules: anything the external filter drops, the Python matcher never sees — a
    whole class of silent misses. `bytes.__contains__` is memchr-backed and scans
    gigabytes in seconds, which is fast enough to not need the dependency.

    `bytes.lower()` only folds ASCII, leaving non-Latin scripts untouched — exactly
    the intent, since case-insensitivity is meaningless for them.
    """
    overlap = len(needle) - 1
    tail = b""
    with path.open("rb") as fh:
        while True:
            buf = fh.read(chunk)
            if not buf:
                return False
            window = tail + buf
            if needle in (window if case_sensitive else window.lower()):
                return True
            # Carry the boundary so a term split across two reads still matches.
            tail = buf[-overlap:] if overlap else b""


def _prefilter(dirs: list[Path], needle: str, regex: bool, case_sensitive: bool) -> list[Path]:
    files = [f for d in dirs for f in sorted(d.glob("*.jsonl"))]
    if regex:
        # A pattern cannot be prefiltered by bytes without risking a match split
        # across chunk boundaries; scanning everything is slower but never misses.
        return files
    probe = needle.encode("utf-8")
    if not case_sensitive:
        probe = probe.lower()
    return [f for f in files if _file_contains(f, probe, case_sensitive)]


def _block_text(block: dict) -> tuple[str, str]:
    """Reduce one content block to (kind, searchable text). Empty text = skip."""
    kind = block.get("type") or "?"
    if kind == "text":
        return kind, block.get("text") or ""
    if kind == "thinking":
        return kind, block.get("thinking") or block.get("text") or ""
    if kind == "tool_use":
        name = block.get("name") or "tool"
        try:
            payload = json.dumps(block.get("input"), ensure_ascii=False)
        except (TypeError, ValueError):
            payload = str(block.get("input"))
        return f"tool_use:{name}", payload
    if kind == "tool_result":
        content = block.get("content")
        if isinstance(content, str):
            return kind, content
        if isinstance(content, list):
            parts = [b.get("text") or "" for b in content
                     if isinstance(b, dict) and b.get("type") == "text"]
            return kind, "\n".join(parts)
        return kind, ""
    # Images and other binary payloads carry no searchable text.
    return kind, ""


def iter_blocks(path: Path):
    """Stream one transcript, yielding (timestamp, role, kind, text)."""
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue  # partial write at the tail of a live session
            role = rec.get("type")
            if role not in ("user", "assistant"):
                continue
            ts = (rec.get("timestamp") or "")[:19].replace("T", " ")
            content = (rec.get("message") or {}).get("content")
            if isinstance(content, str):
                text = _strip_injected(content).strip()
                if text:
                    yield ts, role, "text", text
            elif isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    kind, text = _block_text(block)
                    if kind in SPEECH_KINDS:
                        text = _strip_injected(text).strip()
                    if text:
                        yield ts, role, kind, text


def _excerpt(text: str, needle: str, regex: bool, width: int, color: bool,
             case_sensitive: bool) -> list[str]:
    flags = 0 if case_sensitive else re.IGNORECASE
    pattern = needle if regex else re.escape(needle)
    hits = []
    for m in re.finditer(pattern, text, flags):
        lo = max(0, m.start() - width // 2)
        hi = min(len(text), m.end() + width // 2)
        chunk = re.sub(r"\s{2,}", " ", text[lo:hi].replace("\n", " ").replace("\r", " ")).strip()
        if color:
            frag = text[m.start():m.end()]
            chunk = chunk.replace(frag, f"{HIT}{frag}{RESET}", 1)
        hits.append(f"{'…' if lo > 0 else ''}{chunk}{'…' if hi < len(text) else ''}")
    return hits


def _in_range(ts: str, since: str | None, until: str | None) -> bool:
    if not ts:
        return not (since or until)
    day = ts[:10]
    if since and day < since:
        return False
    if until and day > until:
        return False
    return True


def cmd_search(args) -> int:
    color = _supports_color() and not args.no_color
    dirs = _resolve_dirs(args.root, args.all, args.project)
    if args.regex:
        try:
            re.compile(args.needle)
        except re.error as exc:
            print(f"bad regex: {exc}", file=sys.stderr)
            return EXIT_USAGE

    files = _prefilter(dirs, args.needle, args.regex, args.case_sensitive)
    rows, total, sessions = [], 0, 0

    for path in files:
        per_session = 0
        for ts, role, kind, text in iter_blocks(path):
            if args.role and role != args.role:
                continue
            if kind not in SPEECH_KINDS and not args.tools:
                continue
            if kind == "thinking" and args.no_thinking:
                continue
            if not _in_range(ts, args.since, args.until):
                continue
            body = text[:HUGE_BLOCK]
            for frag in _excerpt(body, args.needle, args.regex, args.context, color,
                                 args.case_sensitive):
                total += 1
                per_session += 1
                if per_session <= args.per_session:
                    rows.append((ts, path.stem, role, kind, frag))
                elif per_session == args.per_session + 1:
                    rows.append((ts, path.stem, role, "…",
                                 "(more hits in this session; raise --per-session)"))
        if per_session:
            sessions += 1

    rows.sort(key=lambda r: r[0])
    for ts, sid, role, kind, frag in rows:
        if color:
            print(f"{DIM}{ts}{RESET}  {ROLE_COLORS.get(role, '')}{sid[:8]}{RESET}  {DIM}{role}/{kind}{RESET}")
        else:
            print(f"{ts}  {sid[:8]}  {role}/{kind}")
        print(f"    {frag}")

    print()
    print(f"{total} hits in {sessions} sessions ({len(files)} transcripts scanned).")
    if rows:
        print(f"Replay one: python tools/engramory_trace.py --show {rows[0][1][:8]}")
        return 0
    return EXIT_NO_HITS


def cmd_show(args) -> int:
    color = _supports_color() and not args.no_color
    dirs = _resolve_dirs(args.root, True, None)
    matches = [f for d in dirs for f in d.glob(f"{args.show}*.jsonl")]
    if not matches:
        print(f"no session matching {args.show!r}", file=sys.stderr)
        return EXIT_NO_HITS
    if len(matches) > 1:
        print("ambiguous session id:\n  " + "\n  ".join(m.stem for m in matches), file=sys.stderr)
        return EXIT_USAGE

    path = matches[0]
    print(f"session {path.stem}  ({path.stat().st_size / 1e6:.1f} MB)  project {path.parent.name}")
    print("=" * 72)

    for ts, role, kind, text in iter_blocks(path):
        if kind in ("thinking", "tool_result") and not args.verbose:
            continue
        one = re.sub(r"\s+", " ", text).strip()
        if not one:
            continue
        limit = 2000 if args.verbose else 400
        if len(one) > limit:
            one = one[:limit] + f" …(+{len(text) - limit} chars)"
        if kind.startswith("tool_use"):
            label = kind.split(":", 1)[1]
            print(f"  {DIM}[{label}]{RESET} {one}" if color else f"  [{label}] {one}")
            continue
        head = (f"{DIM}{ts}{RESET} {ROLE_COLORS.get(role, '')}{role}{RESET}"
                if color else f"{ts} {role}")
        print(f"\n{head}\n  {one}")
    return 0


def cmd_list_projects(args) -> int:
    if not args.root.is_dir():
        print(f"transcript root not found: {args.root}", file=sys.stderr)
        return EXIT_UNREADABLE
    found = False
    for d in sorted(args.root.iterdir()):
        if not d.is_dir():
            continue
        files = list(d.glob("*.jsonl"))
        if not files:
            continue
        found = True
        size = sum(f.stat().st_size for f in files) / 1e6
        print(f"{len(files):>4} sessions  {size:>8.1f} MB  {d.name}")
    return 0 if found else EXIT_NO_HITS


def main() -> int:
    # Must precede parse_args(): argparse prints --help during parsing and exits, so
    # reconfiguring afterwards is too late and non-ASCII help text gets mangled on a
    # console whose default encoding is not UTF-8.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    p = argparse.ArgumentParser(
        prog="engramory_trace",
        description="Search the raw agent transcripts behind your memories "
                    "(memories hold conclusions; transcripts hold what was said).",
    )
    p.add_argument("needle", nargs="?", help="term to search for (literal by default)")
    p.add_argument("--show", metavar="SESSION", help="replay one session (id prefix is enough)")
    p.add_argument("--list-projects", action="store_true", help="list projects that have transcripts")
    p.add_argument("--root", type=Path, default=DEFAULT_ROOT,
                   help=f"transcript root (default: {DEFAULT_ROOT})")
    p.add_argument("--all", action="store_true", help="search every project, not just the current one")
    p.add_argument("--project", help="restrict to one project directory (substring ok)")
    p.add_argument("-C", "--context", type=int, default=160, help="context characters per hit (default 160)")
    p.add_argument("--per-session", type=int, default=5, help="max hits shown per session (default 5)")
    p.add_argument("--role", choices=["user", "assistant"], help="only one side of the conversation")
    p.add_argument("--tools", action="store_true",
                   help="also search tool calls and tool output (default: only what was said, "
                        "so re-injected standing context does not bury the discussion)")
    p.add_argument("--no-thinking", action="store_true", help="exclude reasoning blocks")
    p.add_argument("--since", metavar="YYYY-MM-DD", help="on or after this day")
    p.add_argument("--until", metavar="YYYY-MM-DD", help="on or before this day")
    p.add_argument("--regex", action="store_true", help="treat the term as a regular expression")
    p.add_argument("-s", "--case-sensitive", action="store_true", help="match case (default: insensitive)")
    p.add_argument("-v", "--verbose", action="store_true", help="--show: include reasoning and tool output")
    p.add_argument("--no-color", action="store_true", help="disable colored output")
    args = p.parse_args()

    if args.list_projects:
        return cmd_list_projects(args)
    if args.show:
        return cmd_show(args)
    if not args.needle:
        p.print_help()
        return EXIT_USAGE
    return cmd_search(args)


if __name__ == "__main__":
    sys.exit(main())
