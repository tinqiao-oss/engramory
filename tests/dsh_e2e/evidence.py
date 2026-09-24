"""What a compatibility claim is checked against — shared by run.py and test_dsh_plugin.py.

Kept apart from run.py so the unit test can import it without pulling in the harness,
and so the two cannot drift: the digest the harness records and the digest the test
recomputes come from the same function.
"""
import hashlib
import json
import os
import re

# semver.org's reference pattern. Use with fullmatch: `match` + `$` lets a trailing
# newline through. re.ASCII: Python's `\d` otherwise accepts any Unicode digit.
SEMVER = re.compile(
    r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?", re.ASCII)

RUNTIME_FILES = ("index.js", "cordis.patch.yml")
LOADING_FIELDS = ("type", "main", "exports")


def runtime_digest(plugin_dir):
    """Hash what dsh actually loads from the plugin.

    That is the code, the bundle patch, and the package.json fields that decide how
    the code is loaded — and nothing else from package.json on purpose: the
    compatibility declaration lives there, and hashing it would make every
    declaration invalidate the very evidence it is declared from. Line endings are
    normalised so a Windows checkout (autocrlf) and a Linux one agree.
    """
    h = hashlib.sha256()
    for name in RUNTIME_FILES:
        with open(os.path.join(plugin_dir, name), "rb") as f:
            data = f.read().replace(b"\r\n", b"\n")
        h.update(name.encode("utf-8") + b"\0" + data + b"\0")
    with open(os.path.join(plugin_dir, "package.json"), encoding="utf-8") as f:
        pkg = json.load(f)
    loading = {k: pkg.get(k) for k in LOADING_FIELDS}
    loading["dsh.bundle"] = (pkg.get("dsh") or {}).get("bundle")
    h.update(json.dumps(loading, sort_keys=True).encode("utf-8"))
    return "sha256:" + h.hexdigest()


def load_runs(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("runs", [])
    except (OSError, ValueError):
        return []
