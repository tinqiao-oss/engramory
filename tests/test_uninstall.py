"""P0 tests for `--uninstall`: it must unwire the host and never touch the store.

The asymmetry these tests pin down: uninstall DELETES from files the user owns, so
every ambiguous case has to fail safe. It removes only what this installer wrote —
its marked block, its skill copy, its own Codex handlers — and leaves anything it
cannot prove is its own, loudly.

The second half of the file is the adversarial set: each of those cases is a way an
earlier cut of this feature destroyed data (store inside a deletable directory, a
symlinked parent turning `unlink` into a delete outside the project, a reader wiping
the write host's skill, an empty user hook group read as ours).
"""

import json
import subprocess
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
INIT = REPO / "tools" / "engramory_init.py"

USER_RULE = "Keep me: this line is the user's own rule."


def _run(host, project, *extra):
    proc = subprocess.run(
        [sys.executable, str(INIT), host, "--project-root", str(project), *map(str, extra)],
        capture_output=True,
        text=True,
    )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def _digest(root):
    import hashlib

    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file():
            h.update(str(p.relative_to(root)).replace("\\", "/").encode())
            h.update(p.read_bytes())
    return h.hexdigest()


def _try_symlink(link, target, directory):
    """Create a symlink, or return False where the OS/user cannot (plain Windows)."""
    try:
        link.symlink_to(target, target_is_directory=directory)
        return link.is_symlink()
    except (OSError, NotImplementedError):
        return False


# --- the happy paths -------------------------------------------------------------

def test_removes_block_but_keeps_the_users_own_lines(tmp_path):
    rules = tmp_path / "AGENTS.md"
    rules.write_text("# My rules\n\n" + USER_RULE + "\n", encoding="utf-8")
    code, _ = _run("codex", tmp_path)
    assert code == 0
    assert "BEGIN ENGRAMORY CODEX" in rules.read_text(encoding="utf-8")

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    text = rules.read_text(encoding="utf-8")
    assert "ENGRAMORY" not in text, text
    assert USER_RULE in text, text


def test_never_touches_the_memory_store(tmp_path):
    code, _ = _run("codex", tmp_path)
    assert code == 0
    store = tmp_path / ".engramory-memory"
    note = store / "irreplaceable.md"
    note.write_text("---\nname: irreplaceable\n---\n\nuser data\n", encoding="utf-8")

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert (store / "MEMORY.md").is_file(), "uninstall deleted the index"
    assert note.is_file() and "user data" in note.read_text(encoding="utf-8")
    # The store's ignore rule must stay: the store is still on disk, and un-ignoring it
    # would start tracking machine-local notes in git.
    assert ".engramory-memory" in (tmp_path / ".gitignore").read_text(encoding="utf-8")
    assert "NOT touched" in out


def test_dry_run_writes_nothing(tmp_path):
    assert _run("codex", tmp_path, "--install-skill")[0] == 0
    before = _digest(tmp_path)
    code, out = _run("codex", tmp_path, "--uninstall", "--dry-run")
    assert code == 0, out
    assert _digest(tmp_path) == before, "--dry-run modified the tree"
    assert "nothing was written" in out


def test_codex_hooks_and_managed_scripts_are_removed(tmp_path):
    assert _run("codex", tmp_path, "--install-hooks")[0] == 0
    hooks = tmp_path / ".codex" / "hooks.json"
    assert hooks.is_file()

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    # The file carried only our handlers and the description we added, so it goes.
    assert not hooks.exists(), hooks.read_text(encoding="utf-8")
    assert not (tmp_path / ".codex" / "engramory").exists()


def test_reader_removes_its_dedicated_rule_file_and_spares_the_store(tmp_path):
    store = tmp_path / "extstore"
    store.mkdir()
    (store / "MEMORY.md").write_text("# MEMORY\n", encoding="utf-8")
    project = tmp_path / "proj"
    project.mkdir()
    code, out = _run("kiro-reader", project, "--memory-root", store)
    assert code == 0, out
    rule = project / ".kiro" / "steering" / "engramory-recall.md"
    assert rule.is_file()

    code, out = _run("kiro-reader", project, "--memory-root", store, "--uninstall")
    assert code == 0, out
    assert not rule.exists()
    assert (store / "MEMORY.md").is_file(), "reader uninstall touched the shared store"


def test_uninstall_on_a_never_installed_tree_is_a_clean_noop(tmp_path):
    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert "absent" in out or "no Engramory block" in out


# --- refusing to guess ------------------------------------------------------------

def test_malformed_markers_leave_the_file_byte_identical(tmp_path):
    assert _run("codex", tmp_path)[0] == 0
    rules = tmp_path / "AGENTS.md"
    text = rules.read_text(encoding="utf-8")
    # A botched hand-edit that duplicates BEGIN: the block's extent is now ambiguous.
    rules.write_text(
        text.replace("<!-- BEGIN ENGRAMORY CODEX -->",
                     "<!-- BEGIN ENGRAMORY CODEX -->\n<!-- BEGIN ENGRAMORY CODEX -->", 1),
        encoding="utf-8",
    )
    before = rules.read_bytes()
    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert rules.read_bytes() == before, "a malformed file was rewritten"
    assert "LEFT UNTOUCHED" in out


def test_indentation_after_the_end_marker_survives(tmp_path):
    assert _run("codex", tmp_path)[0] == 0
    rules = tmp_path / "AGENTS.md"
    indented = "- outer\n    - nested item the user indented\n"
    rules.write_text(rules.read_text(encoding="utf-8") + "\n" + indented, encoding="utf-8")

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    text = rules.read_text(encoding="utf-8")
    assert "    - nested item the user indented" in text, repr(text)


def test_partial_skill_dir_is_left_alone(tmp_path):
    assert _run("codex", tmp_path)[0] == 0
    # A SKILL.md alone proves the directory is *a* skill, not that it is OURS.
    stray = tmp_path / ".agents" / "skills" / "engramory"
    stray.mkdir(parents=True)
    (stray / "SKILL.md").write_text("# Someone else's skill\n", encoding="utf-8")
    (stray / "notes.txt").write_text("not ours\n", encoding="utf-8")

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert (stray / "notes.txt").is_file(), "deleted a skill dir that was not our install"
    assert "not recognisable as an Engramory skill install" in out


def test_an_empty_user_hook_group_is_not_mistaken_for_ours(tmp_path):
    # Never installed by us; the group is the user's and its handler list is empty.
    codex_dir = tmp_path / ".codex"
    codex_dir.mkdir()
    hooks = codex_dir / "hooks.json"
    hooks.write_text(json.dumps(
        {"hooks": {"SessionStart": [{"matcher": "startup", "hooks": []}]}}, indent=2),
        encoding="utf-8")
    before = hooks.read_bytes()

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert hooks.is_file(), "deleted a hooks.json that never held an Engramory handler"
    assert hooks.read_bytes() == before, "rewrote a hooks.json that was not ours"


def test_a_foreign_handler_keeps_hooks_json_alive(tmp_path):
    assert _run("codex", tmp_path, "--install-hooks")[0] == 0
    hooks = tmp_path / ".codex" / "hooks.json"
    data = json.loads(hooks.read_text(encoding="utf-8"))
    data["hooks"].setdefault("SessionStart", []).append(
        {"hooks": [{"type": "command", "command": "echo teammate",
                    "statusMessage": "Someone else's hook"}]}
    )
    hooks.write_text(json.dumps(data, indent=2), encoding="utf-8")

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert hooks.is_file(), "uninstall deleted a shared hooks.json"
    surviving = json.dumps(json.loads(hooks.read_text(encoding="utf-8")))
    assert "echo teammate" in surviving, surviving
    assert "Engramory" not in surviving, surviving


def test_malformed_hooks_json_is_reported_not_fatal(tmp_path):
    assert _run("codex", tmp_path)[0] == 0
    codex_dir = tmp_path / ".codex"
    codex_dir.mkdir(exist_ok=True)
    (codex_dir / "hooks.json").write_text("{ not json", encoding="utf-8")

    code, out = _run("codex", tmp_path, "--uninstall")
    # It must still complete and report, not abort half-way with an "install" error.
    assert code == 0, out
    assert "LEFT UNTOUCHED" in out
    assert "ENGRAMORY" not in (tmp_path / "AGENTS.md").read_text(encoding="utf-8")


# --- never delete the store, however it is arranged -------------------------------

def test_refuses_when_the_store_sits_in_the_managed_hook_dir(tmp_path):
    # No --install-hooks, so the install-time overlap guard never fires.
    code, out = _run("codex", tmp_path, "--memory-root", ".codex/engramory")
    assert code == 0, out
    store = tmp_path / ".codex" / "engramory"
    assert (store / "MEMORY.md").is_file()

    code, out = _run("codex", tmp_path, "--uninstall", "--memory-root", ".codex/engramory")
    assert code != 0, "expected a refusal"
    assert (store / "MEMORY.md").is_file(), "UNINSTALL DELETED THE MEMORY STORE"
    # Preflight: it refuses before touching anything, so the block is still there too.
    assert "ENGRAMORY" in (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
    assert "overlaps the memory store" in out


def test_uninstall_without_memory_root_keeps_a_store_in_the_hook_dir(tmp_path):
    """The overlap guard cannot fire when the uninstall does not restate --memory-root.

    `_refuse_store_overlap` compares against the memory root resolved for the CURRENT
    invocation, and the install location is not persisted anywhere. README documents
    the bare `--uninstall`, so the check silently compared against the default path
    and `.codex/engramory` - the user's actual store - was rmtree'd, while the report
    still printed "Your notes ... are left exactly as they are".

    The fix does not depend on knowing where the store is: uninstall deletes the two
    managed scripts BY NAME and only rmdir's the directory when nothing else is left.
    """
    code, out = _run("codex", tmp_path, "--memory-root", ".codex/engramory")
    assert code == 0, out
    store = tmp_path / ".codex" / "engramory"
    (store / "precious.md").write_text("half a year of notes\n", encoding="utf-8")

    # Exactly the command README teaches - no --memory-root.
    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert (store / "MEMORY.md").is_file(), "UNINSTALL DELETED THE MEMORY INDEX"
    assert (store / "precious.md").is_file(), "UNINSTALL DELETED THE USER'S NOTES"
    # It must not promise the notes are safe while naming a path that does not exist.
    assert "are left exactly as they are" not in out


def test_uninstall_without_memory_root_keeps_a_store_in_the_skill_dir(tmp_path):
    """Same shape for the skill dir, where the fingerprint check is what saves it."""
    code, out = _run("codex", tmp_path, "--memory-root", ".agents/skills/engramory")
    assert code == 0, out
    store = tmp_path / ".agents" / "skills" / "engramory"
    (store / "precious.md").write_text("notes\n", encoding="utf-8")

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert (store / "MEMORY.md").is_file(), "UNINSTALL DELETED THE MEMORY INDEX"
    assert "not recognisable as an Engramory skill install" in out


def test_a_foreign_file_in_the_hook_dir_keeps_the_directory(tmp_path):
    """Deleting by name must degrade to keeping the directory, not to rmtree."""
    code, out = _run("codex", tmp_path, "--install-hooks")
    assert code == 0, out
    managed = tmp_path / ".codex" / "engramory"
    assert (managed / "engramory_codex_hook.py").is_file()
    (managed / "notes-of-mine.md").write_text("mine\n", encoding="utf-8")

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert not (managed / "engramory_codex_hook.py").exists(), "our script should go"
    assert not (managed / "engramory_sync.py").exists(), "our script should go"
    assert (managed / "notes-of-mine.md").is_file(), "UNINSTALL DELETED A FOREIGN FILE"
    assert "KEPT" in out


def test_uninstall_keeps_a_store_kept_inside_the_skill_dir(tmp_path):
    """The fingerprint proves the directory IS ours - not that everything in it is.

    With the skill installed, all four fingerprint files are present, so the old
    `rmtree(skill_root)` fired and took a store kept at that same path with it -
    while the report still printed the memory store as untouched. `--memory-root
    .agents/skills/engramory` is accepted by a plain init (the install-time overlap
    guard only fires when the same run passes --install-skill), and a bare uninstall
    resolves the DEFAULT store path, so the overlap check never sees the real one.
    """
    code, out = _run("codex", tmp_path, "--install-skill")
    assert code == 0, out
    skill = tmp_path / ".agents" / "skills" / "engramory"
    assert (skill / "SKILL.md").is_file(), "fingerprint must be complete for this test"

    code, out = _run("codex", tmp_path, "--memory-root", ".agents/skills/engramory")
    assert code == 0, out
    (skill / "precious.md").write_text("half a year of notes\n", encoding="utf-8")

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert (skill / "MEMORY.md").is_file(), "UNINSTALL DELETED THE MEMORY INDEX"
    assert (skill / "precious.md").is_file(), "UNINSTALL DELETED THE USER'S NOTES"
    # The payload itself is still gone - this must not become "uninstall does nothing".
    assert not (skill / "SKILL.md").exists()
    assert not (skill / "templates").exists()


def test_a_clean_skill_dir_leaves_no_remains(tmp_path):
    """Removing entry-by-entry must not degrade into leaving an empty shell behind."""
    code, out = _run("codex", tmp_path, "--install-skill")
    assert code == 0, out
    skill = tmp_path / ".agents" / "skills" / "engramory"
    assert (skill / "templates").is_dir()

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert not skill.exists(), "a skill dir holding only our payload should be gone"


def test_a_same_named_file_we_did_not_write_is_kept(tmp_path):
    """A shared filename is not ownership.

    Deleting `.codex/engramory/engramory_sync.py` on the strength of its NAME would
    destroy a user's own file sitting at that path - the same class of loss as the
    rmtree this replaced, just narrower. Both managed scripts carry "Engramory" in
    their header, so a content check is enough to tell them apart.
    """
    code, out = _run("codex", tmp_path, "--memory-root", ".codex/engramory")
    assert code == 0, out
    store = tmp_path / ".codex" / "engramory"
    mine = store / "engramory_sync.py"
    mine.write_text('"""My own helper. Unrelated to anything else."""\n', encoding="utf-8")

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert mine.is_file(), "UNINSTALL DELETED A FILE IT DID NOT WRITE"
    assert "My own helper" in mine.read_text(encoding="utf-8")
    assert (store / "MEMORY.md").is_file()


def test_a_users_own_file_mentioning_engramory_is_still_kept(tmp_path):
    """The fingerprint has to be specific, not just the project's name.

    Someone writing their own tooling around Engramory can easily mention it in a
    file that happens to share one of the managed names - matching on the bare word
    would delete their work.
    """
    code, out = _run("codex", tmp_path, "--memory-root", ".codex/engramory")
    assert code == 0, out
    mine = tmp_path / ".codex" / "engramory" / "engramory_sync.py"
    mine.write_text(
        '"""My wrapper around Engramory: keeps our team notes tidy."""\n',
        encoding="utf-8")

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert mine.is_file(), "UNINSTALL DELETED A FILE IT DID NOT WRITE"
    assert "My wrapper around Engramory" in mine.read_text(encoding="utf-8")


def test_managed_script_markers_match_the_shipped_files(tmp_path):
    """The fingerprints are copies of text that lives in another file - pin them.

    Reword a script's header without updating the marker and uninstall quietly stops
    recognising its own file: it is kept and reported instead of removed. That is the
    safe direction, but it should never happen silently.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location("engramory_init", INIT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    sources = {
        "engramory_codex_hook.py": REPO / "hooks" / "codex" / "engramory_codex_hook.py",
        "engramory_sync.py": REPO / "tools" / "engramory_sync.py",
    }
    assert set(sources) == set(module._MANAGED_SCRIPT_MARKERS), "marker set drifted"
    for name, marker in module._MANAGED_SCRIPT_MARKERS.items():
        head = sources[name].read_bytes()[:4096]
        assert marker in head, "%s no longer contains its fingerprint: %r" % (name, marker)


def test_a_managed_name_that_is_a_directory_does_not_crash_the_uninstall(tmp_path):
    """Every filesystem call in the delete path has to degrade into the report.

    By the time it runs, the rules block and the skill are already gone - an
    unhandled OSError here would leave a half-uninstalled tree and a traceback
    instead of the summary that tells the user what actually happened.
    """
    code, out = _run("codex", tmp_path, "--install-hooks")
    assert code == 0, out
    managed = tmp_path / ".codex" / "engramory"
    (managed / "engramory_sync.py").unlink()
    (managed / "engramory_sync.py").mkdir()  # same name, but a directory

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert "Traceback" not in out, out
    assert "Uninstalled Engramory wiring" in out, "the report must still be printed"
    assert (managed / "engramory_sync.py").is_dir(), "a directory is not ours to delete"


def test_a_clean_hook_dir_is_still_removed_completely(tmp_path):
    """The conservative delete must not leave an empty directory behind."""
    code, out = _run("codex", tmp_path, "--install-hooks")
    assert code == 0, out
    managed = tmp_path / ".codex" / "engramory"
    assert managed.is_dir()

    code, out = _run("codex", tmp_path, "--uninstall")
    assert code == 0, out
    assert not managed.exists(), "a directory holding only our scripts should be gone"


def test_refuses_when_the_store_sits_in_the_skill_dir(tmp_path):
    code, out = _run("codex", tmp_path, "--memory-root", ".agents/skills/engramory")
    assert code == 0, out
    store = tmp_path / ".agents" / "skills" / "engramory"
    assert (store / "MEMORY.md").is_file()

    code, out = _run("codex", tmp_path, "--uninstall",
                     "--memory-root", ".agents/skills/engramory")
    assert code != 0, "expected a refusal"
    assert (store / "MEMORY.md").is_file(), "UNINSTALL DELETED THE MEMORY STORE"
    assert "overlaps the memory store" in out


def test_reader_never_deletes_a_write_hosts_skill(tmp_path):
    # Both hosts resolve the same `.agents/skills/engramory` path, but a reader is
    # refused --install-skill, so it can never own one.
    assert _run("codex", tmp_path, "--install-skill")[0] == 0
    skill = tmp_path / ".agents" / "skills" / "engramory"
    assert (skill / "SKILL.md").is_file()
    store = tmp_path / ".engramory-memory"

    code, out = _run("codex-reader", tmp_path, "--memory-root", store, "--uninstall")
    assert code == 0, out
    assert (skill / "SKILL.md").is_file(), "a reader deleted the write host's skill"
    assert "a reader installs none" in out


def test_symlinked_rule_file_parent_does_not_escape(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    victim = outside / "engramory-recall.md"
    victim.write_text("Engramory - but this file lives outside the project\n",
                      encoding="utf-8")
    project = tmp_path / "proj"
    (project / ".kiro").mkdir(parents=True)
    if not _try_symlink(project / ".kiro" / "steering", outside, True):
        return  # no symlink privilege here; the guard is exercised on POSIX CI
    store = tmp_path / "extstore"
    store.mkdir()
    (store / "MEMORY.md").write_text("# MEMORY\n", encoding="utf-8")

    _run("kiro-reader", project, "--memory-root", store, "--uninstall")
    assert victim.is_file(), "unlink followed a symlinked parent out of the project"


# --- flag hygiene -----------------------------------------------------------------

def test_refuses_to_mix_uninstall_with_install_flags(tmp_path):
    assert _run("codex", tmp_path, "--uninstall", "--install-skill")[0] != 0
    assert _run("codex", tmp_path, "--uninstall", "--install-hooks")[0] != 0


def test_dry_run_alone_is_refused(tmp_path):
    # Silently ignoring it would let a cautious preview run write for real.
    assert _run("codex", tmp_path, "--dry-run")[0] != 0


def _main():
    import pathlib
    import shutil
    import tempfile

    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    print(f"init: {INIT}\nrunning {len(tests)} tests\n")
    failed = 0
    for fn in tests:
        # resolve(): CI's %TEMP% is a DOS 8.3 alias (RUNNER~1); the tools
        # canonicalise to the long form, so path assertions need the same spelling.
        d = pathlib.Path(tempfile.mkdtemp(prefix="engramory-ci-")).resolve()
        try:
            fn(d)
            print(f"  PASS  {fn.__name__}")
        except AssertionError as ex:
            failed += 1
            print(f"  FAIL  {fn.__name__}: {ex}")
        except Exception as ex:  # noqa
            failed += 1
            print(f"  ERROR {fn.__name__}: {type(ex).__name__}: {ex}")
        finally:
            shutil.rmtree(d, ignore_errors=True)
    print("\n" + ("ALL PASS" if failed == 0 else f"{failed} FAILED"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_main())
