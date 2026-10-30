# Kiro adapter

[Kiro](https://kiro.dev) has always-loaded steering and file access, which is all
Engramory needs. Setup is manual (no `engramory_init.py kiro`), and no Kiro cap guard
is shipped or verified here; see [PORTING.md](../../PORTING.md).

## ⚠️ The one mistake that blows up your context

Engramory stays small because **only the index (`MEMORY.md`) is always loaded**; notes
open on demand.

> **Do NOT put your notes inside `.kiro/steering/`.** A steering file without
> `inclusion` front-matter **defaults to `inclusion: always`**, so every note there
> loads into **every** request until the context overflows. Adding the store to a
> custom agent's `resources` glob (e.g. `file://.kiro/steering/**/*.md`) does the same.

The right layout: one small always-on steering file (`.kiro/steering/engramory.md`)
that pulls in **only the index**, and the notes in a **non-steering** folder
(`.engramory-memory/`) that the agent opens with `read` / `#file` when relevant. If
notes already live under `.kiro/steering/`, move them.

## Quick start (manual wiring)

1. **Copy the steering file.** [`steering-engramory.md`](steering-engramory.md) goes to
   `.kiro/steering/engramory.md` (this workspace) or `~/.kiro/steering/engramory.md`
   (all workspaces). It is `inclusion: always` and ends with
   `#[[file:.engramory-memory/MEMORY.md]]`, which injects the live index every
   session, even though the store is git-ignored.
2. **Create the store** outside `.kiro/steering/`, seeding `MEMORY.md` from
   [`templates/MEMORY.md`](../../templates/MEMORY.md):

   ```
   .engramory-memory/
     MEMORY.md          # the pointer-only index
     <slug>.md          # one note = one fact (opened on demand)
   ```

3. **Git-ignore the store; commit the steering file.** The store holds machine-local
   detail; the steering file is only the protocol and safe to share.
4. **Keep the store out of `.kiroignore`**, which would stop the agent reading its own
   memory. `.gitignore` and `.kiroignore` are independent: you want the first only.
5. **(Optional) The full protocol on demand:** add `SKILL.md` as a second steering file
   with `inclusion: manual` (pull it in with `#engramory`) or `inclusion: auto` with a
   `description`.

## Reliability model on Kiro

The cap is **best-effort rules + explicit check + doctor**:

```sh
python <ENGRAMORY>/tools/engramory_check.py .engramory-memory/MEMORY.md   # after editing the index; compact on OVER
python <ENGRAMORY>/tools/engramory_doctor.py .engramory-memory            # now and then
```

`<ENGRAMORY>` is your clone of this repo; nothing copies `tools/` into the workspace,
so keep it reachable or the cap is discipline only. The steering file condenses
[`SKILL.md`](../../SKILL.md), which stays the authority: re-sync your copy when
upgrading. The [reliability ladder](../../PORTING.md#4-enforce-the-size-cap--the-degradation-ladder-no-pretooluse-hook)
separates a possible Kiro guard from a verified one.

## Kiro's own `/knowledge` is something else

Kiro CLI's experimental `/knowledge` is an indexed, search-on-demand store, a
retrieval design. Engramory is an always-loaded curated index. They can coexist; do
not merge them or point Engramory at the `/knowledge` store.
