"""End-to-end check of dsh-engramory against a real DeepSeek Harness. No API key.

The `node --test` suite pins the guard's decision table against a mock. It cannot tell
you whether a given dsh release still mounts the plugin, still names its file tools
`write`/`edit`, still routes them through `ctx.tools.guard()`, or still lists the
skill — and every one of those would fail silently: the plugin installs, nothing
errors, and the cap simply stops being enforced. This script checks them on the real
host, one dsh release at a time:

  1. installs `@deepseek-ai/dsh@<version>` into a throwaway npm prefix;
  2. adds the plugin to a `headless` profile under a throwaway $DSH_HOME with
     `dsh plugin --profile headless add`, the documented install;
  3. confirms the composed profile carries the `engramory` row;
  4. runs one headless task against fake_llm.py, whose script has the model
       write a 260-line MEMORY.md   -> refused by the guard, and no file appears,
       write a 3-line MEMORY.md     -> goes through, byte for byte,
       edit it up to 253 lines      -> refused by the guard, file unchanged,
     reading both what dsh reported to the model and the disk after every step;
  5. checks the skill was advertised and that every tool dsh offers is in
     REVIEWED_TOOLS (an unreviewed one could write files straight past the cap);
  6. removes the plugin and boots once more.

A failure of dsh's own setup (it would not install, the profile template changed, the
registry was unreachable) is recorded as `error`: it says nothing about the plugin. A
failed check after that is `fail`. dsh only ever runs against temp directories, and the
caller's own dsh home is fingerprinted before and after each release to catch a dsh
that ignores DSH_HOME (best effort: top-level entries and profile manifests).

    python tests/dsh_e2e/run.py 0.1.7-rc.1 0.1.5-rc.3              # the repo's plugin
    python tests/dsh_e2e/run.py --plugin dsh-engramory@0.2.5 0.1.7-rc.1
    python tests/dsh_e2e/run.py --record 0.1.7-rc.1                # also update results.json

Needs node, npm and pnpm on PATH (`dsh plugin` shells out to pnpm) and access to the
npm registry. Exits non-zero unless every release passed.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
PLUGIN_DIR = os.path.join(REPO, "adapters", "dsh", "plugin")
RESULTS = os.path.join(HERE, "results.json")
sys.path.insert(0, HERE)
from evidence import RUNTIME_FILES, SEMVER, load_runs, runtime_digest  # noqa: E402
from fake_llm import FakeLLM  # noqa: E402

PROFILE = "headless"
TASK = "Update my memory index."
DENIAL = "over the Engramory index cap"  # index.js verdict(): change both together
SKILL_MARK = "Curated file-based long-term memory"  # the registered skill's description

# Every tool dsh has offered in a passing run, and why it cannot put the index past the
# cap behind the guard's back. A tool missing from this table fails the run until
# someone places it — if it can write a file, index.js has to learn it first.
REVIEWED_TOOLS = {
    # measured by the guard (index.js WHOLE_FILE_WRITES / PARTIAL_WRITES)
    "write": "guarded", "edit": "guarded",
    # read-only
    "read": "read-only", "read_image": "read-only", "glob": "read-only",
    "grep": "read-only", "web_fetch": "read-only", "web_search": "read-only",
    "skill": "read-only",
    # shell and scripts: can write anything — the documented bypass (README, SECURITY.md)
    "pwsh": "shell", "bash": "shell", "workflow": "shell", "ralph": "shell",
    "job_kill": "shell", "job_list": "shell", "job_output": "shell",
    # other agents: their file writes go through these same guarded tools
    "subagent": "agents", "subagent_fork": "agents", "send_message": "agents",
    "interrupt_agent": "agents", "list_agents": "agents",
    # session state, not files
    "todo_write": "state", "create_goal": "state", "get_goal": "state",
    "update_goal": "state", "exit_plan_mode": "state",
}
# A reviewed non-writer whose schema grows both of these has changed nature.
PATH_ARGS = {"file_path", "path", "filePath", "filename", "file", "target_file", "target"}
BODY_ARGS = {"content", "contents", "new_string", "new_str", "file_text", "text", "patch",
             "diff", "edits", "data", "body", "input"}
NETWORK_TROUBLE = re.compile(
    r"ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ERR_PNPM_(?:META_)?FETCH|"
    r"ERR_SOCKET|socket hang up|request to \S+ failed")

BIG = "".join("- [note %d](note-%d.md) - hook %d\n" % (i, i, i) for i in range(260))
SMALL = "# Memory index\n- [a](a.md) - first\n- [b](b.md) - line-3\n"
GROW_FROM = "- [b](b.md) - line-3\n"
GROW_TO = GROW_FROM + "".join("- [n%d](n%d.md) - grown %d\n" % (i, i, i) for i in range(250))
UNSEEN = object()


def run(cmd, cwd, env, timeout=900):
    """Run to completion; on timeout (or Ctrl+C) kill the whole tree this call started.

    subprocess.run's timeout kills only the direct child — on Windows that is the
    cmd.exe behind npm.cmd — and then waits on pipes its node grandchild still holds,
    so in practice the timeout never fires.
    """
    kw = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
          else {"start_new_session": True})
    p = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         encoding="utf-8", errors="replace", **kw)
    try:
        out, err = p.communicate(timeout=timeout)
        return p.returncode, out, err
    except subprocess.TimeoutExpired:
        problem = _kill_tree(p)
        try:
            out, err = p.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            out, err = "", "(output lost: something still holds the pipes)"
        note = "tree killed" if problem is None else "could not kill the whole tree: " + problem
        return None, out or "", (err or "") + "\n[timed out after %ss; %s]" % (timeout, note)
    except BaseException:
        _kill_tree(p)
        raise


def _kill_tree(p):
    """Kill p and whatever it started — never anything this script did not start.

    Returns None, or why the tree may have survived (the direct child is then killed
    on its own, so at least our pipes close).
    """
    if os.name == "nt":
        r = subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)],
                           capture_output=True, text=True, errors="replace")
        if r.returncode != 0 and p.poll() is None:
            p.kill()
            return "taskkill exit %s: %s" % (r.returncode, " ".join((r.stdout + r.stderr).split())[:120])
        return None
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except OSError as ex:
        if p.poll() is None:
            p.kill()
        return "killpg: %s" % ex
    return None


def tail(text, n=300):
    text = " ".join((text or "").split())[-n:]
    return text.encode("ascii", "backslashreplace").decode("ascii")


def dsh_env(home, base_url):
    """Every dsh call gets a throwaway home and a model endpoint that is ours.

    Even the config commands get a local endpoint and a dummy key, so no run of this
    script can reach the real API with a real key from the caller's environment.
    """
    env = dict(os.environ)
    env["DSH_HOME"] = home
    env["DEEPSEEK_BASE_URL"] = base_url
    env["DEEPSEEK_API_KEY"] = "sk-engramory-e2e-not-a-key"
    for key in ("NO_PROXY", "no_proxy"):
        env[key] = (env[key] + ",127.0.0.1,localhost") if env.get(key) else "127.0.0.1,localhost"
    return env


def caller_home_stamp():
    """Stamps (mtime, size) of every top-level entry of the caller's own dsh home and of
    each profile's manifest. A dsh that ignored DSH_HOME would add or touch one of them.
    Best effort, not a full audit — and your own concurrent dsh use would trip it too."""
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    try:
        top = sorted(os.listdir(home))
    except OSError:
        return None
    try:
        profiles = sorted(os.listdir(os.path.join(home, "profiles")))
    except OSError:
        profiles = []
    stamp = {}
    for rel in top + [os.path.join("profiles", p, "package.json") for p in profiles]:
        try:
            st = os.stat(os.path.join(home, rel))
            stamp[rel] = (st.st_mtime_ns, st.st_size)
        except OSError:
            stamp[rel] = None
    return stamp


def profile_bundles(home):
    try:
        with open(os.path.join(home, "profiles", PROFILE, "package.json"), encoding="utf-8") as f:
            return [str(b) for b in json.load(f)["dsh"]["profile"]["bundles"]]
    except (OSError, ValueError, KeyError, TypeError):
        return []


def read_bytes(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


def tool_roster(body):
    """{tool name: set of argument names} from either wire format's tool list."""
    out = {}
    for t in body.get("tools") or []:
        if "function" in t:  # OpenAI chat completions
            fn = t["function"]
            out[str(fn.get("name"))] = set((fn.get("parameters") or {}).get("properties") or {})
        else:  # Anthropic Messages
            out[str(t.get("name"))] = set((t.get("input_schema") or {}).get("properties") or {})
    return out


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(_text(c.get("text", "")) if isinstance(c, dict) else _text(c) for c in content)
    return "" if content is None else str(content)


def tool_results(body):
    """[(tool call id, what dsh reported back to the model)] in order, either wire format.

    A list, not a dict: a duplicated id must be visible, not silently overwritten.
    """
    out = []
    for m in body.get("messages") or []:
        if m.get("role") == "tool":  # OpenAI chat completions
            out.append((m.get("tool_call_id"), _text(m.get("content"))))
        elif m.get("role") == "user" and isinstance(m.get("content"), list):  # Messages
            for b in m["content"]:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    out.append((b.get("tool_use_id"), _text(b.get("content"))))
    return out


def check_release(version, plugin, work, node, npm):
    """Run every check against one dsh release; returns (checks, facts)."""
    checks = []
    facts = {"installed": None, "runtime": plugin["digest"], "wire": None, "tools": None}

    def check(name, ok, detail="", infra=False):
        checks.append({"name": name, "ok": bool(ok), "detail": "" if ok else detail,
                       "infra": bool(infra) and not ok})
        return bool(ok)

    prefix, home, ws = (os.path.join(work, d) for d in ("prefix", "home", "ws"))
    index = os.path.join(ws, "mem", "MEMORY.md")
    for d in (prefix, home, os.path.dirname(index)):
        os.makedirs(d, exist_ok=True)

    code, out, err = run([npm, "install", "--prefix", prefix, "@deepseek-ai/dsh@" + version,
                          "--no-audit", "--no-fund"], cwd=work, env=dict(os.environ))
    if not check("install dsh", code == 0, tail(err or out), infra=True):
        return checks, facts
    pkg_dir = os.path.join(prefix, "node_modules", "@deepseek-ai", "dsh")
    try:
        with open(os.path.join(pkg_dir, "package.json"), encoding="utf-8") as f:
            meta = json.load(f)
        bin_field = meta.get("bin")
        rel = bin_field if isinstance(bin_field, str) else (bin_field or {}).get("dsh")
    except (OSError, ValueError, AttributeError):
        meta, rel = {}, None
    if not check("dsh version", meta.get("version") == version and rel,
                 "version %s, bin %s" % (meta.get("version"), rel), infra=True):
        return checks, facts
    dsh = [node, os.path.join(pkg_dir, rel)]

    quiet = dsh_env(home, "http://127.0.0.1:9")  # config commands: an endpoint nobody answers
    code, out, err = run(dsh + ["plugin", "--profile", PROFILE, "add", plugin["spec"]],
                         cwd=work, env=quiet, timeout=600)
    bundles = profile_bundles(home)
    trouble = code is None or bool(NETWORK_TROUBLE.search(out + err))
    if not check("plugin add", code == 0 and "dsh-engramory" in bundles,
                 tail(err or out) if code != 0 else "bundles: " + ", ".join(bundles),
                 infra=trouble):
        return checks, facts
    if not check("profile built from the headless template",
                 "@deepseek-ai/dsh-headless" in bundles, "bundles: " + ", ".join(bundles),
                 infra=True):
        return checks, facts
    installed_dir = os.path.join(home, "profiles", PROFILE, "node_modules", "dsh-engramory")
    try:
        with open(os.path.join(installed_dir, "package.json"), encoding="utf-8") as f:
            facts["installed"] = json.load(f).get("version")
        installed_digest = runtime_digest(installed_dir)
    except (OSError, ValueError):
        installed_digest = None
    check("installed plugin is the one under test",
          facts["installed"] == plugin["version"] and installed_digest == facts["runtime"],
          "installed %s (%s), expected %s (%s)" % (facts["installed"], installed_digest,
                                                  plugin["version"], facts["runtime"]))
    code, out, err = run(dsh + ["--profile", PROFILE, "--dump-config"], cwd=work, env=quiet)
    check("profile carries the engramory row", code == 0 and "id: engramory" in out,
          tail(err) if code != 0 else "")

    plan = [
        {"tool": "write", "args": {"file_path": index, "content": BIG}},
        {"tool": "write", "args": {"file_path": index, "content": SMALL}},
        {"tool": "edit", "args": {"file_path": index, "old_string": GROW_FROM, "new_string": GROW_TO}},
        {"text": "done"},
    ]
    seen = {}  # agent-loop request i -> the index file's bytes when it arrived

    def observe(i, body):
        seen[i] = read_bytes(index)

    with FakeLLM(plan, observe=observe) as fake:
        code, out, err = run(dsh + ["--profile", PROFILE, TASK], cwd=ws,
                             env=dsh_env(home, fake.base_url), timeout=300)
    facts["wire"] = ("anthropic-messages" if any(p.endswith("/messages") for p in fake.paths)
                     else "openai-chat-completions"
                     if any(p.endswith("/chat/completions") for p in fake.paths) else None)
    # A timeout stays a `fail`: a plugin that never lets dsh finish booting (issue #8)
    # looks exactly like this.
    if not check("headless task ran", code == 0 and len(fake.main) >= 4,
                 "exit %s, %d model turns: %s" % (code, len(fake.main), tail(err or out))):
        return checks, facts

    first = json.dumps(fake.main[0], ensure_ascii=False)
    check("the task reached the model", TASK in first)
    check("skill advertised to the model", "engramory" in first and SKILL_MARK in first)
    # Every turn's tool list, not just the first: a host may offer more tools mid-task.
    rosters = [tool_roster(body) for body in fake.main]
    roster = {}
    for r in rosters:
        for name, args in r.items():
            roster.setdefault(name, set()).update(args)
    facts["tools"] = sorted(roster)
    drifted = [r for r in rosters
               if not ({"file_path", "content"} <= r.get("write", set())
                       and {"file_path", "old_string", "new_string"} <= r.get("edit", set()))]
    check("write/edit keep the arguments the guard reads", not drifted,
          "write: %s; edit: %s" % (sorted(drifted[0].get("write", [])),
                                   sorted(drifted[0].get("edit", []))) if drifted else "")
    unreviewed = sorted(n for n in roster if n not in REVIEWED_TOOLS)
    check("every tool dsh offers has been reviewed", not unreviewed,
          "; ".join("%s(%s)" % (n, ", ".join(sorted(roster[n]))) for n in unreviewed))
    reshaped = sorted(n for n, args in roster.items()
                      if REVIEWED_TOOLS.get(n) not in (None, "guarded")
                      and args & PATH_ARGS and args & BODY_ARGS)
    check("no reviewed tool has grown a path and a body", not reshaped, ", ".join(reshaped))

    pairs = tool_results(fake.main[-1])
    results = dict(pairs)
    small = SMALL.encode("utf-8")
    got = lambda key: results.get(key, "<no result>")  # noqa: E731
    check("one tool result per step, matched by id",
          [i for i, _ in pairs] == ["step0", "step1", "step2"],
          "ids in order: %s" % [str(i) for i, _ in pairs])
    check("260-line write refused by the guard", DENIAL in got("step0"), tail(got("step0"), 160))
    check("refused write left no file behind", seen.get(1, UNSEEN) is None,
          "file existed when the next request came" if seen.get(1, UNSEEN) is not UNSEEN
          else "never observed")
    check("3-line write allowed", "step1" in results and DENIAL not in got("step1"),
          tail(got("step1"), 160))
    check("3-line write landed byte for byte", seen.get(2, UNSEEN) == small,
          ("%r" % (seen.get(2, UNSEEN),))[:80])
    check("edit past the cap refused by the guard", DENIAL in got("step2"), tail(got("step2"), 160))
    check("refused edit left the file unchanged", seen.get(3, UNSEEN) == small,
          ("%r" % (seen.get(3, UNSEEN),))[:80])
    check("nothing else wrote the index afterwards", read_bytes(index) == small)

    code, out, err = run(dsh + ["plugin", "--profile", PROFILE, "remove", "dsh-engramory"],
                         cwd=work, env=quiet, timeout=600)
    bundles = profile_bundles(home)
    check("plugin remove", code == 0 and "dsh-engramory" not in bundles,
          tail(err or out) if code != 0 else "bundles: " + ", ".join(bundles))
    code, out, err = run(dsh + ["--profile", PROFILE, "--dump-config"], cwd=work, env=quiet)
    check("row gone after remove", code == 0 and "id: engramory" not in out)
    with FakeLLM([]) as fake:
        code, out, err = run(dsh + ["--profile", PROFILE, "Say hello."], cwd=ws,
                             env=dsh_env(home, fake.base_url), timeout=300)
    check("boots and answers after remove", code == 0 and len(fake.main) >= 1, tail(err or out))
    return checks, facts


def remove_tree(path):
    """rmtree that survives Windows' 260-character path limit.

    npm writes node_modules through long-path-aware APIs, and dsh names its session
    directories after the full working-directory path, so a temp root of ordinary
    depth already produces paths plain rmtree cannot delete. The \\\\?\\ prefix lifts
    the limit for the Win32 calls rmtree makes.
    """
    target = "\\\\?\\" + os.path.abspath(path) if os.name == "nt" else path
    shutil.rmtree(target, ignore_errors=True)
    return not os.path.exists(path)


def resolve_plugin(spec, root, npm):
    """Pin down exactly what is under test before anything is installed."""
    if spec is None:
        code, out, err = run([npm, "pack", PLUGIN_DIR, "--pack-destination", root, "--json"],
                             cwd=root, env=dict(os.environ))
        if code != 0:
            sys.exit("npm pack failed: " + tail(err or out))
        info = json.loads(out[out.index("["):])[0]
        return {"spec": os.path.join(root, info["filename"]), "label": info["filename"],
                "version": info["version"], "integrity": info.get("integrity"),
                "source": "repo", "digest": runtime_digest(PLUGIN_DIR)}
    # A published version: fetch its tarball first, so the copy `dsh plugin add` installs
    # can be compared with what the registry actually serves, not with itself.
    code, out, err = run([npm, "pack", spec, "--pack-destination", root, "--json"],
                         cwd=root, env=dict(os.environ), timeout=300)
    if code != 0:
        sys.exit("npm pack %s failed: %s" % (spec, tail(err or out)))
    info = json.loads(out[out.index("["):])[0]
    published = os.path.join(root, "published")
    os.makedirs(published, exist_ok=True)
    try:
        with tarfile.open(os.path.join(root, info["filename"]), "r:gz") as tar:
            for name in RUNTIME_FILES + ("package.json",):  # never extractall: names untrusted
                with open(os.path.join(published, name), "wb") as f:
                    f.write(tar.extractfile("package/" + name).read())
    except (KeyError, OSError, tarfile.TarError, AttributeError) as ex:
        sys.exit("%s does not look like a dsh-engramory package: %s" % (spec, ex))
    return {"spec": "%s@%s" % (info["name"], info["version"]), "label": spec,
            "version": info["version"], "integrity": info.get("integrity"),
            "source": "npm", "digest": runtime_digest(published)}


def record(runs):
    kept = [r for r in load_runs(RESULTS)
            if not any((r.get("dsh"), r.get("plugin"), r.get("source"), r.get("platform"))
                       == (n["dsh"], n["plugin"], n["source"], n["platform"]) for n in runs)]
    data = {
        "about": ("Written by tests/dsh_e2e/run.py --record. A dsh release declared "
                  "\"compatible\" in adapters/dsh/plugin/package.json needs a passing run "
                  "here for the same plugin version AND the same runtime digest "
                  "(evidence.runtime_digest) - tests/test_dsh_plugin.py pins that."),
        "runs": sorted(kept + runs, key=lambda r: (str(r.get("plugin")), str(r.get("dsh")),
                                                   str(r.get("platform")), str(r.get("source")))),
    }
    with open(RESULTS, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("versions", nargs="+", metavar="DSH_VERSION",
                    help="exact @deepseek-ai/dsh versions, e.g. 0.1.7-rc.1")
    ap.add_argument("--plugin", help="install this published spec (e.g. dsh-engramory@0.2.5) "
                                     "instead of packing the repo's adapters/dsh/plugin")
    ap.add_argument("--record", action="store_true", help="write the outcome to results.json")
    ap.add_argument("--keep", action="store_true", help="leave the temp directories in place")
    args = ap.parse_args(argv)

    bad = [v for v in args.versions if not SEMVER.fullmatch(v)]
    if bad:
        sys.exit("not an exact dsh version (full SemVer expected): %s" % ", ".join(bad))
    node, npm, pnpm = shutil.which("node"), shutil.which("npm"), shutil.which("pnpm")
    missing = [n for n, p in (("node", node), ("npm", npm), ("pnpm", pnpm)) if p is None]
    if missing:
        sys.exit("missing on PATH: %s (dsh plugin shells out to pnpm: npm i -g pnpm)"
                 % ", ".join(missing))
    node_version = run([node, "--version"], cwd=REPO, env=dict(os.environ))[1].strip()
    before = caller_home_stamp()

    root = tempfile.mkdtemp(prefix="dsh-e2e-")
    runs = []
    try:
        plugin = resolve_plugin(args.plugin, root, npm)
        print("plugin: %s (%s)\nwork:   %s\n" % (plugin["label"], plugin["version"], root))
        for version in args.versions:
            work = os.path.join(root, "dsh-" + version)  # safe: version is a validated SemVer
            os.makedirs(work, exist_ok=True)
            print("== dsh %s" % version)
            try:
                checks, facts = check_release(version, plugin, work, node, npm)
            except Exception as ex:  # a harness crash is evidence of nothing
                checks = [{"name": "harness", "ok": False, "infra": True,
                           "detail": "%s: %s" % (type(ex).__name__, tail(str(ex)))}]
                facts = {"installed": None, "runtime": plugin["digest"], "wire": None, "tools": None}
            untouched = caller_home_stamp() == before
            if not untouched:
                checks.append({"name": "caller's dsh home untouched", "ok": False,
                               "infra": True, "detail": "stopping: this dsh ignored DSH_HOME"})
            failed = [c for c in checks if not c["ok"]]
            # Touching the caller's profiles is the harness breaking its own promise, not
            # a verdict on the plugin — whatever else failed before it.
            result = ("error" if not untouched else "pass" if not failed
                      else "error" if failed[0]["infra"] else "fail")
            for c in checks:
                print("  %s  %s%s" % ("PASS" if c["ok"] else "FAIL", c["name"],
                                      ("  (%s)" % c["detail"]) if c["detail"] else ""))
            note = ("  [%s]" % facts["wire"]) if facts.get("wire") else ""
            if result == "error":
                note = "  (dsh-side setup failed; says nothing about the plugin)"
            print("  -> %s%s\n" % (result if result == "pass" else result.upper(), note))
            runs.append({
                "dsh": version, "plugin": plugin["version"], "installed": facts.get("installed"),
                "source": plugin["source"], "integrity": plugin["integrity"],
                "runtime": facts.get("runtime"), "result": result,
                "failed": [c["name"] for c in failed],
                "checks": {c["name"]: c["ok"] for c in checks},
                "wire": facts.get("wire"), "tools": facts.get("tools"),
                "platform": sys.platform, "node": node_version,
                "date": datetime.date.today().isoformat(),
            })
            if not untouched:
                break
        if args.record and runs:
            record(runs)
            print("recorded %d run(s) in %s" % (len(runs), os.path.relpath(RESULTS, REPO)))
    finally:
        if args.keep:
            print("kept: %s" % root)
        elif not remove_tree(root):
            print("could not fully remove %s - delete it by hand" % root)
    passed = sum(r["result"] == "pass" for r in runs)
    print("%d of %d release(s) passed" % (passed, len(args.versions)))
    return 0 if passed == len(args.versions) else 1


if __name__ == "__main__":
    sys.exit(main())
