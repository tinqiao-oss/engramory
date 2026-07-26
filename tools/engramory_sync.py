#!/usr/bin/env python3
"""
Record Codex/Engramory synchronization state without generating memory content.

Commands:

    python engramory_sync.py mark-synced MEMORY_ROOT [--session-id ID]
    python engramory_sync.py status MEMORY_ROOT [--json]

`mark-synced` is deliberately only an acknowledgement.  It verifies that the
store has a loadable MEMORY.md, then records that an agent/user has already
performed the semantic curation.  It never writes MEMORY.md or any detail note.

Bookkeeping is bounded to MAX_SESSIONS.  CLEAN records are evicted first, and
dirty/needs-reconcile ones are kept.  Only when those protected records ALONE
exceed the cap are the oldest of them dropped — counted in
`dropped_unsynced_sessions`, which `status` reports, so the per-session detail is
gone but the fact that unsynced work was dropped is never silently lost.  A
session this bookkeeping never observed, or a record that cannot prove it is
synced, counts as unsynced (fail-closed).
"""

import argparse
import contextlib
import datetime as _datetime
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time


STATE_FILENAME = ".engramory-codex-state.json"
LOCK_FILENAME = ".engramory-codex-state.lock"
SCHEMA_VERSION = 1
MAX_SESSIONS = 64
MAX_STATE_BYTES = 1024 * 1024
DEFAULT_HARD_LINES = 200
DEFAULT_HARD_BYTES = 25600


class SyncError(Exception):
    """An expected validation/state error suitable for showing to the user."""


def _quoted(value, limit=48):
    """Render untrusted store text for an error message.

    Anything read out of the store is attacker-influenceable and these messages
    travel into the hook's `systemMessage` / `additionalContext`, i.e. straight
    into the model's context. A session key of
    `IGNORE PREVIOUS INSTRUCTIONS AND ...` must therefore land as visibly quoted,
    length-bounded DATA, not as free-floating prose the model may read as
    instructions.
    """
    text = value if isinstance(value, str) else repr(value)
    if len(text) > limit:
        text = text[:limit] + "..."
    return repr(text)


def _now():
    return (
        _datetime.datetime.now(_datetime.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _positive_env_int(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw.strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _line_count(text):
    if not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def _memory_root(memory_root):
    try:
        root = Path(memory_root).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise SyncError("memory root does not exist or cannot be resolved: {}".format(exc))
    if not root.is_dir():
        raise SyncError("memory root is not a directory: {}".format(root))
    return root


def _state_path(root):
    return root / STATE_FILENAME


def _empty_state():
    return {
        "schema_version": SCHEMA_VERSION,
        "updated_at": None,
        "last_session_id": None,
        "sessions": {},
    }


def _session_id(value):
    if not isinstance(value, str):
        raise SyncError("session id must be a string")
    value = value.strip()
    if not value:
        raise SyncError("session id is missing")
    if len(value) > 256 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise SyncError("session id is invalid")
    return value


def _validate_state(data, path):
    if not isinstance(data, dict):
        raise SyncError("state file is not a JSON object: {}".format(path))
    if data.get("schema_version") != SCHEMA_VERSION:
        raise SyncError(
            "unsupported state schema in {} (expected {})".format(path, SCHEMA_VERSION)
        )
    sessions = data.get("sessions")
    if not isinstance(sessions, dict):
        raise SyncError("state file has an invalid sessions map: {}".format(path))
    if len(sessions) > 1024:
        raise SyncError("state file has an unreasonable number of sessions: {}".format(path))
    for key, value in sessions.items():
        if _session_id(key) != key:
            raise SyncError("state file has a non-canonical session id")
        if not isinstance(value, dict):
            raise SyncError("state file has an invalid session record: {}".format(_quoted(key)))
        for generation in ("dirty_generation", "synced_generation"):
            number = value.get(generation, 0)
            if (
                isinstance(number, bool)
                or not isinstance(number, int)
                or number < 0
            ):
                raise SyncError(
                    "state file has an invalid {} for session {}".format(
                        generation, _quoted(key)
                    )
                )
            value[generation] = number
        # Fail CLOSED on anything that cannot PROVE the session is synced. The
        # store is user-visible plain text that another process, an editor, or a
        # future/older writer can leave incomplete, so a MISSING or non-boolean
        # `dirty` must not read as "clean" — that would silently open the manual
        # compaction gate this record exists to hold shut. Likewise the
        # generations are the ground truth: a clean flag that contradicts them
        # (synced behind dirty) is evidence of unsynced work, not of a clean
        # session. `needs_reconcile` defaults False because an unprovable record
        # is already held by `dirty`; forcing it True would demand a reconcile
        # pass no event ever requested.
        if not isinstance(value.get("dirty"), bool):
            value["dirty"] = True
        if not isinstance(value.get("needs_reconcile"), bool):
            value["needs_reconcile"] = False
        if value["synced_generation"] < value["dirty_generation"]:
            value["dirty"] = True
    data["dropped_unsynced_sessions"] = _dropped_count(data)
    last = data.get("last_session_id")
    if last is not None:
        last = _session_id(last)
        if last not in sessions:
            last = None
    data["last_session_id"] = last
    return data


def _load_state(root):
    path = _state_path(root)
    if not path.exists():
        return _empty_state()
    if path.is_symlink():
        raise SyncError("refusing symlinked state file: {}".format(path))
    try:
        size = path.stat().st_size
        if size > MAX_STATE_BYTES:
            raise SyncError("state file is unexpectedly large: {}".format(path))
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except SyncError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SyncError("cannot read state file {}: {}".format(path, exc))
    return _validate_state(data, path)


def _dropped_count(state):
    """Sessions evicted by the cap while still unsynced. Never silently reset."""
    value = state.get("dropped_unsynced_sessions")
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0
    return value


def _prune_sessions(state, keep_session_id=None):
    sessions = state["sessions"]
    if len(sessions) <= MAX_SESSIONS:
        return

    protected = []
    clean = []
    for item in sessions.items():
        session_id, record = item
        if (
                session_id == keep_session_id
                or bool(record.get("dirty"))
                or bool(record.get("needs_reconcile"))):
            protected.append(item)
        else:
            clean.append(item)

    # The cap must never make an unsynced session look clean — but it must not
    # wedge the store either. Raising here stranded the CURRENT session: its own
    # record was never written, so the hook blocked manual compaction while
    # naming a session id `mark-synced` could not resolve ("unknown session id"),
    # leaving the emitted recovery command guaranteed to fail. Evict the OLDEST
    # unsynced records instead and carry their COUNT forward, so the fact that
    # unsynced work was dropped survives even though the per-session detail does
    # not. The current session is always kept, so its gate stays accurate.
    if len(protected) > MAX_SESSIONS:
        current = [item for item in protected if item[0] == keep_session_id]
        others = [item for item in protected if item[0] != keep_session_id]
        others.sort(
            key=lambda item: (str(item[1].get("updated_at") or ""), item[0]),
            reverse=True,
        )
        room = max(0, MAX_SESSIONS - len(current))
        state["dropped_unsynced_sessions"] = _dropped_count(state) + len(
            others[room:])
        protected = current + others[:room]
        clean = []

    clean.sort(
        key=lambda item: (str(item[1].get("updated_at") or ""), item[0]),
        reverse=True,
    )
    kept = protected + clean[:MAX_SESSIONS - len(protected)]
    state["sessions"] = dict(kept)
    if state.get("last_session_id") not in state["sessions"]:
        state["last_session_id"] = keep_session_id if keep_session_id in state["sessions"] else None


def _atomic_write_json(path, value):
    payload = json.dumps(
        value, ensure_ascii=False, indent=2, sort_keys=True, separators=(",", ": ")
    ) + "\n"
    fd = None
    temp_name = None
    try:
        fd, temp_name = tempfile.mkstemp(
            prefix=".engramory-codex-state-", suffix=".tmp", dir=str(path.parent)
        )
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            fd = None
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, str(path))
        temp_name = None
        # Best effort: persist the directory entry on POSIX. Windows cannot open a
        # directory with os.open, and os.replace already has the required semantics.
        if os.name != "nt":
            try:
                directory_fd = os.open(str(path.parent), os.O_RDONLY)
            except OSError:
                directory_fd = None
            if directory_fd is not None:
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
    except OSError as exc:
        raise SyncError("cannot atomically write state file {}: {}".format(path, exc))
    finally:
        if fd is not None:
            os.close(fd)
        if temp_name is not None:
            try:
                os.unlink(temp_name)
            except OSError:
                pass


@contextlib.contextmanager
def _state_lock(root, timeout=2.0):
    """Small cross-platform lock preventing lost read/modify/write updates."""
    path = root / LOCK_FILENAME
    deadline = time.monotonic() + timeout
    fd = None
    while fd is None:
        try:
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            try:
                stale = (time.time() - path.stat().st_mtime) > 30.0
            except OSError:
                stale = False
            if stale:
                try:
                    path.unlink()
                    continue
                except OSError:
                    pass
            if time.monotonic() >= deadline:
                raise SyncError("timed out waiting for state lock: {}".format(path))
            time.sleep(0.025)
        except OSError as exc:
            raise SyncError("cannot create state lock {}: {}".format(path, exc))
    try:
        os.write(fd, "{} {}\n".format(os.getpid(), time.time()).encode("ascii"))
        os.fsync(fd)
        os.close(fd)
        fd = None
        yield
    finally:
        if fd is not None:
            os.close(fd)
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            # The state update is already atomic; a leftover lock becomes stale and
            # is recoverable, so cleanup failure must not corrupt the state.
            pass


def _new_session(mode):
    return {
        "dirty": False,
        "needs_reconcile": False,
        "dirty_generation": 0,
        "synced_generation": 0,
        "mode": mode,
        "last_event": None,
        "updated_at": None,
    }


def _session(state, session_id, mode):
    """Return (record, is_new). `is_new` matters: a session the bookkeeping has
    never seen carries no evidence either way, and callers that gate on it must
    not read a freshly synthesized record as proof of a synced session."""
    sessions = state["sessions"]
    record = sessions.get(session_id)
    if record is None:
        record = _new_session(mode)
        sessions[session_id] = record
        return record, True
    return record, False


def _mutate(memory_root, session_id, mode, change):
    root = _memory_root(memory_root)
    session_id = _session_id(session_id)
    if mode not in ("explicit", "assisted"):
        raise SyncError("unsupported sync mode: {}".format(mode))
    with _state_lock(root):
        state = _load_state(root)
        record, is_new = _session(state, session_id, mode)
        timestamp = _now()
        change(record, timestamp, is_new)
        record["mode"] = mode
        record["updated_at"] = timestamp
        state["last_session_id"] = session_id
        state["updated_at"] = timestamp
        _prune_sessions(state, keep_session_id=session_id)
        _atomic_write_json(_state_path(root), state)
        return dict(record)


def record_session_start(memory_root, session_id, mode="explicit", source=None):
    """Register a session without changing its dirty/synced generations."""

    def change(record, timestamp, is_new):
        record["last_event"] = "SessionStart"
        if isinstance(source, str) and source:
            record["last_session_start_source"] = source[:64]

    return _mutate(memory_root, session_id, mode, change)


def mark_dirty(memory_root, session_id, mode="explicit"):
    """Mark a session dirty. No user prompt or prompt-derived text is accepted/stored."""

    def change(record, timestamp, is_new):
        try:
            generation = int(record.get("dirty_generation", 0))
        except (TypeError, ValueError):
            generation = 0
        record["dirty_generation"] = max(0, generation) + 1
        record["dirty"] = True
        record["dirty_at"] = timestamp
        record["last_event"] = "UserPromptSubmit"

    return _mutate(memory_root, session_id, mode, change)


def record_precompact(memory_root, session_id, mode="explicit", trigger="unknown"):
    """Record compaction state and return the session record used for the decision."""
    trigger = trigger if isinstance(trigger, str) and trigger else "unknown"
    trigger = trigger.lower()[:32]

    def change(record, timestamp, is_new):
        record["last_event"] = "PreCompact"
        record["last_precompact_trigger"] = trigger
        # A compaction is the FIRST thing this bookkeeping ever saw of the
        # session: it cannot have observed the prompts that came before, so it
        # has no evidence the work is synced. That happens when the hooks were
        # trusted mid-session, when the state file was deleted or reset, or when
        # an earlier dirty write failed. Treating the synthesized blank record as
        # "clean" would open the one gate that is supposed to fail CLOSED, so
        # count it as unsynced instead. A normal session is unaffected: its
        # SessionStart already created the record.
        if is_new:
            record["dirty"] = True
            record["unobserved_session"] = True
        # Only an explicitly identified manual compaction may be blocked by the
        # hook. Auto and unknown/missing trigger values fail open, so preserve a
        # reconciliation marker whenever unsynced work crosses that boundary.
        if trigger != "manual" and bool(record.get("dirty")):
            record["needs_reconcile"] = True
            record["reconcile_requested_at"] = timestamp

    return _mutate(memory_root, session_id, mode, change)


def _inspect_memory_index(root):
    path = root / "MEMORY.md"
    if not path.exists() or not path.is_file():
        raise SyncError("MEMORY.md does not exist in memory root: {}".format(root))
    if path.is_symlink():
        raise SyncError("refusing symlinked MEMORY.md: {}".format(path))
    try:
        resolved = path.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError):
        raise SyncError("MEMORY.md resolves outside the memory root: {}".format(path))
    hard_lines = _positive_env_int("ENGRAMORY_HARD", DEFAULT_HARD_LINES)
    hard_bytes = _positive_env_int("ENGRAMORY_HARD_BYTES", DEFAULT_HARD_BYTES)
    try:
        with open(path, "rb") as handle:
            raw = handle.read(hard_bytes + 1)
            if len(raw) <= hard_bytes:
                raw += handle.read()
    except OSError as exc:
        raise SyncError("cannot read MEMORY.md: {}".format(exc))
    text = raw.decode("utf-8-sig", "replace")
    lines = _line_count(text)
    nbytes = len(raw)
    if lines > hard_lines or nbytes > hard_bytes:
        dimensions = []
        if lines > hard_lines:
            dimensions.append("{} lines > {}".format(lines, hard_lines))
        if nbytes > hard_bytes:
            dimensions.append("{} bytes > {}".format(nbytes, hard_bytes))
        raise SyncError(
            "MEMORY.md is beyond the recall hard limit ({}); compact it before "
            "marking the session synced".format(", ".join(dimensions))
        )
    return {
        "path": str(path),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "lines": lines,
        "bytes": nbytes,
        "hard_lines": hard_lines,
        "hard_bytes": hard_bytes,
    }


def _resolve_mark_session(state, requested):
    if requested is not None:
        session_id = _session_id(requested)
        if session_id not in state["sessions"]:
            raise SyncError("unknown session id: {}".format(session_id))
        return session_id
    last = state.get("last_session_id")
    if isinstance(last, str) and last in state["sessions"]:
        return last
    if len(state["sessions"]) == 1:
        return next(iter(state["sessions"]))
    if not state["sessions"]:
        raise SyncError("there is no Codex session state to mark synced")
    raise SyncError("session id is ambiguous; pass --session-id")


def mark_synced(memory_root, session_id=None):
    """
    Acknowledge completed semantic curation; never creates or edits memory notes.

    The operation is idempotent when both session state and MEMORY.md metadata are
    already the same.
    """
    root = _memory_root(memory_root)
    with _state_lock(root):
        state = _load_state(root)
        selected = _resolve_mark_session(state, session_id)
        index = _inspect_memory_index(root)
        record = state["sessions"][selected]
        dirty_generation = record.get("dirty_generation", 0)
        synced_generation = record.get("synced_generation", 0)
        unchanged = (
            not bool(record.get("dirty"))
            and not bool(record.get("needs_reconcile"))
            and synced_generation == dirty_generation
            and record.get("memory_index_sha256") == index["sha256"]
            and record.get("memory_index_lines") == index["lines"]
            and record.get("memory_index_bytes") == index["bytes"]
        )
        if unchanged:
            return {
                "changed": False,
                "session_id": selected,
                "session": dict(record),
                "memory_index": index,
            }

        timestamp = _now()
        record["dirty"] = False
        record["needs_reconcile"] = False
        record["synced_generation"] = max(0, dirty_generation)
        record["synced_at"] = timestamp
        record["last_event"] = "mark-synced"
        record["memory_index_sha256"] = index["sha256"]
        record["memory_index_lines"] = index["lines"]
        record["memory_index_bytes"] = index["bytes"]
        record["updated_at"] = timestamp
        state["last_session_id"] = selected
        state["updated_at"] = timestamp
        _prune_sessions(state, keep_session_id=selected)
        _atomic_write_json(_state_path(root), state)
        return {
            "changed": True,
            "session_id": selected,
            "session": dict(record),
            "memory_index": index,
        }


def status_snapshot(memory_root):
    """Return state and index metadata, never note contents."""
    root = _memory_root(memory_root)
    state = _load_state(root)
    _prune_sessions(state, keep_session_id=state.get("last_session_id"))
    try:
        index = _inspect_memory_index(root)
        index_status = {"ok": True}
        index_status.update(index)
    except SyncError as exc:
        index_status = {
            "ok": False,
            "path": str(root / "MEMORY.md"),
            "error": str(exc),
        }
    return {
        "schema_version": SCHEMA_VERSION,
        "memory_root": str(root),
        "state_path": str(_state_path(root)),
        "last_session_id": state.get("last_session_id"),
        "updated_at": state.get("updated_at"),
        "session_count": len(state["sessions"]),
        "dropped_unsynced_sessions": _dropped_count(state),
        "sessions": state["sessions"],
        "memory_index": index_status,
    }


def _configure_console():
    for stream in (sys.stdout, sys.stderr):
        try:
            # Keep `status --json` valid and paths/session IDs lossless on
            # Windows hosts whose redirected default is a legacy code page.
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, ValueError, OSError):
            pass


def _parser():
    parser = argparse.ArgumentParser(
        description="Inspect or acknowledge Codex/Engramory synchronization state."
    )
    commands = parser.add_subparsers(dest="command", required=True)

    mark = commands.add_parser(
        "mark-synced",
        help="acknowledge an already-completed Engramory continuity sync",
    )
    mark.add_argument("memory_root")
    mark.add_argument("--session-id")

    status = commands.add_parser("status", help="show synchronization state")
    status.add_argument("memory_root")
    status.add_argument("--json", action="store_true", dest="as_json")
    return parser


def _print_status(snapshot, as_json):
    if as_json:
        print(json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True))
        return
    print("Engramory Codex sync state: {}".format(snapshot["memory_root"]))
    print(
        "MEMORY.md: {}".format(
            "{} lines / {} bytes (loadable)".format(
                snapshot["memory_index"].get("lines"),
                snapshot["memory_index"].get("bytes"),
            )
            if snapshot["memory_index"].get("ok")
            else snapshot["memory_index"].get("error")
        )
    )
    print(
        "sessions: {} (last: {})".format(
            snapshot["session_count"], snapshot.get("last_session_id") or "-"
        )
    )
    dropped = snapshot.get("dropped_unsynced_sessions") or 0
    if dropped:
        print(
            "note: {} unsynced session(s) were dropped to stay within the {}-session "
            "cap; their per-session detail is gone, so re-check the store itself "
            "for unsaved continuity.".format(dropped, MAX_SESSIONS)
        )
    for session_id, record in sorted(snapshot["sessions"].items()):
        print(
            "- {}: dirty={}, needs_reconcile={}, generation={}/{}".format(
                session_id,
                bool(record.get("dirty")),
                bool(record.get("needs_reconcile")),
                record.get("synced_generation", 0),
                record.get("dirty_generation", 0),
            )
        )


def main(argv=None):
    _configure_console()
    args = _parser().parse_args(argv)
    try:
        if args.command == "mark-synced":
            result = mark_synced(args.memory_root, args.session_id)
            verb = "recorded" if result["changed"] else "already current"
            print(
                "Engramory sync acknowledgement {} for session {}. "
                "No memory content was generated or changed.".format(
                    verb, result["session_id"]
                )
            )
            return 0
        snapshot = status_snapshot(args.memory_root)
        _print_status(snapshot, args.as_json)
        return 0
    except SyncError as exc:
        print("engramory-sync: {}".format(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
