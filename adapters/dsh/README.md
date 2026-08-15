# DeepSeek Harness (dsh) adapter

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is DeepSeek's
open-source agent runtime — "everything is a plugin", MIT, in developer preview since
2026-08-13. It ships the two rails Engramory needs: an always-loaded workspace
instruction file, and a filesystem skill provider. Nothing has to be written in
TypeScript to run the discipline here.

## Quick start

From the Engramory repo. The installer defaults to `~/.dsh` — `$DSH_HOME`, which is both
the user-global instruction scope dsh reads every session and the parent of its user
skill root. Pass `--project-root` to wire a single project instead:

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
- `<root>/skills/engramory/`, when `--install-skill` is passed
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
- **There is a prompt budget.** The loader takes a `maxBytes` (65536 in the shipped web
  profile). Over budget it drops broader files first, then truncates the most specific
  one, and reports what it cut. An oversized project `AGENTS.md` can therefore shorten
  this block — keep both it and `MEMORY.md` inside their caps.
- **Recall is not free of the index cap.** dsh loads `MEMORY.md` only when the agent reads
  it; the 200-line / 25 KB discipline still applies, because that is what keeps the index
  cheap enough to read every session.

## Reliability model on dsh

The index-size cap here is **rules + an explicit check**, not a deterministic deny hook:

1. `AGENTS.md` makes the discipline visible every session.
2. `<DSH_HOME>/skills/engramory/SKILL.md` gives the full protocol, loaded by relevance.
3. After editing the index, run
   `python <DSH_HOME>/skills/engramory/tools/engramory_check.py <store>/MEMORY.md`
   and compact if it reports `OVER`; `engramory_doctor.py` is the occasional full health
   check.

> **Why no deterministic cap here yet.** Engramory's hard cap
> (`hooks/engramory_index_guard.py`) is a **Claude-Code-format Python shell hook**. dsh's
> pre-write deny path is `ctx.tools.guard()` — a synchronous **TypeScript** guard whose
> returned reason is a monotonic refusal (later waterfall listeners cannot turn it back
> into an allow), alongside the typed `PreToolDecision` of `allow` / `deny` / `ask`. That
> is a *better* seam than most hosts offer, but it is a different interface, so the Python
> hook does not drop in. A real deterministic cap on dsh means writing that guard as a
> plugin. It is **not shipped or verified here** — until it is, treat the dsh cap as
> best-effort. This matches Engramory's honesty rule: the deterministic guarantee is only
> claimed where it is actually written and tested (today, Claude Code).

## What was dogfooded, and how

Verified on Windows against `@deepseek-ai/dsh@0.1.0-rc.6`, by pointing `DEEPSEEK_BASE_URL`
at a local recording endpoint and inspecting the request dsh actually sent — no provider
key involved:

- The block is injected as a `<system-reminder>` user message sourced
  `Instructions from: $DSH_HOME/AGENTS.md`, carrying the rules and the host note.
- A project-level `AGENTS.md` loads **in addition**, listed after the user-global one
  (broader first, more specific last).
- With the skill installed under `<DSH_HOME>/skills/engramory`, `engramory` appears in the
  session's advertised skill catalog. Installed under `.agents/skills` *within* `$DSH_HOME`
  it did **not** — that path is not one of the five roots.

Model behavior was then checked against the real API (`deepseek-v4-flash`, 2026-08-15),
two scenarios, one run each:

- **Recall.** Asked a question answerable only from a stored note, with no mention of
  memory anywhere in the prompt, the model opened that note and answered from it — naming
  the file it had read.
- **Write.** Told one durable, reusable fact, it wrote a `feedback` note carrying all five
  frontmatter fields plus `Why:` and `How to apply:`, added a single pointer line to
  `MEMORY.md`, ran `engramory_check.py` and `engramory_doctor.py`, and reported
  added/updated/archived/skipped with the index size. Re-running `engramory_doctor.py`
  independently agreed: clean, no schema errors.

It also set `scope: global` on that note — a field the always-on block never mentions — so
it had reached the full protocol through the installed skill, not just the AGENTS.md block.

Two runs are not a reliability claim. This says the discipline lands and is followed on a
clean store; it says nothing yet about a long session, a crowded index, or a smaller model.

## Commands the agent can run

After editing the index:

```sh
python <DSH_HOME>/skills/engramory/tools/engramory_check.py <store>/MEMORY.md
```

Occasional full health check:

```sh
python <DSH_HOME>/skills/engramory/tools/engramory_doctor.py <store>
```

If you did not install the skill copy, run the same tools from wherever the Engramory repo
lives.
