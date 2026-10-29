# dsh end-to-end check

`node --test` pins the guard's decision table against a mock. What a mock cannot tell
you is whether a given dsh release still mounts the plugin, still names its file tools
`write` / `edit` with the arguments the guard reads, still routes them through
`ctx.tools.guard()`, and still lists the skill. Each of those fails **silently**: the
plugin installs, nothing errors, and the cap stops being enforced. `run.py` checks them
on the real host, with no API key.

```sh
python tests/dsh_e2e/run.py <dsh-version> [<another-version>]              # repo plugin (npm pack)
python tests/dsh_e2e/run.py --plugin dsh-engramory@<version> <dsh-version>   # published plugin
python tests/dsh_e2e/run.py --record <dsh-version>                          # update results.json
```

Needs `node`, `npm` and `pnpm` on PATH (`dsh plugin` shells out to pnpm) and access to
the npm registry. Each release requires a fresh dsh install, so this is not part of CI.
Everything dsh writes goes under a temp directory — a throwaway npm prefix and
`$DSH_HOME` — and the caller's own dsh home is
fingerprinted before and after each release (top-level entries and profile manifests,
best effort) to catch a dsh that ignores `$DSH_HOME`; npm and pnpm do use their usual
caches. Every dsh call is pointed at a local endpoint with a dummy key, so no run
can reach the real API even if your environment holds a real key.

## What one run proves

For each release: install dsh → `dsh plugin --profile headless add <plugin>` → the
installed copy matches the version and normalised runtime digest of the plugin under
test (for `--plugin`, the registry tarball) → the composed profile
(`--dump-config`) carries the `engramory` row → one headless task against
[`fake_llm.py`](fake_llm.py), whose script has the model

| step | tool call | dsh must report | the disk must show, before the next step |
|---|---|---|---|
| 1 | `write` a 260-line `MEMORY.md` | the guard's refusal | no file at all |
| 2 | `write` a 3-line `MEMORY.md` | success | exactly those 3 lines |
| 3 | `edit` it up to 253 lines | the guard's refusal | the same 3 lines |
| 4 | `write` the same 3 lines with CRLF to a second `MEMORY.md` | success | exactly those bytes |
| 5 | `edit` it with an LF `old_string` up to 253 lines | the guard's refusal | the same CRLF bytes |
| 6 | `working_directory` cd into the store (if offered) | the store's directory | the same 3 lines |
| 7 | `edit` a bare `MEMORY.md` up to 253 lines (if offered) | the guard's refusal | the same 3 lines |

dsh's edit matches on LF-normalised text and writes the result back as CRLF, so step
5's `old_string` does find its lines — a guard that matched the raw bytes would not.
Steps 6 and 7 run only when dsh offers `working_directory`; the script decides on the
turn it is asked. dsh's own working directory is the parent of the store, so a bare
`MEMORY.md` is the index only for a guard that resolves it the way dsh does — against
the session's directory, not the process's.

The disk is read as each model request arrives, because a host that printed the
refusal *and* performed the write would otherwise be covered up by step 2. Results are
matched to steps by tool-call id, not by position. The same run checks that the task
and the skill reached the model, and that **every tool dsh offers is in
`REVIEWED_TOOLS`**, classifying guarded writes, read-only/state operations, delegated
agents, and documented shell bypasses. An unknown tool fails the run until reviewed;
a new direct file writer needs guard support. A reviewed shell tool can still bypass
the cap: this check does not certify all write channels. Finally `dsh plugin remove`
must drop the row and leave a profile that still boots and answers.

## `pass`, `fail`, `error`

A failure of dsh's own setup — it would not install, its `headless` template changed,
the registry was unreachable while adding the plugin, the harness itself crashed — is
recorded as **`error`**: it says nothing about the plugin either way. Anything after
that is a **`fail`**, including a timeout of the headless task: a plugin that never
lets dsh finish booting must not be mistaken for an infrastructure error. The exit
status is non-zero unless every release passed.

## The record, and what it is for

`--record` writes each outcome to [`results.json`](results.json), keyed by dsh
release, plugin version, source (`repo` = `npm pack` of this checkout, `npm` = a
published version) and platform, with the tarball's integrity, a **runtime digest**
([`evidence.py`](evidence.py): `index.js`, the bundle patch, and the package.json
fields that decide loading, line endings normalised), every check's outcome, the wire
format dsh spoke, and the tool list it offered.

The authoritative release map is `dsh.compatibility.dshReleases` in the plugin's
[`package.json`](../../adapters/dsh/plugin/package.json). `tests/test_dsh_plugin.py`
rejects a `compatible` without a passing run of the same plugin version **and**
runtime digest, a contradictory failure, or a map with no compatible release.
Declare only what passed; untested releases stay absent or `unknown`.

DSH-Store reviews against a rolling window — the release npm tags `latest` and the
two undeprecated releases published before it — and installs only on an exact
`compatible` record for the local dsh version (per [DSH-Store's registry README](https://github.com/AI-Scarlett/DSH-Store/blob/main/registry/README.md));
check that external policy when publishing. `dsh.compatibility.dsh` is a directory
display range, not evidence that every release inside it was run. It is distinct
from the host's `engines.dsh` / `@deepseek-ai/dsh*` peer constraints: this plugin
intentionally declares neither, so an untested future release is not automatically
refused by a host version range.

## When to run it again

- **Before every plugin release.** A version bump or any change to what dsh loads
  invalidates the old record; the unit test says so.
- **When dsh ships.** Re-run on new releases and declare what passed; offline
  checks cannot detect a moving external registry window.
- **On another OS.** Inspect the platform fields in `results.json`; compatibility
  declarations are OS-agnostic, while `pathKey` folds case only on Windows.
  A passing run on one platform does not establish behavior on another.

## Operational pitfalls

- **Wire formats:** `fake_llm.py` handles Anthropic Messages
  (`POST {DEEPSEEK_BASE_URL}/v1/messages`) and OpenAI chat completions
  (`POST {base}/chat/completions`), returns 404 for anything else, and records which
  format arrived. CRLF edits and session-relative paths are checked by the steps above.
- **Session title:** dsh also sends a request with no tools. It must not consume a
  script step, or every later reply shifts by one.
- **Windows timeouts:** `subprocess.run` can kill only `cmd.exe` behind `npm.cmd`
  and then wait on pipes held by its Node child. `run()` terminates the process
  tree it started so a stalled install can return `error`.
- **Windows path length:** dsh derives session directories from full working paths,
  and `node_modules` is deep; `remove_tree()` uses the `\\?\` prefix for cleanup.
- npm 11 skips dependency install scripts it has not been told to allow
  (`node-pty`, `koffi`, …). Headless `write`/`edit` checks do not need them.

## Checking the discipline beyond the guard

The scripted harness verifies guard integration, not model judgment. To check the
standing rules and filesystem skill install, point `DEEPSEEK_BASE_URL` at a local
recording endpoint with a dummy key and inspect the model request:

- the user-global `$DSH_HOME/AGENTS.md` block should appear in a `<system-reminder>`
  user message with its source; project instructions should follow the global ones;
- `engramory` should appear in the skill catalog when installed under
  `$DSH_HOME/skills/engramory`, not `$DSH_HOME/.agents/skills`.

Then, separately with a real model, ask a question answerable only from a stored
note without mentioning memory; verify it opens the note and answers from it.
Give a durable reusable fact and inspect the resulting typed note, required
frontmatter, `Why:` / `How to apply:`, index pointer, validator runs, and
added/updated/archived/skipped report with index size. Re-run doctor independently.
A skill-only field such as `scope: global` is evidence of protocol access, not proof
of its loading path. These spot checks do not establish long-session, crowded-store,
or cross-model reliability. Historical observations live in [CHANGELOG.md](../../CHANGELOG.md).
