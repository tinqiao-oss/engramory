# dsh end-to-end check

`node --test` pins the guard's decision table against a mock. What a mock cannot tell
you is whether a given dsh release still mounts the plugin, still names its file tools
`write` / `edit` with the arguments the guard reads, still routes them through
`ctx.tools.guard()`, and still lists the skill. Each of those fails **silently**: the
plugin installs, nothing errors, and the cap stops being enforced. `run.py` checks them
on the real host, with no API key.

```sh
python tests/dsh_e2e/run.py 0.1.7-rc.1 0.1.5-rc.3                     # the repo's plugin (npm pack)
python tests/dsh_e2e/run.py --plugin dsh-engramory@0.2.5 0.1.7-rc.1   # a published version
python tests/dsh_e2e/run.py --record 0.1.7-rc.1                       # also update results.json
```

Needs `node`, `npm` and `pnpm` on PATH (`dsh plugin` shells out to pnpm) and access to
the npm registry. Each release costs one `npm install` of dsh (~500 packages, about a
minute), which is why this is not part of CI. Everything dsh writes goes under a temp
directory — a throwaway npm prefix and `$DSH_HOME` — and the caller's own dsh home is
fingerprinted before and after each release (top-level entries and profile manifests,
best effort) to catch a dsh that ignores `$DSH_HOME`; npm and pnpm do use their usual
caches. Every dsh call is pointed at a local endpoint with a dummy key, so no run
can reach the real API even if your environment holds a real key.

## What one run proves

For each release: install dsh → `dsh plugin --profile headless add <plugin>` → the
installed copy is byte-for-byte the plugin under test (for `--plugin`, the tarball the
registry serves) → the composed profile
(`--dump-config`) carries the `engramory` row → one headless task against
[`fake_llm.py`](fake_llm.py), whose script has the model

| step | tool call | dsh must report | the disk must show, before the next step |
|---|---|---|---|
| 1 | `write` a 260-line `MEMORY.md` | the guard's refusal | no file at all |
| 2 | `write` a 3-line `MEMORY.md` | success | exactly those 3 lines |
| 3 | `edit` it up to 253 lines | the guard's refusal | the same 3 lines |

The disk is read as each model request arrives, because a host that printed the
refusal *and* performed the write would otherwise be covered up by step 2. Results are
matched to steps by tool-call id, not by position. The same run checks that the task
and the skill reached the model, and that **every tool dsh offers is in
`REVIEWED_TOOLS`** — a table that says, for each one, why it cannot put the index past
the cap behind the guard's back (it *is* guarded, it is read-only, it is a shell, …).
A tool that is not in the table fails the run until someone places it; if it can write
a file, `index.js` has to learn it first. Finally `dsh plugin remove` must drop the row
and leave a profile that still boots and answers.

## `pass`, `fail`, `error`

A failure of dsh's own setup — it would not install, its `headless` template changed,
the registry was unreachable while adding the plugin, the harness itself crashed — is
recorded as **`error`**: it says nothing about the plugin either way. Anything after
that is a **`fail`**, including a timeout of the headless task: a plugin that never
lets dsh finish booting (issue #8) looks exactly like one. The exit status is non-zero
unless every release passed.

## The record, and what it is for

`--record` writes each outcome to [`results.json`](results.json), keyed by dsh
release, plugin version, source (`repo` = `npm pack` of this checkout, `npm` = a
published version) and platform, with the tarball's integrity, a **runtime digest**
([`evidence.py`](evidence.py): `index.js`, the bundle patch, and the package.json
fields that decide loading, line endings normalised), every check's outcome, the wire
format dsh spoke, and the tool list it offered.

The plugin's `package.json` declares, under `dsh.compatibility.dshReleases`, the
releases a run passed on. DSH-Store lists the plugin only while one of dsh's three
newest releases is declared `compatible`, and it accepts exact per-release records
only. `tests/test_dsh_plugin.py` refuses a `compatible` without a passing run of the
same plugin version **and** the same runtime digest, and refuses an empty map.

Declare only what passed. A release nobody ran stays out of the map (or `unknown`) —
never `compatible` on the strength of a neighbouring version. `dsh.compatibility.dsh`
is a display range for directories, not a claim that everything inside it was run; its
ceiling (`<0.2.0-0`) keeps every 0.2 build out until something runs there.

## When to run it again

- **Before every plugin release.** A version bump or any change to what dsh loads
  invalidates the old record; the unit test says so.
- **When dsh ships.** It releases every few days, so a declaration drifts out of
  DSH-Store's three-release window within a week or two and the plugin is delisted
  again. Nothing offline can notice that — the declaration does not age by itself.
  Re-run on the new releases and declare what passed.
- **On another OS.** Every record so far is `win32`, while the declaration is
  OS-agnostic — and the guard folds path case on Windows only (`pathKey` in
  `index.js`), so a macOS or Linux run is the most useful evidence still missing.

## Things this found out the hard way

- **dsh changed wire format under the plugin.** 0.1.7 talks to the model over the
  Anthropic Messages API (`POST {DEEPSEEK_BASE_URL}/v1/messages`); 0.1.5 and earlier
  over OpenAI chat completions (`POST {base}/chat/completions`). `fake_llm.py` answers
  both and 404s anything else; the run records which one it saw.
- **Every run also asks the model for a session title** — a request with no tools. It
  must not consume a script step, or every later reply shifts by one.
- **Timeouts on Windows.** `subprocess.run`'s timeout kills only the `cmd.exe` behind
  `npm.cmd` and then waits on pipes its node child still holds, so it never fires;
  `run()` kills the whole tree it started instead. An old rc line (0.1.1-rc.2) sat in
  npm's peer resolution for minutes without installing anything — an `error`.
- **Windows path length.** dsh names its session directory after the full working
  directory, and node_modules is deep; plain `rmtree` cannot delete what npm wrote,
  hence the `\\?\` prefix in `remove_tree()`.
- npm 11 skips dependency install scripts it has not been told to allow (node-pty,
  koffi, …). A headless run with `write`/`edit` does not need them.
