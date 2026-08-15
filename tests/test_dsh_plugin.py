"""Run the dsh plugin's own node:test suite from pytest.

The plugin is JavaScript, so nothing else in this suite would exercise it — and its
guard is the one place where Engramory's index cap is a hard refusal rather than a
request. Wiring it in here means CI cannot quietly stop checking it.
"""
import os
import shutil
import subprocess

import pytest

PLUGIN = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "adapters", "dsh", "plugin")
)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_dsh_plugin_guard_suite_passes():
    proc = subprocess.run(
        [shutil.which("node"), "--test"],
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
