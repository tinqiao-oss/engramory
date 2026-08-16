"""Run the dsh plugin's own node:test suite from pytest — or as a plain script.

The plugin is JavaScript, so nothing else in this suite would exercise it — and its
guard is the one place where Engramory's index cap is a hard refusal rather than a
request. CI runs the suites as zero-dependency scripts, so pytest is optional here:
importing it unconditionally kept this file OUT of CI entirely, which made the
"pinned by node --test in CI" claim in the dsh READMEs false.
"""
import os
import shutil
import subprocess
import sys

try:
    import pytest
except ImportError:  # script mode (CI) runs with zero dependencies
    pytest = None

PLUGIN = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "adapters", "dsh", "plugin")
)


_SCRIPT_MODE = False  # set by _main(); pytest.skip() raises a BaseException the
# script runner would misread as a crash, so script mode prints instead.


def _skip(reason):
    if pytest is not None and not _SCRIPT_MODE:
        pytest.skip(reason)
    print(f"  skip: {reason}")


def test_dsh_plugin_guard_suite_passes():
    node = shutil.which("node")
    if node is None:
        return _skip("node is not installed")
    proc = subprocess.run(
        [node, "--test"],
        cwd=PLUGIN,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert proc.returncode == 0, (proc.stdout + proc.stderr)[-4000:]


def test_dsh_plugin_declares_the_discovery_keyword():
    """`dsh-plugin` is how the community directories find a plugin at all.

    Losing it does not break a single test elsewhere, and the package would simply
    stop appearing in the listings people actually browse.
    """
    import json

    with open(os.path.join(PLUGIN, "package.json"), encoding="utf-8") as fh:
        pkg = json.load(fh)
    assert "dsh-plugin" in pkg["keywords"]
    assert pkg["name"] == "dsh-engramory"
    # The published tarball must carry the code and nothing stray.
    assert set(pkg["files"]) == {"index.js", "cordis.patch.yml", "README.md", "LICENSE"}


def test_root_discovery_manifest_stays_in_step_with_the_plugin():
    """The repo-root package.json exists ONLY so registry crawlers that check the
    ROOT for a `dsh.bundle` (plugin.dshdesk.com and friends) can verify the repo.

    It duplicates the plugin's identity on purpose, which makes it a drift point —
    so name, version, and the bundle patch are pinned here: bump the plugin
    without the root manifest (or vice versa) and this fails.
    """
    import json

    root_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
    with open(os.path.join(root_dir, "package.json"), encoding="utf-8") as fh:
        root = json.load(fh)
    with open(os.path.join(PLUGIN, "package.json"), encoding="utf-8") as fh:
        plugin = json.load(fh)
    assert root["private"] is True, "the root manifest must never be publishable"
    assert root["name"] == plugin["name"]
    assert root["version"] == plugin["version"]
    patch = root["dsh"]["bundle"]["patch"]
    assert os.path.isfile(os.path.join(root_dir, patch)), patch
    # Same patch FILE the plugin itself ships, not a diverging copy.
    assert os.path.normpath(os.path.join(root_dir, patch)) == os.path.normpath(
        os.path.join(PLUGIN, plugin["dsh"]["bundle"]["patch"]))


def test_dsh_plugin_ships_a_bundle_manifest():
    """Without `dsh.bundle.patch`, dsh has no idea how to mount an installed plugin.

    Every real plugin in the ecosystem declares it (checked against dsh-mnemon and
    dsh-memory). Ours shipped 0.1.0 without one — installable, and then inert until the
    user hand-edited their profile. The manifest and the file it points at must travel
    together, so both are asserted here.
    """
    import json

    with open(os.path.join(PLUGIN, "package.json"), encoding="utf-8") as fh:
        pkg = json.load(fh)
    patch = pkg["dsh"]["bundle"]["patch"]
    assert patch == "./cordis.patch.yml"
    assert patch.lstrip("./") in pkg["files"]
    assert os.path.isfile(os.path.join(PLUGIN, patch.lstrip("./")))


# --- direct runner (no pytest) ---

def _main():
    global _SCRIPT_MODE
    _SCRIPT_MODE = True
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    print(f"plugin: {PLUGIN}\nrunning {len(tests)} tests\n")
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
        except AssertionError as ex:
            failed += 1
            print(f"  FAIL  {fn.__name__}: {ex}")
        except Exception as ex:  # noqa
            failed += 1
            print(f"  ERROR {fn.__name__}: {type(ex).__name__}: {ex}")
    print("\n" + ("ALL PASS" if failed == 0 else f"{failed} FAILED"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_main())
