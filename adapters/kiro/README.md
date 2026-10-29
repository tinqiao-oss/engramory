# Kiro adapter

[Kiro](https://kiro.dev) supplies always-loaded steering and workspace file access.
This is a manual docs adapter: there is no `engramory_init.py kiro` helper, and no
Kiro cap shim is shipped or verified here. See [PORTING.md](../../PORTING.md) for
host capabilities and the pre-write seam a future port would need to verify.

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

If notes already live under `.kiro/steering/`, move them to `.engramory-memory/`
and keep only the `engramory.md` index pointer always-on.

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

The cap is **best-effort rules + explicit check + doctor**. After editing the
index, run:

```sh
python <ENGRAMORY>/tools/engramory_check.py .engramory-memory/MEMORY.md
```

Compact if it prints `OVER`; periodically run:

```sh
python <ENGRAMORY>/tools/engramory_doctor.py .engramory-memory
```

`<ENGRAMORY>` is wherever you cloned this repo: no step here copies `tools/` into
the Kiro workspace. Keep that repo reachable or the cap is discipline only.
The [reliability ladder](../../PORTING.md#4-enforce-the-size-cap--the-degradation-ladder-no-pretooluse-hook)
distinguishes a possible port from an implemented, verified guard.

The steering file condenses [`SKILL.md`](../../SKILL.md), which remains the
protocol authority. Re-sync copied steering files against it when upgrading.

---

## Don't confuse Engramory with Kiro's own `/knowledge`

Kiro's experimental CLI **Knowledge management** (`/knowledge`) is an *indexed,
search-on-demand* persistent store — a different (retrieval) design point. Engramory is
the *always-loaded curated index* model. They can coexist, but don't try to merge them
or point Engramory at the `/knowledge` store.
