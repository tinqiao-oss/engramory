# Agent setup runbook

**Read this if you are an AI agent and your user just asked you to install, adopt,
check, or upgrade Engramory.**

You are in an unusual position: you can inspect the machine, run the validators, and
read the user's existing notes far faster than they can. You are also the component
most likely to get this wrong — by asserting a capability your host does not have, or
by helpfully "fixing" memories you were never asked to touch.

This file is the procedure that keeps both from happening. Work through it in order.

- **Not for humans installing it themselves** — that is [`README.md`](README.md)
  (per-host install) and [`hooks/INSTALL.md`](hooks/INSTALL.md) (the Claude Code hook).
- **Not the protocol** — that is [`SKILL.md`](SKILL.md), which you follow *after*
  installation, on every task.
- **Not a porting guide** — writing a new host adapter is [`PORTING.md`](PORTING.md).

This file contains no capability tables, no cap values, and no host matrix. Those live
in the files above and in the tools' own output, and are cited from here — so this
procedure cannot drift away from what the code actually does.

---

## Read these ten lines before you do anything

They are up here because the failures they prevent all happen in the first minute,
before anyone has read this far. Breaking one is a defect in your run, not a judgement
call. The reasoning behind each is in the step that introduces it.

1. **Never guess a host capability.** Insufficient evidence → report `unknown` and ask.
2. **Announce before you read; stop before you write.** Gate 1 is a disclosure you make
   and then walk past. Gate 2 is a hard stop (next section).
3. **Do not edit an existing note. Not in bulk, and not "just this one".** A store that
   predates the discipline routinely has notes without dates or without
   `Why:`/`How to apply:`, and that is a normal, accepted state — not a defect list.
   Report them as *accepted legacy deviations* and leave them alone unless the user
   asks, note by note, with the content in front of them. You cannot supply what is
   missing anyway: file mtime is not when the fact was last true, and only they know why
   a note was worth keeping ([`PORTING.md`](PORTING.md)).
   **And do not describe them as damage.** A store with legacy notes is working
   normally. Words like "unhealthy", "not fully working", "90% correct", or "let me fix
   it and re-check" turn a cosmetic gap into an emergency and pressure the user into
   authorizing edits to their own history. If everything resolves and nothing is broken,
   the answer is "it works" — with the legacy notes mentioned once, as an optional
   tidy-up they can ignore indefinitely.
4. **Never echo note bodies — and read as little of them as the question needs.**
   Counting, structure and cap checks are answered by the index and by frontmatter;
   opening every note in full to establish "there are five of them" reads a person's
   private notes for no gain. Some reading is unavoidable and that is fine. Reading more
   than the question requires is not, because everything you read enters your context —
   for a hosted model, that is egress. And nothing from a body reaches your report either
   way.
5. **Do not scan the home directory by default.** Ask about candidate paths instead. If
   a broad scan is genuinely needed, get separate approval and bound it.
6. **Present ≠ configured ≠ active ≠ verified.** Never collapse these into "installed".
7. **One writer.** Never wire a second writer onto a store another agent owns.
8. **Report failures as failures**, with the tool output that shows it.
9. **A deviation is not automatically a defect.** Setups routinely differ from the
   documented default *on purpose* — a deliberately shortened rules snippet, a
   non-standard store path, a cap raised by an env var. Report what you observe and
   **ask whether it was intended**. Never "correct" it back to the default on your own;
   doing so can actively harm (restoring the full snippet where the user deliberately
   trimmed it re-inflates every future prompt).
10. **Answer what you can answer.** Every question you hand back costs the user
    attention. If a check is cheap, non-destructive, and inside the approved scope, run
    it and report the result — do not list it as an unknown for them to resolve.

---

## The two gates

The two gates are **not** the same kind of thing, and treating them alike breaks this
procedure.

| | What it is | What you do |
|---|---|---|
| **Gate 1 — survey** | a **disclosure** | state your scope, then **go ahead and look** |
| **Gate 2 — write** | a **hard stop** | list the exact changes, and wait for a yes |

**Gate 1 does not block you.** Say what you are about to read, what you will not read,
and that you will write one throwaway test file if a guard is already installed — then
carry on and do it. Do not stop for permission.

That is deliberate, and it is worth understanding before you "improve" it:

- A read-only survey changes nothing. The exposure is in *what* you read, and that is
  controlled by keeping the scope narrow (Hard rule 5) and never repeating note bodies
  (Hard rule 4) — not by asking first, which delays the same reads rather than avoiding
  any of them.
- "Install this for me" already implies "look at my machine first". You cannot install
  anything without looking.
- Blocking here has a much worse failure mode than over-reading: whenever nobody answers
  — a batch run, a CI job, a user who stepped away — the whole procedure yields **zero**.
  A polite question with no findings attached is worse than no runbook at all. You
  cannot reliably detect that case in advance either: from inside, an unattended run
  looks exactly like a conversation.

So: disclose, survey, and put your findings and your open questions in front of the user
**together**. If nobody ever replies, the report still stands on its own — and nothing of
theirs was touched.

**Gate 2 is a genuine stop.** Nothing of the user's changes without them approving a
specific list. If no answer comes, the correct outcome is an un-installed machine and a
report, not an installation you decided on by yourself.

---

## Step 0 — Whose machine are you looking at?

First, because it reads **nothing of the user's** — it is you inspecting your own
situation — and it decides how every later finding must be worded.

Establish whether you are on the user's own machine, in a container/sandbox, or in a
remote workspace. If you are **not** on their host machine, every negative finding for
the rest of this runbook must be reported as *"not visible from this execution
environment"*, never as *"not installed"*. A sandbox that cannot see `~/.claude/` proves
nothing about the user's laptop, and reporting it as "Engramory is not installed" is a
false negative that sends them to reinstall what they already have.

Do **not** try to work out whether anyone is there to answer you. You cannot tell from
the inside, and nothing below depends on it: the procedure is the same either way.

## Step 1 — State your scope, then get on with it

Tell the user, in this order:

1. what you are about to read (config files, candidate memory directories),
2. what you will **not** read or repeat (note bodies — see Hard rule 4),
3. that if a guard is already installed you will test it by writing **one throwaway
   file into a temporary folder and deleting it immediately** — nothing of theirs is
   touched (see *Verifying a guard*, below),
4. that nothing else will be written until they approve a concrete list of changes.

**Then continue straight into the survey.** This is Gate 1, and Gate 1 does not stop you
— it is a disclosure, not a request. Do not end your turn here waiting for a yes.

Anything you genuinely need from the user — which store is theirs, whether a deviation
was deliberate — goes into the report at Step 7, *next to the findings*, where they can
answer it in one pass while looking at the evidence.

## Running the tools

Establish where this repository is and **invoke the tools by absolute path**. Every
command in this file is written relative to the repo root for readability, but an agent
frequently is not standing there — a relative `python tools/...` then fails with
`No such file or directory`, which is easy to misread as "the tool is missing".

## Step 2 — Which host am I?

Two independent sources, cross-checked:

| Source | What it gives you |
|---|---|
| **Filesystem evidence** | which host config exists on this machine |
| **Your own introspection** | which tools you actually have (a direct file-write tool? a shell? which rules file were you loaded from?) |

Filesystem evidence alone does **not** identify you. A developer machine commonly holds
traces of several hosts at once; finding `.codex/hooks.json` does not mean you are Codex.

- Both agree → proceed, and record *why* you concluded it.
- They conflict, or evidence is thin → report **unknown** and **ask the user**.

Never infer a host capability from a host name. Whether your host can deny a write
before it happens is a fact to be established (see [`PORTING.md`](PORTING.md) §4), not
something to assume because a host "seems modern".

## Step 3 — Which store, and do I own it?

There is no store manifest and any `--memory-root` is legal, so **there is no reliable
automatic discovery**. Do not scan the user's home directory looking for one (Hard rule
5), and never silently adopt a path — not one you inferred, and not one you happened to
see earlier in the conversation. The user confirms which store is theirs, in the report.

That does not mean waiting before you look. **Check the likely locations that apply to
this host, then ask about what you found**: "there is a store at X with 142 notes — is
that yours?" is a question they can answer in one word. "Where is your memory stored?"
is a question you made them do the work for.

**Look for an existing store first. Proposing a new one is the last resort, not the
default.** These two are not interchangeable options to list side by side: a user who
already has a store and is offered a fresh path will end up with **two** — the old one
abandoned, the new one empty, and their memory split across both. That failure is quiet,
and it is worse than not installing at all. It is also the easy mistake to make: whatever
directory you happen to be running in is the most convenient suggestion and almost never
the right one.

So, in order:

1. **Look for one that already exists**, in the places that apply to this host — a
   host-native memory directory that is a **plain folder of files they control** (e.g.
   Claude Code's `~/.claude/projects/<project>/memory/`), or an `.engramory-memory/`
   left by an earlier install. Report what you found, with its size, and ask them to
   confirm it is the one.
2. **Only if there is genuinely none**, propose a new one — `./.engramory-memory/` is
   what `engramory_init.py` creates by default — and say plainly that this **creates a
   new store**, it does not adopt an existing one.

Either way the path is confirmed by the user before anything is written to it.

Then settle two things explicitly, because both are load-bearing:

- **Ownership.** Will *you* write this store, or does another agent own it and you only
  recall from it? Engramory assumes **one writer, many readers**, and there is no lock.
  Installing a second writer onto someone else's store is a corruption bug, not a
  configuration preference. Read-only wiring is the `<host>-reader` family in
  [`README.md`](README.md).
- **Separation.** If the host *manages its own* memory (Codex native Memories,
  OpenClaw's auto-written store, Hermes's managed files), Engramory must point at a
  **separate folder** — two writers with different house styles will fight over the
  same files ([`SKILL.md`](SKILL.md) §0). Reusing the host's directory is only correct
  when it is a plain directory of files the user controls.

## Step 4 — Survey what is already there

For the confirmed root:

```sh
python tools/engramory_doctor.py <MEMORY_ROOT> --no-schema
```

That gives the structural baseline — over-cap index, broken pointers, orphans,
duplicate slugs — without the per-note protocol checks.

**The doctor's `fix …:` lines are advice for a human, not a task list for you.** They
say what *would* resolve an issue; they do not say it should be resolved, or by whom, or
now. Structural problems (a pointer to a file that is gone, two notes with the same
slug) genuinely need someone to decide. Schema gaps in existing notes do not — see Hard
rule 3. Reading those hints as a backlog and offering to burn it down is the single most
common way this runbook gets misused.

The **strict** run (without `--no-schema`) needs a second, separate OK from the user:
it validates every note's frontmatter and can echo truncated fragments of malformed
frontmatter into your context, so it needs its own OK and Gate 1 does not cover it.
**Offer it in the report** — "want me to check protocol compliance too?" — rather than
running it now.

Also check whether Engramory is *already* installed here, and report each piece in four
states rather than as a yes/no — the difference matters and the failure modes are real:

| State | Means |
|---|---|
| **present** | the file/entry exists |
| **configured** | its contents are valid and point at the right root and script |
| **active** | the host actually loads it |
| **verified** | it has been proven end-to-end (*Verifying a guard*, below) |

Two traps in particular:

- **A half install looks like a working one.** The standing-rules snippet is the
  *primary* install step for Claude Code ([`README.md`](README.md)), yet it is the
  easiest to skip — a store plus a skill plus a hook, with no snippet in the rules file,
  means the discipline never loads on an ordinary task. If you find this, say so
  loudly; it is invisible from the outside and the store slowly fills with notes that
  do not follow the protocol.
- **Present but stale.** An installed skill copy and the managed hook scripts are
  **kept, not replaced**, unless `--force` is passed. An old copy left by an earlier
  version is "present" and is not "configured".

And one thing these four states cannot tell you: **whether a difference was deliberate.**
A trimmed rules snippet, a store somewhere unusual, a raised cap — each looks like a
misconfiguration and each is a perfectly normal choice. Report the difference, say what
it costs and what it buys, and **ask** (Hard rule 9). Restoring the documented default
unasked is not a fix.

## Step 5 — Which rung can this host reach?

Place the host on the degradation ladder in [`PORTING.md`](PORTING.md) §4 and report the
rung honestly, including when the answer is "this host cannot have a deterministic cap".

A deterministic pre-write deny is implemented and tested in this repo for **one** host.
For anything else, the correct report is that the cap is best-effort discipline — not
that it is "supported". Overstating this is the single most damaging thing you can do
in this runbook, because the user will then trust a guarantee they do not have.

## Step 6 — If something is already installed, prove it works

Do this **before** reporting, not after. "A guard is configured" and "a guard fires" are
different claims, and only the second one is worth anything to the user. The procedure is
*Verifying a guard* below; it is cheap and touches nothing of theirs, and you already
declared it at Gate 1.

Reporting `configured` without having tried it leaves the user holding a question they
cannot answer themselves — the one thing Hard rule 10 exists to prevent.

## Step 7 — Report, then stop

Write the report for **the person**, using *Reporting to a human* below. End with
decisions only they can make. This is Gate 2.

## Step 8 — Install (only after Gate 2)

Follow [`README.md`](README.md) for the host, or `engramory_init.py` where an adapter
exists. Two things to carry into your report afterwards:

- **There is no rollback.** Several targets are user-owned files, so a failure part-way
  leaves earlier steps on disk. The installer prints exactly which steps landed — pass
  that through to the user verbatim rather than summarizing it as "install failed".
- **Re-running is not unconditionally safe.** A truncated index is adopted as "kept
  existing" by the next run, and a half-copied skill directory is kept without
  `--force`. If a run failed part-way, read its report before re-running.

## Step 9 — Verify the new install, then report the outcome

Run *Verifying a guard* again on what you just installed, and report the result — including
failure. If the self-test did not deny, say the guard is not in effect. Do not report a
successful installation on the strength of files having been written: a guard that
silently never fires is the exact failure this project has already shipped once.

---

## Verifying a guard

Used by Step 6 (something was already installed) and Step 9 (you just installed it).

**Where a pre-write deny hook exists:** ask for a 250-line file named `MEMORY.md`
to be written in a scratch folder. It must be **denied**. Then delete the folder.

Two ways this test lies to you:

- It must go through your host's **direct file-write tool**. A shell heredoc, an MCP
  file tool, or an external editor bypasses the hook by design — a write that succeeds
  that way is not evidence of anything.
- If `ENGRAMORY_INDEX_PATH` is set, the hook guards *only* that one path, so a scratch
  `MEMORY.md` is supposed to be ignored. Testing there produces a **false failure**.
  Check that variable first; if it is set, exercise the real index instead.

**Where no such hook exists:** do not test for a deny — there is nothing to deny.
Verify instead that `python tools/engramory_check.py <MEMORY.md>` reports `OVER` on an
over-cap index, and state plainly that enforcement here is best-effort.

For the Codex lifecycle hooks specifically, confirming them in `/hooks` proves the
lifecycle assistance is trusted. It is **not** evidence of an index cap — those are
different mechanisms.

---

## Reporting to a human

Everything above is your **diagnosis**. It is not your report. The person who asked you
to install this is usually not the author of this project, has no interest in rungs,
snippets, or four-state tables, and asked one question: *can I use this, and what do I
do now?* Answer that question. A wall of internal vocabulary does not read as
thoroughness — it reads as "I have no idea, here are my notes".

Three rules:

- **Lead with the verdict.** First line says whether it works. Not what you inspected.
- **Their words, not ours.** "The index is at 78% of its cap" — not
  `97 lines / 19.6 KB, under cap`. "The rule that stops it growing too big is working, I
  tested it" — not `rung 1, cap hook verified`. Never make them look up a term.
- **Only mention what changes what they do.** A finding that leads to no decision and no
  action is a finding you keep to yourself. Say the number of open questions out loud and
  make it small; every one you hand over is attention you spent on their behalf.

**Say the size in whatever unit makes the next action obvious** — a percentage, or "room
for roughly N more entries". "97 lines" is meaningless to someone who has never seen the
cap. And when it is close to the limit, say *close*: "under cap" reads identically at 40%
and at 98%.

### Shape it to the situation

**Everything works:**

```
Engramory is installed and working. I tested it — the size guard does fire.

Your memory: 142 notes, index at 78% of its limit. No problems found.

One thing to confirm: your rules file uses a shortened version of the
discipline rather than the full text. That saves room in every prompt but
leaves some rules out. Deliberate? If so I'll leave it alone.
```

**Works, and there are old notes that predate the discipline** — this is still the
"everything works" case, so say that first and keep the rest to one sentence. Do not
grade it, do not offer to go fix them:

```
Engramory is installed and working — I read your memory fine, and the index has
plenty of room.

One of your six notes is an older one without the date/reason fields the newer
format uses. Nothing is broken by that and it still gets recalled normally; it's
only worth touching if you happen to be editing that note anyway.
```

**Installed, but something is actually wrong** — say what it means for them, not what is
missing:

```
Engramory is installed but NOT actually doing anything.

The rules that tell me how to keep your memory tidy were never added to your
CLAUDE.md, so they don't load. The storage and the size guard are both fine —
it's the discipline itself that's missing, which is why notes have been piling
up without the required structure.

Fix is one paste into CLAUDE.md. Want me to do it? (I'd be adding ~40 lines to
that file and changing nothing else.)
```

**Not installed yet:**

```
Not installed here. I can set it up — you're on Claude Code, which is the one
host that gets the strongest protection (a write that would blow the size limit
is refused outright, not just warned about).

I'd change 2 files: ~/.claude/settings.json and your CLAUDE.md.
I would not touch anything else, and none of your existing notes.

Heads up: if it fails halfway there's no undo — it stops and tells you exactly
what it already wrote. Go ahead?
```

**Cannot tell** (sandbox, unknown host, no evidence) — say so plainly and ask one
question, rather than reporting a false negative:

```
I can't see your actual machine from where I'm running, so I can't tell whether
it's installed. Can you run `ls ~/.claude/skills` and paste the result?
```

### Keep the detail, hand it over only if asked

Retain the full diagnosis — host evidence and confidence, the four states per component,
ladder position, `doctor` output, execution environment. Offer it in one line
("want the technical detail?") and produce it on request, or when something is wrong and
the detail is the explanation. Never open with it.

---

## What this file deliberately leaves out

Cap values, the host capability matrix, the ladder definition, and per-host install
commands are **not** repeated here. They live in [`SKILL.md`](SKILL.md),
[`PORTING.md`](PORTING.md), [`README.md`](README.md), [`hooks/INSTALL.md`](hooks/INSTALL.md),
and the tools' own output. This file is the procedure only, so that it cannot come to
describe behavior the code no longer has — a drift this project has had to clean up
before.
