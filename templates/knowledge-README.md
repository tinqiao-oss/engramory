# Knowledge base

Articles written to be **read by a person**. Explaining something properly is the point —
not preparing material for some later use.

Content is organised around the **subject**, not around whoever ran into it. Problems you
hit belong here as *evidence* for why a mechanism behaves the way it does; they are not
the narrative spine.

## Relation to the memory store

The memory store (see the Engramory `SKILL.md`) is written for the agent: one fact per
file, compressed, conclusion-only, and its index is loaded every single session — which
is exactly why it has to stay small.

This is written for a human: one topic per article, mechanism and cause, structured so it
can be looked up. Read only when someone opens it.

Memories are raw material, but this is **not a stockpile for some downstream purpose**.

## Writing standard

- **Open with the fact or the mechanism, not a story.** State what a thing is and why it
  behaves that way, then how that shows up in practice.
- **Define a term the first time it appears.** The reader may be new to the area.
- **Put incidents in blockquotes** as supporting evidence. They do not carry the main
  line.
- **Make it navigable**: sections, tables, checklists. Readers usually arrive with one
  specific question rather than starting at the top.
- **Cover the whole rule, not only the part you hit.** Memory records where you stumbled;
  an article has to fill in the surrounding shape. If one kind of file cannot be renamed,
  say which kind can, and why.
- **Cite the source memories at the end** so a claim can be traced back.
- **The filename must name the subject.** There is no index here — the directory listing
  is how both you and the agent find things, so `packaging/windows-packaging-and-delivery.md`
  works and `notes-3.md` does not.

## When to write

**When you have actually worked something out.** It does not need a future use.

The other signal: **you notice yourself looking the same thing up a second time.**

Do not try to drain the memory store. Most memories are operational detail that only the
agent needs; they do not belong here.

## For the agent: when to propose an article

Propose — **never write unasked**. Angle and depth are opinionated choices and they belong
to the user.

**First, list this directory.** There is deliberately no topic list to consult: a
hand-maintained one drifts, and a stale list is worse than none because it makes you
propose things that already exist. The filesystem is the record. If a filename looks
adjacent to your subject, open that article's headings before deciding — extending it is
usually the right move.

**Test:** three months from now, facing the same class of problem, would someone have to
work it out again from scratch, or would a quick look be enough? If they would have to
redo the work, it is worth an article.

**Signals** (any one):

- You worked out a **mechanism or cause**, not just steps that happened to work
- Getting there required **discarding at least one wrong assumption** — so it is not
  obvious, and the next person will trip on it too
- You wrote a **long explanation in conversation**. That is already the draft

**Do not propose** when: it only holds for this project right now (that is a memory); the
official documentation answers it directly; or the list below already covers it.

## Finding things

There is no index. Browse the directory, or use search — filenames name their subjects,
which is the whole reason that rule exists. Obsidian's file tree, backlinks and graph give
you more than a list would, and none of it can go stale.

## If you open this in Obsidian

Turn off plugins that reformat frontmatter. If the same vault also contains the memory
store, automatic YAML formatting **will corrupt it** — that store uses a restricted
`key: value` grammar, not full YAML.

Editing here also makes you a second writer. Engramory assumes a single writer and has no
locking; the agent and a human editor can overwrite each other silently. In practice they
rarely collide, but it is worth knowing.
