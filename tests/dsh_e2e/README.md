# dsh end-to-end check

`node --test` pins the guard's decisions against a mock. It cannot tell whether a dsh
release still mounts the plugin, still names its file tools `write` / `edit` with the
arguments the guard reads, still routes them through `ctx.tools.guard()`, and still
lists the skill. Each of those fails **silently**: the plugin installs, nothing errors,
and the cap is gone. `run.py` checks them on the real host, with no API key.

```sh
python tests/dsh_e2e/run.py <dsh-version> [<another-version>]              # repo plugin (npm pack)
python tests/dsh_e2e/run.py --plugin dsh-engramory@<version> <dsh-version>   # published plugin
python tests/dsh_e2e/run.py --record <dsh-version>                          # update results.json
```

Needs `node`, `npm` and `pnpm` on PATH and the npm registry; each release needs a fresh
dsh install, so it is not in CI. dsh runs under a temp npm prefix and `$DSH_HOME`; your
own dsh home is fingerprinted before and after (top-level entries and profile manifests,
best effort) to catch a dsh that ignores `$DSH_HOME`
(npm and pnpm still use their usual caches). Every dsh call goes to a local endpoint
with a dummy key, so no run can reach the real API.

## What one run proves

Per release: install dsh → `dsh plugin --profile headless add <plugin>` → the installed
copy matches the version and runtime digest under test (for `--plugin`, the registry
tarball) → the composed profile (`--dump-config`) has the `engramory` row → one headless
task against [`fake_llm.py`](fake_llm.py), scripted as:

| step | tool call | dsh must report | the disk must show, before the next step |
|---|---|---|---|
| 1 | `write` a 260-line `MEMORY.md` | the guard's refusal | no file at all |
| 2 | `write` a 3-line `MEMORY.md` | success | exactly those 3 lines |
| 3 | `edit` it up to 253 lines | the guard's refusal | the same 3 lines |
| 4 | `write` the same 3 lines with CRLF to a second `MEMORY.md` | success | exactly those bytes |
| 5 | `edit` it with an LF `old_string` up to 253 lines | the guard's refusal | the same CRLF bytes |
| 6 | `working_directory` cd into the store (if offered) | the store's directory | the same 3 lines |
| 7 | `edit` a bare `MEMORY.md` up to 253 lines (if offered) | the guard's refusal | the same 3 lines |

Step 5 works because dsh's edit matches LF-normalised text and writes CRLF back; a guard
matching raw bytes would miss it. Steps 6–7 (only when dsh offers `working_directory`)
check that a bare `MEMORY.md` is resolved against the session's directory, as dsh does,
not the process's. The disk is read as each model request arrives, so a host that both
printed the refusal and wrote the file is caught; results match steps by tool-call id.

The same run checks that the task and the skill reached the model; that a project store
seeded in the session directory (`ws/.engramory-memory/MEMORY.md`) was injected into
the first request without being read; and that **every tool dsh offers is in
`REVIEWED_TOOLS`** (guarded writes, read-only/state operations, delegated agents,
documented shell bypasses). An unknown tool fails the run until reviewed, and a new
direct file writer needs guard support; a reviewed shell tool can still bypass the cap.
Last, `dsh plugin remove` must drop the row and leave a profile that boots and answers.

## `pass`, `fail`, `error`

**`error`**: dsh's own setup failed (would not install, `headless` template changed,
registry unreachable while adding the plugin, the harness crashed); it says nothing
about the plugin. Anything after that is **`fail`**, a timeout included: a plugin that
stops dsh from booting must not pass for infrastructure trouble. The exit status is
non-zero unless every release passed.

## The record, and what it is for

`--record` writes each outcome to [`results.json`](results.json), keyed by dsh release,
plugin version, source (`repo` = `npm pack` of this checkout, `npm` = published) and
platform, with the tarball integrity, the **runtime digest** ([`evidence.py`](evidence.py):
`index.js`, the bundle patch and the package.json fields that decide loading, line
endings normalised), every check's outcome, the wire format and the tool list.

`dsh.compatibility.dshReleases` in the plugin's
[`package.json`](../../adapters/dsh/plugin/package.json) is the authoritative map.
`tests/test_dsh_plugin.py` rejects a `compatible` without a passing run of the same
plugin version **and** runtime digest, a contradicting failure, or a map with no
compatible release. Declare only what passed.

`dsh.compatibility.dsh` is a display range for directories, not evidence. The plugin
deliberately declares no `engines.dsh` or `@deepseek-ai/dsh*` peer range, so an
untested future dsh is not refused outright. DSH-Store installs only on an exact
`compatible` record and reviews a rolling window (npm `latest` plus the two
undeprecated releases before it; see its
[registry README](https://github.com/AI-Scarlett/DSH-Store/blob/main/registry/README.md)).

## When to run it again

- **Before every plugin release**: a version bump or any change to what dsh loads voids
  the old record (the unit test says so).
- **When dsh ships**: re-run and declare what passed.
- **On another OS**: a pass on one platform says nothing about another (`pathKey`
  folds case only on Windows).

## Operational pitfalls

- `fake_llm.py` speaks Anthropic Messages (`POST {DEEPSEEK_BASE_URL}/v1/messages`) and
  OpenAI chat completions (`POST {base}/chat/completions`), answers 404 to anything
  else, and records which arrived.
- dsh also sends a session-title request with no tools; it must not consume a script
  step, or every later reply shifts by one.
- Windows: a timeout kills only the `cmd.exe` behind `npm.cmd`, so `run()` terminates
  the whole process tree; and `remove_tree()` uses the `\\?\` prefix for deep paths.
- npm 11 skips install scripts it has not been told to allow (`node-pty`, `koffi`, …);
  the headless checks do not need them.

## Checking the discipline beyond the guard

The harness checks guard integration, not model judgment. To check the standing rules
and skill install, point `DEEPSEEK_BASE_URL` at a local recording endpoint with a dummy
key and look at the model request: the `$DSH_HOME/AGENTS.md` block should arrive in a
`<system-reminder>` user message, project instructions after the global ones, and
`engramory` should be in the skill catalog when installed under
`$DSH_HOME/skills/engramory` (not `$DSH_HOME/.agents/skills`).

Then with a real model: ask something answerable only from a stored note, without
mentioning memory, and check it opens the note. Give it a durable fact and inspect the
note (type, frontmatter, `Why:` / `How to apply:`), the index pointer, the validator
runs and the sync report; re-run doctor yourself. These spot checks say nothing about
long sessions, crowded stores or other models.
