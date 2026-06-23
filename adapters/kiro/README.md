# Kiro adapter

[Kiro](https://kiro.dev) is AWS's agentic IDE (and CLI), built on Code OSS. It is a
strong Engramory host: it has a real **always-loaded rules channel** (steering files
with `inclusion: always`), the agent can **read/write workspace markdown** on its own,
and — unusually — it has a genuine **pre-tool-use deny gate** (a `PreToolUse` hook that
can block a file write before it happens). It also has **no silent auto-memory writer**,
so Engramory does not fight a second writer the way it does on Claude Code / Hermes.

This is a **docs adapter** (Phase 1): wiring is manual — there is no
`engramory_init.py kiro` helper yet, and the deterministic cap **hook shim is not
shipped or verified here yet** (see "Reliability model" below).

---

## ⚠️ The one mistake that blows up your context

Engramory is context-frugal because **only the pointer index (`MEMORY.md`) is
always-loaded; detail notes open on demand.** On Kiro it is easy to break that by
accident:

> **Do NOT put your detail notes (`<slug>.md`) inside `.kiro/steering/`.** A steering
> file with no `inclusion` front-matter **defaults to `inclusion: always`**, so every
> note you drop there loads into **every** request — context grows without bound and
> eventually overflows. The same happens if you add the whole store to a custom agent's
> `resources` glob (e.g. `file://.kiro/steering/**/*.md`), since agent resources are
> billed into context on every request whether referenced or not.

Correct layout:

- **Always-loaded:** one small steering file (`.kiro/steering/engramory.md`,
  `inclusion: always`) that carries the discipline and pulls in **only the index** via a
  live `#[[file:...]]` reference.
- **On demand:** the notes live in a **non-steering** folder (`.engramory-memory/`) and
  are opened by the agent with `read` / `#file` only when relevant.

If a fan reports "Engramory blew up my context on Kiro," this is almost always the
cause: the notes ended up in an always-loaded location. Move them out of
`.kiro/steering/` into `.engramory-memory/` and keep only `engramory.md` (the index
pointer) always-on.

---

## Quick start (manual wiring)

1. **Install the discipline as an always-on steering file.** Copy
   [`steering-engramory.md`](steering-engramory.md) to `.kiro/steering/engramory.md`
   (workspace) or `~/.kiro/steering/engramory.md` (all workspaces). It is already
   `inclusion: always` and ends with `#[[file:.engramory-memory/MEMORY.md]]`, which
   injects the live index into every session — the Kiro-native equivalent of Claude
   Code auto-loading `MEMORY.md`.

2. **Create the store** (separate folder, not under `.kiro/steering/`):

   ```
   .engramory-memory/
     MEMORY.md          # the pointer-only index
     <slug>.md          # one note = one fact (opened on demand)
   ```

   Seed `MEMORY.md` from [`templates/MEMORY.md`](../../templates/MEMORY.md).

3. **Git-ignore the store, but commit the steering pointer.** The store holds
   machine-local detail, so add `.engramory-memory/` to `.gitignore`. The steering file
   `.kiro/steering/engramory.md` is just the protocol (no secrets) and is fine to commit
   and share with the team.

4. **Do not hide the store from the agent.** Keep `.engramory-memory/` **out** of
   `.kiroignore` (`.kiroignore` blocks the agent from reading a path — you want it to
   read/write its own memory). `.gitignore` (no commit) and `.kiroignore` (no agent
   read) are independent; you want the first, not the second.

5. **(Optional) full protocol on demand.** Add `SKILL.md` as a second steering file with
   `inclusion: manual` (pull it in with `#engramory` when you want the detail) or
   `inclusion: auto` with a `description`, so the long protocol is not always in context.

`#[[file:...]]` reads the index live from the filesystem regardless of git status, so it
works on the git-ignored `.engramory-memory/` store.

---

## Reliability model on Kiro

Kiro **can** enforce the index cap deterministically — but that shim is **not written or
tested here yet**, so treat the Phase-1 cap as **rules + an explicit check**
(best-effort), exactly like the Codex and OpenClaw adapters:

1. The always-on steering file makes the recall/write discipline visible every session.
2. `SKILL.md` (as a `manual`/`auto` steering file) gives the full protocol on demand.
3. After editing the index, run
   `python tools/engramory_check.py .engramory-memory/MEMORY.md` and compact if it
   prints `OVER`; `engramory_doctor.py` is the occasional full health check.

> **Why no deterministic cap shipped here yet (Phase 2).** Kiro genuinely supports a
> pre-write deny gate: a **CLI `PreToolUse` hook** with `matcher: fs_write` can inspect
> the write and **exit 2 to block it** (stderr is returned to the agent as the reason) —
> the same shape as Engramory's Claude Code `hooks/engramory_index_guard.py`. So a
> deterministic Kiro cap is possible. But it needs its own shim (Kiro's hook JSON/exit
> contract differs from Claude Code's), and two open caveats must be verified first:
> - **Kiro IDE** `preToolUse` `runCommand` hooks have been reported to receive empty
>   `toolArgs` (`{}`) while the **CLI** passes full context (GitHub issue #7375) — so a
>   content/path-based write deny is only reliable in the **CLI**, degraded in the IDE.
> - **Kiro CLI `PreToolUse` has been reported broken on Windows 11** (GitHub issue
>   #8264) — verify the hook actually fires on your platform before relying on it.
>
> Per Engramory's honesty rule, the deterministic guarantee is only claimed where it is
> actually written and tested (today: Claude Code). On Kiro it is **possible** but
> **not yet shipped** — use rung 2 (the check script) until the shim lands and is
> verified.

---

## Don't confuse Engramory with Kiro's own `/knowledge`

Kiro's experimental CLI **Knowledge management** (`/knowledge`) is an *indexed,
search-on-demand* persistent store — a different (retrieval) design point. Engramory is
the *always-loaded curated index* model. They can coexist, but don't try to merge them
or point Engramory at the `/knowledge` store.
