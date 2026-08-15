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
    assert set(pkg["files"]) == {"index.js", "README.md", "LICENSE"}
