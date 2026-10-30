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
    # The published tarball must carry the code and nothing stray: the host half, the
    # browser half (the settings page), the display metadata and icon the Plugins page
    # reads without activating the plugin, and the docs.
    assert set(pkg["files"]) == {"index.js", "client.js", "cordis.patch.yml", "locale/*.json",
                                 "icon.svg", "README.md", "LICENSE"}
    assert pkg["exports"]["./client"] == "./client.js"
    assert pkg["dsh"]["client"]["platform"] == "web"
    for lang in ("en", "zh"):
        with open(os.path.join(PLUGIN, "locale", f"{lang}.json"), encoding="utf-8") as fh:
            meta = json.load(fh)["meta"]
        assert meta["title"] and meta["description"], lang


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
    assert root["author"] == plugin["author"]


def test_storefront_screenshots_resolve_inside_the_plugin():
    """Storefronts (awesome-dsh-plugin, dsh-market) read screenshots.json next to the
    plugin's package.json: 1-8 paths relative to it that may not leave the plugin
    directory. A renamed image would 404 on every storefront without failing anything
    here, so each path must exist. The images stay out of the npm package."""
    import fnmatch
    import json

    with open(os.path.join(PLUGIN, "screenshots.json"), encoding="utf-8") as fh:
        shots = json.load(fh)
    with open(os.path.join(PLUGIN, "package.json"), encoding="utf-8") as fh:
        shipped = json.load(fh)["files"]
    plugin_real = os.path.realpath(PLUGIN)
    assert 1 <= len(shots) <= 8
    for path in shots:
        assert "\\" not in path and ":" not in path and not path.startswith("/"), path
        assert ".." not in path.split("/"), path
        real = os.path.realpath(os.path.join(PLUGIN, path))
        assert os.path.commonpath([real, plugin_real]) == plugin_real, path
        assert os.path.isfile(real), path
        assert not any(fnmatch.fnmatch(path, f) or path.startswith(f.rstrip("/") + "/")
                       for f in shipped), path


def test_dev_scripts_in_the_plugin_dir_are_named_as_tests():
    """dsh-xray (a scanner the directories link to) tells test code from shipped code
    by name: `*.test.js` or a `tests/` directory. A file plainly called `test.js` read
    as shipped code, and its child_process import rated the plugin "executes system
    commands" (C3) although npm never ships it. Anything here npm does not ship must
    carry a test-shaped name."""
    import fnmatch
    import json

    with open(os.path.join(PLUGIN, "package.json"), encoding="utf-8") as fh:
        shipped = json.load(fh)["files"]
    for name in os.listdir(PLUGIN):
        if not name.endswith((".js", ".mjs", ".cjs")):
            continue
        if any(fnmatch.fnmatch(name, f) for f in shipped):
            continue
        assert name.endswith((".test.js", ".test.mjs", ".test.cjs")), name


def test_one_version_number_for_the_repo_and_the_plugin():
    """From 1.0.0 the repo and the plugin are one release under one number.

    Two numbers drifted apart before: the root manifest showed the plugin's version
    while the README showed the repo's, and a plugin bump (0.2.4) never reached npm.
    The plugin's package.json is the number npm gets; the root manifest, the newest
    CHANGELOG heading and both root READMEs' status lines must say the same, so a release
    cannot bump one and forget the rest.
    """
    import json
    import re

    root_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))

    def read(name):
        with open(os.path.join(root_dir, name), encoding="utf-8") as fh:
            return fh.read()

    def first(pattern, text):
        m = re.search(pattern, text, re.M)
        return m.group(1) if m else None

    with open(os.path.join(PLUGIN, "package.json"), encoding="utf-8") as fh:
        version = json.load(fh)["version"]
    # each captures the whole version token, so `1.0.0-rc.1` is not read as `1.0.0`;
    # the CHANGELOG's is its first section heading, whatever its form, never a later one
    found = {
        "package.json (root)": json.loads(read("package.json"))["version"],
        "CHANGELOG.md": first(r"^## (\S+)", read("CHANGELOG.md")),
        "README.md": first(r"\*\*状态[:：]\s*(\S+?)。\*\*", read("README.md")),
        "README.en.md": first(r"\*\*Status: (\S+?)\.\*\*", read("README.en.md")),
    }
    wrong = {k: v for k, v in found.items() if v != version}
    assert not wrong, "not %s, the plugin's version: %s" % (version, wrong)


def test_the_translated_readme_documents_the_same_config_fields():
    """A second README is a drift point; the config table is the part users act on.

    The plugin's directory README is what the community directories render (their
    entry points at `adapters/dsh/plugin`, and they look for a translation only in
    that same directory), so both languages live here: README.md in Chinese, for the
    plugin's main readership, and README.en.md in English. Adding a config field to
    one table and not the other would leave half the readership with documentation
    that silently omits it.

    Only the field NAMES are compared - prose is expected to differ, that is the
    point of a translation.
    """
    import re

    def fields(name):
        text = open(os.path.join(PLUGIN, name), encoding="utf-8").read()
        # rows look like: | `indexName` | `MEMORY.md` | ... |
        return {m.group(1) for m in re.finditer(r"^\|\s*`([A-Za-z]+)`\s*\|", text, re.M)}

    zh = fields("README.md")
    en = fields("README.en.md")
    assert zh, "no config rows found in README.md - did the table format change?"
    assert en == zh, (
        "the two READMEs document different config fields.\n"
        "  only in README.en.md:  %s\n"
        "  only in README.md:     %s" % (sorted(en - zh), sorted(zh - en)))


def test_the_translated_readme_is_actually_translated():
    """Each README must be sniffed as the language its name promises.

    The community directory sniffs language by CJK ratio (>3% = Chinese) rather than
    trusting the filename. README.md is the main page and must read as Chinese, so the
    probe goes on to look for the English sibling (README.en.md), which must stay
    below the threshold: either one sniffed wrong lists the plugin in one language only.
    """
    import re

    def cjk_ratio(name):
        text = open(os.path.join(PLUGIN, name), encoding="utf-8").read()
        return len(re.findall(r"[\u4e00-\u9fff]", text)) / max(len(text), 1)

    zh_ratio = cjk_ratio("README.md")
    assert zh_ratio > 0.03, f"README.md CJK ratio {zh_ratio:.3f} would be sniffed as English"
    en_ratio = cjk_ratio("README.en.md")
    assert en_ratio <= 0.03, (
        f"README.en.md CJK ratio {en_ratio:.3f} is over the sniff threshold - the "
        f"English page would be listed as Chinese")


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


def test_dsh_plugin_depends_on_nothing_but_node():
    """The plugin imports only `node:` builtins, so it declares no dependencies at all.

    Up to 0.2.4 it declared a peer on `@deepseek-ai/dsh-tools` (`>=0.0.1-rc.1`). It
    never did anything: nothing imports that package, and a dsh profile never carries
    it as a direct dependency, so pnpm printed an unmet-peer warning on every
    `dsh plugin add`. The dsh range the directories display now lives in
    `dsh.compatibility.dsh` (DSH-Store reads that before falling back to peers), so
    re-adding the peer "for discoverability" buys nothing but the warning back.
    """
    import json
    import re

    with open(os.path.join(PLUGIN, "package.json"), encoding="utf-8") as fh:
        pkg = json.load(fh)
    # devDependencies stay allowed: they never reach an installing user.
    for field in ("dependencies", "optionalDependencies", "peerDependencies",
                  "peerDependenciesMeta", "bundleDependencies", "bundledDependencies"):
        assert field not in pkg, "package.json declares %s" % field
    with open(os.path.join(PLUGIN, "index.js"), encoding="utf-8") as fh:
        src = fh.read()
    static = re.findall(r"^\s*import\s+(?:[^'\";]+?\s+from\s+)?['\"]([^'\"]+)['\"]", src, re.M)
    assert static, "no import statements found - did the module format change?"
    specs = static + re.findall(r"^\s*export\s+[^'\";]*?\s+from\s+['\"]([^'\"]+)['\"]", src, re.M)
    specs += re.findall(r"\b(?:import|require)\s*\(\s*['\"]([^'\"]+)['\"]", src)
    assert all(s.startswith("node:") for s in specs), specs
    assert not re.search(r"\b(?:import|require)\s*\(\s*[^'\"\s)]", src), (
        "a dynamic import/require with a computed specifier cannot be checked")
    # The browser half takes React from the page's module table and nothing else: dsh's
    # own client packages change without notice, and a plain script has no type check.
    with open(os.path.join(PLUGIN, "client.js"), encoding="utf-8") as fh:
        client = fh.read()
    assert set(re.findall(r"\brequire\s*\(\s*['\"]([^'\"]+)['\"]", client)) == {"react"}
    assert not re.search(r"\brequire\s*\(\s*[^'\"\s)]", client)
    assert not re.search(r"^\s*(?:import|export)\b", client, re.M), "client.js is a plain script"


def test_declared_dsh_compatibility_is_backed_by_a_recorded_run():
    """Every dsh release declared `compatible` has a passing end-to-end run on record
    for THIS plugin version.

    DSH-Store reads `dsh.compatibility.dshReleases` from this package.json and keeps
    the plugin listed only while one of dsh's newest releases is declared compatible;
    exact per-release records are the only evidence it accepts. The failure pinned
    here is the one that got the plugin delisted: "installs and activates on current
    dsh builds" was true the day it was written (rc.7) and then never re-checked while
    dsh shipped a dozen releases and changed its model wire format. The record comes
    from `tests/dsh_e2e/run.py --record`, and it is tied to the code as well as the
    version: a run counts only if its runtime digest (index.js, the bundle patch, and
    the package.json fields that decide loading) matches the tree. Change the code or
    bump the version and every declaration needs a fresh run, or goes back to
    `unknown`. At least one release must stay declared: an empty map is the delisted
    state, and "installs and activates" with nothing verified is not a claim to ship.
    """
    import json

    e2e = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dsh_e2e")
    sys.path.insert(0, e2e)
    try:
        from evidence import SEMVER, load_runs, runtime_digest
    finally:
        sys.path.remove(e2e)

    with open(os.path.join(PLUGIN, "package.json"), encoding="utf-8") as fh:
        pkg = json.load(fh)
    compat = pkg["dsh"].get("compatibility") or {}
    assert isinstance(compat.get("dsh"), str) and compat["dsh"].strip(), (
        "dsh.compatibility.dsh (the range directories display) is missing")
    releases = compat.get("dshReleases")
    assert isinstance(releases, dict), "dsh.compatibility.dshReleases is missing"
    for version, status in releases.items():
        assert SEMVER.fullmatch(version), "not a full SemVer: %r" % version
        assert status in ("compatible", "incompatible", "unknown"), (version, status)
    claimed = sorted(v for v, s in releases.items() if s == "compatible")
    assert claimed, (
        "no dsh release is declared compatible - run `python tests/dsh_e2e/run.py "
        "--record <dsh version>` and declare what passed")

    digest = runtime_digest(PLUGIN)
    mine = [r for r in load_runs(os.path.join(e2e, "results.json"))
            if r.get("plugin") == pkg["version"]]
    passed = {r.get("dsh") for r in mine if r.get("result") == "pass" and r.get("runtime") == digest}
    stale = {r.get("dsh") for r in mine if r.get("result") == "pass" and r.get("runtime") != digest}
    failed = {r.get("dsh") for r in mine if r.get("result") == "fail" and r.get("runtime") == digest}
    unbacked = [v for v in claimed if v not in passed]
    assert not unbacked, (
        "declared compatible without a passing run of plugin %s at this code on record: "
        "%s%s - run `python tests/dsh_e2e/run.py --record %s`, or declare them unknown"
        % (pkg["version"], ", ".join(unbacked),
           " (a run exists, but the plugin's code has changed since)"
           if set(unbacked) & stale else "", " ".join(unbacked)))
    contradicted = [v for v in claimed if v in failed]
    assert not contradicted, (
        "declared compatible but a recorded run of plugin %s failed: %s"
        % (pkg["version"], ", ".join(contradicted)))


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
