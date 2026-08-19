"""P0 tests for Codex hook installation and upgrade safety."""

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
INIT = REPO / "tools" / "engramory_init.py"
def _run_init(project, *extra):
    proc = subprocess.run(
        [
            sys.executable,
            str(INIT),
            "codex",
            "--project-root",
            str(project),
            *map(str, extra),
        ],
        capture_output=True,
        text=True,
    )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def _managed_count(config, event):
    return sum(
        str(handler.get("statusMessage", "")).startswith("Engramory:")
        and str(handler.get("statusMessage", "")).endswith("(managed v1)")
        for group in config["hooks"].get(event, [])
        for handler in group.get("hooks", [])
    )


def test_init_installs_three_codex_hooks_and_managed_scripts(tmp_path):
    project = tmp_path / "project"
    rc, out = _run_init(
        project,
        "--install-skill",
        "--install-hooks",
        "--mode",
        "explicit",
    )

    assert rc == 0, out
    managed = project / ".codex" / "engramory"
    assert (managed / "engramory_codex_hook.py").is_file()
    assert (managed / "engramory_sync.py").is_file()

    config = json.loads((project / ".codex" / "hooks.json").read_text(encoding="utf-8"))
    for event in ("SessionStart", "UserPromptSubmit", "PreCompact"):
        assert _managed_count(config, event) == 1
    precompact = config["hooks"]["PreCompact"][-1]
    assert "matcher" not in precompact
    command = precompact["hooks"][0]["command"]
    assert "--memory-root" in command and "--sync-tool" in command
    assert "--mode explicit" in command
    if os.name == "nt":
        assert "commandWindows" in precompact["hooks"][0]

    agents = (project / "AGENTS.md").read_text(encoding="utf-8")
    assert "Capture mode is `explicit`" in agents
    assert "/hooks" in agents and "trust" in agents.lower()
    assert "Automatic compaction" in agents


def test_init_hook_merge_is_idempotent_and_preserves_unrelated_handlers(tmp_path):
    project = tmp_path / "project"
    hooks_path = project / ".codex" / "hooks.json"
    hooks_path.parent.mkdir(parents=True)
    unrelated = {
        "type": "command",
        "command": "python audit_wrapper.py --target engramory_codex_hook.py",
        "statusMessage": "keep me",
    }
    hooks_path.write_text(
        json.dumps(
            {
                "description": "user description",
                "hooks": {
                    "SessionStart": [
                        {"matcher": "startup", "hooks": [unrelated]}
                    ]
                },
            }
        ),
        encoding="utf-8",
    )

    rc1, out1 = _run_init(project, "--install-hooks")
    rc2, out2 = _run_init(project, "--install-hooks")
    assert rc1 == 0, out1
    assert rc2 == 0, out2

    config = json.loads(hooks_path.read_text(encoding="utf-8"))
    assert config["description"] == "user description"
    commands = [
        handler.get("command")
        for group in config["hooks"]["SessionStart"]
        for handler in group["hooks"]
    ]
    assert "python audit_wrapper.py --target engramory_codex_hook.py" in commands
    for event in ("SessionStart", "UserPromptSubmit", "PreCompact"):
        assert _managed_count(config, event) == 1


def test_generated_hook_command_survives_unicode_and_shell_metacharacter_paths(
        tmp_path):
    project = tmp_path / "project_日本語😀 & %ENGRAMORY_META% 'quoted'"
    rc, out = _run_init(project, "--install-hooks")
    assert rc == 0, out

    config = json.loads(
        (project / ".codex" / "hooks.json").read_text(encoding="utf-8"))
    handler = config["hooks"]["SessionStart"][-1]["hooks"][0]
    argv = shlex.split(handler["command"])
    assert argv[1] == str(
        (project / ".codex" / "engramory" / "engramory_codex_hook.py").resolve())
    assert argv[argv.index("--memory-root") + 1] == str(
        (project / ".engramory-memory").resolve())

    event = {
        "session_id": "shell-smoke",
        "cwd": str(project),
        "hook_event_name": "SessionStart",
        "source": "startup",
        "model": "gpt-test",
    }
    event_bytes = json.dumps(event, ensure_ascii=False).encode("utf-8")
    env = dict(os.environ)
    env["ENGRAMORY_META"] = "THIS_MUST_NOT_EXPAND"
    # Prove that the generated bridge establishes UTF-8 itself instead of
    # accidentally inheriting a friendly parent Python configuration.
    env["PYTHONUTF8"] = "0"
    env["PYTHONIOENCODING"] = "gbk"
    if os.name == "nt":
        command = handler["commandWindows"]
        assert command.startswith("powershell.exe ")
        assert str(project) not in command  # dynamic values are inside base64
        process = subprocess.run(
            ["cmd.exe", "/D", "/S", "/C", command],
            input=event_bytes,
            capture_output=True,
            cwd=str(project),
            env=env,
            timeout=20,
        )
    else:
        process = subprocess.run(
            ["/bin/sh", "-lc", handler["command"]],
            input=event_bytes,
            capture_output=True,
            cwd=str(project),
            env=env,
            timeout=20,
        )
    stdout = process.stdout.decode("utf-8", errors="strict")
    stderr = process.stderr.decode("utf-8", errors="strict")
    assert process.returncode == 0, stdout + stderr
    output = json.loads(stdout.strip())
    assert output["hookSpecificOutput"]["hookEventName"] == "SessionStart"
    assert str(project / ".engramory-memory" / "MEMORY.md") in (
        output["hookSpecificOutput"]["additionalContext"])


def test_init_malformed_hooks_fails_before_any_side_effect(tmp_path):
    project = tmp_path / "project"
    hooks_path = project / ".codex" / "hooks.json"
    hooks_path.parent.mkdir(parents=True)
    hooks_path.write_text("{broken", encoding="utf-8")

    rc, out = _run_init(project, "--install-hooks")

    assert rc != 0 and "not valid JSON" in out
    assert hooks_path.read_text(encoding="utf-8") == "{broken"
    assert not (project / ".engramory-memory").exists()
    assert not (project / ".gitignore").exists()
    assert not (project / "AGENTS.md").exists()
    assert not (project / ".codex" / "engramory").exists()


def test_init_structurally_invalid_managed_event_fails_before_side_effect(tmp_path):
    project = tmp_path / "project"
    hooks_path = project / ".codex" / "hooks.json"
    hooks_path.parent.mkdir(parents=True)
    hooks_path.write_text(
        json.dumps({"hooks": {"PreCompact": {"not": "an array"}}}),
        encoding="utf-8",
    )

    rc, out = _run_init(project, "--install-hooks")

    assert rc != 0 and "hooks.PreCompact" in out
    assert not (project / ".engramory-memory").exists()
    assert not (project / "AGENTS.md").exists()
    assert not (project / ".codex" / "engramory").exists()


def test_init_hooks_preserve_v051_store_byte_for_byte(tmp_path):
    project = tmp_path / "project"
    store = project / ".engramory-memory"
    store.mkdir(parents=True)
    index_bytes = b"# Existing index\n- [P](project_existing.md) - precious\n"
    note_bytes = b"precious v0.5.1 note\n"
    (store / "MEMORY.md").write_bytes(index_bytes)
    (store / "project_existing.md").write_bytes(note_bytes)

    rc, out = _run_init(
        project,
        "--install-hooks",
        "--install-skill",
        "--mode",
        "assisted",
    )

    assert rc == 0, out
    assert (store / "MEMORY.md").read_bytes() == index_bytes
    assert (store / "project_existing.md").read_bytes() == note_bytes
    agents = (project / "AGENTS.md").read_text(encoding="utf-8")
    assert "Capture mode is `assisted`" in agents


def test_init_does_not_overwrite_modified_managed_script_without_force(tmp_path):
    project = tmp_path / "project"
    rc, out = _run_init(project, "--install-hooks")
    assert rc == 0, out
    hook = project / ".codex" / "engramory" / "engramory_codex_hook.py"
    hook.write_text("# local customization\n", encoding="utf-8")

    rc2, out2 = _run_init(project, "--install-hooks")
    assert rc2 == 0, out2
    assert hook.read_text(encoding="utf-8") == "# local customization\n"
    assert "kept existing (use --force to replace)" in out2

    rc3, out3 = _run_init(project, "--install-hooks", "--force")
    assert rc3 == 0, out3
    assert hook.read_text(encoding="utf-8") != "# local customization\n"


def test_init_refuses_managed_script_symlink_before_side_effect(tmp_path):
    project = tmp_path / "project"
    store = project / ".engramory-memory"
    store.mkdir(parents=True)
    index = store / "MEMORY.md"
    original = b"# precious memory index\n"
    index.write_bytes(original)
    managed = project / ".codex" / "engramory" / "engramory_sync.py"
    managed.parent.mkdir(parents=True)
    try:
        os.symlink(str(index), str(managed))
    except (OSError, NotImplementedError, AttributeError):
        return

    rc, out = _run_init(project, "--install-hooks", "--force")

    assert rc != 0 and "symlink" in out.lower()
    assert index.read_bytes() == original
    assert managed.is_symlink()
    assert not (project / "AGENTS.md").exists()
    assert not (project / ".gitignore").exists()


def test_force_atomically_replaces_managed_hardlink_without_touching_memory(tmp_path):
    project = tmp_path / "project"
    store = project / ".engramory-memory"
    store.mkdir(parents=True)
    index = store / "MEMORY.md"
    original = b"# precious hardlinked memory index\n"
    index.write_bytes(original)
    managed = project / ".codex" / "engramory" / "engramory_sync.py"
    managed.parent.mkdir(parents=True)
    try:
        os.link(str(index), str(managed))
    except (OSError, NotImplementedError, AttributeError):
        return

    rc, out = _run_init(project, "--install-hooks", "--force")

    assert rc == 0, out
    assert index.read_bytes() == original
    assert managed.read_bytes() == (
        REPO / "tools" / "engramory_sync.py").read_bytes()
    assert not os.path.samefile(str(index), str(managed))


def test_init_refuses_symlinked_hooks_json_without_touching_memory(tmp_path):
    project = tmp_path / "project"
    store = project / ".engramory-memory"
    store.mkdir(parents=True)
    index = store / "MEMORY.md"
    original = b"# precious index, not hook JSON\n"
    index.write_bytes(original)
    hooks_path = project / ".codex" / "hooks.json"
    hooks_path.parent.mkdir(parents=True)
    try:
        os.symlink(str(index), str(hooks_path))
    except (OSError, NotImplementedError, AttributeError):
        return

    rc, out = _run_init(project, "--install-hooks", "--force")

    assert rc != 0 and "symlink" in out.lower()
    assert index.read_bytes() == original
    assert hooks_path.is_symlink()
    assert not (project / "AGENTS.md").exists()


def test_init_rejects_codex_hook_dir_overlapping_memory_store(tmp_path):
    project = tmp_path / "project"
    rc, out = _run_init(
        project,
        "--memory-root",
        ".codex",
        "--install-hooks",
    )
    assert rc != 0 and "overlaps" in out
    assert not project.exists()


def test_non_codex_host_rejects_hook_install_and_assisted_mode(tmp_path):
    project = tmp_path / "project"
    base = [sys.executable, str(INIT), "openclaw", "--project-root", str(project)]
    hooks = subprocess.run(
        [*base, "--install-hooks"], capture_output=True, text=True)
    assisted = subprocess.run(
        [*base, "--mode", "assisted"], capture_output=True, text=True)

    assert hooks.returncode != 0
    assert "--install-hooks is supported only" in (hooks.stdout + hooks.stderr)
    assert assisted.returncode != 0
    assert "--mode assisted is supported only" in (
        assisted.stdout + assisted.stderr)
    assert not project.exists()


def test_generated_hooks_json_is_gitignored_only_when_engramory_owns_it(tmp_path):
    """The file is machine-local, but it is also a shared Codex surface.

    Codex 0.144.1 has no project-dir variable for hook commands, so every
    generated path is absolute and machine-local — worth gitignoring. But
    `.codex/hooks.json` legitimately holds a team's own handlers too, and
    ignoring a shared config would silently drop it from version control.
    """
    project = tmp_path / "solo"
    rc, out = _run_init(project, "--install-hooks")
    assert rc == 0, out
    assert "/.codex/hooks.json" in (project / ".gitignore").read_text(encoding="utf-8")

    shared = tmp_path / "shared"
    (shared / ".codex").mkdir(parents=True)
    (shared / ".codex" / "hooks.json").write_text(
        json.dumps(
            {
                "hooks": {
                    "Stop": [
                        {
                            "hooks": [
                                {
                                    "type": "command",
                                    "command": "echo teammate",
                                    "statusMessage": "team lint hook",
                                }
                            ]
                        }
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    rc, out = _run_init(shared, "--install-hooks")
    assert rc == 0, out
    gitignore = shared / ".gitignore"
    ignored = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    assert "/.codex/hooks.json" not in ignored
    config = json.loads((shared / ".codex" / "hooks.json").read_text(encoding="utf-8"))
    assert "Stop" in config["hooks"]


def test_hook_python_overrides_the_baked_in_interpreter(tmp_path):
    """Default bakes in whatever ran the installer — often a throwaway venv."""
    project = tmp_path / "project"
    rc, out = _run_init(
        project, "--install-hooks", "--hook-python", "C:/custom/python.exe"
    )
    assert rc == 0, out
    assert "C:/custom/python.exe" in out
    config = json.loads(
        (project / ".codex" / "hooks.json").read_text(encoding="utf-8")
    )
    command = config["hooks"]["SessionStart"][0]["hooks"][0]["command"]
    assert "C:/custom/python.exe" in command


def test_install_output_states_hooks_are_inactive_until_trusted(tmp_path):
    """Installing is not enabling: Codex disables project hooks until trusted."""
    project = tmp_path / "project"
    rc, out = _run_init(project, "--install-hooks")
    assert rc == 0, out
    assert "/hooks" in out
    assert "NOT active" in out


# --- direct runner (no pytest) ---
# CI runs the suites as plain zero-dependency scripts; without this block the file
# exits 0 silently having run NOTHING (that near-miss shipped: the suite existed
# for two releases while CI never executed a single test in it).

def test_reinstalling_is_byte_identical(tmp_path):
    """A second init must not change the rules file at all.

    The block-replacement path appended a blank-line separator even when the block
    ended the file, so the first re-run added one blank line that every later run then
    preserved - a one-line diff appearing out of nowhere in a file people keep in git.
    """
    import subprocess
    import sys as _sys

    rules = tmp_path / "AGENTS.md"
    rules.write_text("# Mine\n\nKeep this.\n", encoding="utf-8")

    def run():
        proc = subprocess.run(
            [_sys.executable, str(INIT), "codex", "--project-root", str(tmp_path)],
            capture_output=True, text=True)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        return rules.read_bytes()

    first = run()
    assert run() == first, "a second init changed the rules file"
    assert run() == first, "a third init changed the rules file"
    assert b"Keep this." in first


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
