# DeepSeek Harness (dsh) adapter

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is DeepSeek's
open-source, MIT-licensed agent runtime. Engramory uses its always-loaded workspace
instructions and filesystem skill provider; the optional plugin adds a pre-write guard.

## Quick start

From the Engramory repo. The installer defaults to `$DSH_HOME` (the env var wins when
set, else `~/.dsh`) — which is both the user-global instruction scope dsh reads every
session and the parent of its user skill root. The user-global block renders ABSOLUTE
paths, because dsh's file tools resolve relative paths against the session cwd, not
against the file carrying the block. Pass `--project-root` to wire a single project
instead:

```sh
python tools/engramory_init.py dsh --install-skill
```

Windows PowerShell:

```powershell
python tools\engramory_init.py dsh --install-skill
```

This creates or updates, under that root:

- `<root>/.engramory-memory/MEMORY.md` (the curated Engramory store)
- `<root>/AGENTS.md`, with one marked Engramory block
- the skill, when `--install-skill` is passed — `$DSH_HOME/skills/engramory/` for the
  user-global install, `<project>/.dsh/skills/engramory/` with `--project-root` (the
  roots dsh actually scans; `<project>/skills/` is not one of them)
- `<root>/.gitignore`, when the memory folder is inside the root

## How dsh picks this up

- **Standing rules (always-on):** the `@deepseek-ai/dsh-agent-instructions` plugin loads
  workspace instructions at the start of every session. Its candidate list is the
  hardcoded `["AGENTS.md", "CLAUDE.md"]`, plus `AGENTS.local.md` / `CLAUDE.local.md`
  overlays for project scopes — so the marked block needs no registration. The
  user-global file is always `$DSH_HOME/AGENTS.md` and has **no** local overlay.
- **Full protocol on demand:** `@deepseek-ai/dsh-skill-filesystem` scans five roots in
  rank order — `<project>/.dsh/skills`, `<project>/.agents/skills`, any configured custom
  dirs, `<DSH_HOME>/skills`, then `<AGENTS_HOME>/skills` (`~/.agents/skills`). Note the
  user root is `<DSH_HOME>/skills`, **not** `.agents/skills` under it; installing into the
  wrong one fails silently — the copy lands and dsh simply never lists the skill.

## dsh-specific gotchas

These are properties of the host, not of Engramory, and each one can bite quietly:

- **Do not duplicate the block into a sibling `CLAUDE.md`.** dsh collapses two
  same-directory candidates only while they stay byte-identical after trimming. Once they
  drift, *both* load and the discipline is injected twice.
- **There is a prompt budget.** The loader takes a configured `maxBytes`.
  Over budget it drops broader files first, then truncates the most specific
  one, and reports what it cut. An oversized project `AGENTS.md` can therefore shorten
  this block — keep both it and `MEMORY.md` inside their caps.
- **Recall is not free of the index cap.** With the [plugin](plugin/README.md) installed,
  `MEMORY.md` is injected into every request, cut at the
  [configured caps](plugin/README.md#configuration); without it, dsh loads the index only
  when the agent reads it. Either way, a small index is what keeps recall cheap.

## Reliability model on dsh

The init helper installs **best-effort rules + explicit check + doctor**. For a
deterministic pre-write guard, install [`dsh-engramory >= 0.2.7`](plugin/README.md)
separately; its guide covers installation, configuration, tool coverage, and limits.
`pnpm` must be on PATH for `dsh plugin` commands.

Compatible dsh releases are declared only in
[`dsh.compatibility.dshReleases`](plugin/package.json), backed by
[`results.json`](../../tests/dsh_e2e/results.json). An unrecorded release is
unverified. See the [E2E method](../../tests/dsh_e2e/README.md) for guard verification
and discipline checks, and [PORTING.md](../../PORTING.md) for the host reliability ladder.

## Commands the agent can run

After editing the index, run the check and compact if it reports `OVER`:

```sh
python <DSH_HOME>/skills/engramory/tools/engramory_check.py <store>/MEMORY.md
```

Occasional full health check:

```sh
python <DSH_HOME>/skills/engramory/tools/engramory_doctor.py <store>
```

(Project-root installs: the skill lives at `<project>/.dsh/skills/engramory` — substitute
that prefix.)

If you did not install the skill copy, run the same tools from wherever the Engramory repo
lives.
