# Changelog

All notable changes to Engramory. Versions from 0.1.3 onward are git tags (0.1.0–
0.1.2 predate the 0.1.3 history consolidation). This is an experimental 0.x project
— expect rough edges off Claude Code (see SKILL.md §8 / §9).

## 0.3.2 — 2026-06-24

Third host adapter (Kiro) — docs-only, backward-compatible. Motivated by a real report
of Engramory overflowing the context window on Kiro: the cause is Kiro's default
`inclusion: always` on steering files, so notes dropped into `.kiro/steering/` load into
every request.

Added
- **Kiro adapter (`adapters/kiro/`).** A `README.md` plus a ready-to-copy
  `steering-engramory.md` template (`inclusion: always`) that carries the discipline and
  injects the live index via `#[[file:.engramory-memory/MEMORY.md]]` — the Kiro-native
  equivalent of Claude Code auto-loading `MEMORY.md`. Notes live in a **non-steering**
  `.engramory-memory/` folder, opened on demand.
- **Context-overflow footgun documented.** README (EN + zh), PORTING.md, and the adapter
  README all warn: do **not** put detail notes in `.kiro/steering/` (default
  `inclusion: always` → every note in every request → overflow); only the index belongs
  in always-loaded steering. `.gitignore` the store, commit the steering pointer, and do
  not add the store to `.kiroignore`.
- **PORTING.md** gains a Kiro row in the host table and a Kiro rung-1 entry: a CLI
  `PreToolUse` hook with `matcher: fs_write` + `exit 2` is the same shape as the Claude
  Code guard, so a deterministic cap is possible — but the IDE may pass empty `toolArgs`
  (issue #7375, CLI-only deny) and the CLI hook is reported broken on Windows 11 (issue
  #8264). No shim is shipped/tested yet, so the Kiro cap is rules + `engramory_check.py`
  (best-effort), per Engramory's honesty rule.

## 0.3.1 — 2026-06-20

Docs patch — corrected and sharpened the Hermes (Nous) porting facts after verifying
against Hermes's own docs/source. Docs-only, backward-compatible.

Changed
- **Hermes always-loaded rules channel is `AGENTS.md` / `.hermes.md`, not `SOUL.md`.**
  `SOUL.md` is real and always-loaded, but it is Hermes's *identity/persona* slot
  (#1 in the system prompt), reserved for tone — standing operational rules belong in
  the project context files (`AGENTS.md` is Hermes's own recommended place, which also
  matches the Codex/OpenClaw adapters).
- **Don't take over Hermes's native memory.** Its `memory` tool writes a frozen-snapshot
  `MEMORY.md` + `USER.md` that are **already hard-capped in code** (2,200 / 1,375 chars
  ≈ 1,300 tokens) with error back-pressure + exact-duplicate rejection — so Engramory's
  index cap is redundant there and its atomic-files-plus-index recall model doesn't fit a
  single always-injected file. Run Engramory as a **separate plain-file store** (like the
  Codex adapter) instead; its value-add on Hermes is the ontology + Why/How + negative-scope,
  which the native store lacks.
- **Hook scope + caveat.** The `pre_tool_call` matcher `write_file|patch` guards an
  Engramory *separate-store* index (the agent's file writes); it does not — and need not —
  intercept the code-capped native `memory` tool. Noted the reported `pre_tool_call`
  non-firing bug in some worker/dispatch contexts (issue #25204): verify before relying.

## 0.3.0 — 2026-06-15

Second host adapter (OpenClaw) + accurate cross-host porting facts. Minor bump,
backward-compatible.

Added
- **OpenClaw init adapter.** `tools/engramory_init.py openclaw` bootstraps an OpenClaw
  workspace (default `~/.openclaw/workspace`): a marked block in `AGENTS.md` (loaded
  every session), the protocol under `.agents/skills/engramory` (OpenClaw auto-discovers
  it), and a separate `.engramory-memory/` store. The `init` tool now takes a host
  argument (`codex` | `openclaw`) over a shared, idempotent core; the two adapters use
  distinct markers and coexist in one `AGENTS.md`.
- **OpenClaw adapter docs** — `adapters/openclaw/README.md`. Honest reliability model:
  the index cap is rules + `engramory_check.py`. OpenClaw's deterministic deny path is a
  `before_tool_call` *plugin* (TypeScript), **not** Engramory's Python shell hook, so the
  guard does not drop in — a hard cap there means writing that plugin (not shipped here).

Changed (docs)
- **PORTING.md** host table corrected and extended (Cursor → `alwaysApply` + auto
  `.agents/skills`; added OpenClaw and Trae). The cap degradation ladder now lists the
  real, non-interchangeable per-host deny mechanisms — Hermes `pre_tool_call`, Cursor
  `preToolUse` (new/flaky), OpenClaw `before_tool_call` plugin, Trae none — each
  cross-checked against the host's 2026 docs. Only the Claude Code hook is tested here.

Tests
- +2 (91 total): OpenClaw bootstrap, and Codex + OpenClaw coexisting with distinct
  markers (re-running either leaves the other intact).

## 0.2.0 — 2026-06-15

First host adapter beyond Claude Code. Minor bump: new functionality, fully
backward-compatible (existing Claude Code setups are untouched).

Added
- **Codex init adapter.** `tools/engramory_init.py codex` bootstraps a Codex project:
  creates a conservative memory store, adds a marked Engramory block to `AGENTS.md`,
  optionally installs the full protocol under `.agents/skills/engramory` (Codex
  auto-discovers Agent Skills there), and adds a `.gitignore` entry when the store
  lives inside the project. Re-running is idempotent.
- **Codex adapter docs.** `adapters/codex/README.md` documents the recommended
  `AGENTS.md + .agents/skills + separate plain memory folder` wiring, and is explicit
  that the index cap on Codex is rules + `engramory_check.py`, **not** a deterministic
  deny hook (the `PreToolUse` hook is Claude-Code-only).

Hardened (init)
- `AGENTS.md` block editing tolerates malformed markers from a hand-edit: a reversed
  (`END` before `BEGIN`) or dangling single marker no longer crashes, and never
  deletes the surrounding user content (stray marker lines are dropped, a fresh block
  appended).
- Fails fast with a clear message if the source tree is incomplete (instead of a raw
  `FileNotFoundError` mid-copy); `--force` help now states it recreates the whole
  `.agents/skills/engramory` directory.

Tests
- Init coverage for Codex bootstrap, idempotence, external/kept memory roots, the
  malformed-marker no-data-loss guarantee, and `--force` replace-vs-keep (+5; 89 total).

## 0.1.13 — 2026-06-15

Pre-public-release hardening (the repo goes public at this version). A multi-agent
pre-publish audit — adversarially verified, every finding reproduced — turned up one
red-CI blocker and two real robustness gaps. All fixed; no change to the protocol or
to what the doctor/hook consider valid.

Fixed (CI / tests)
- **Green CI on Linux.** `test_doctor_miscased_pointer_is_not_false_orphan` baked in a
  case-insensitive-filesystem assumption and failed on case-sensitive Linux — yet the
  tool was *correct*: a miscased pointer to a path that doesn't exist there is a
  genuine "missing file" + a genuine (not false) orphan. The test is now
  filesystem-aware (probes case-folding, asserts "clean" on Win/mac and "missing file"
  on Linux), so CI is green on every OS in the matrix.

Fixed (tools)
- **CLI tools no longer crash on a strict ascii / OEM console.** `engramory_doctor`
  and `engramory_check` print an em-dash / `§` in their normal verdict text, which a
  Windows cp437/cp850 console or a POSIX `C`/ascii locale cannot encode — it raised
  `UnicodeEncodeError` instead of printing the report. Both now reconfigure stdout to
  `backslashreplace`, so the report always prints. (The hook was never affected — it
  emits ascii-safe JSON.)
- **`-h` / `--help`** on both tools now prints usage and exits 0 (previously `--help`
  ran a scan of `.` on the doctor, or read as an unreadable path on check).

Changed (docs)
- **README.md** install step now matches README.zh-CN word-for-word in intent: only
  the Claude Code cap adapter is written and tested; on every other host you write and
  verify the thin I/O shim yourself.

Tests: +4 (84 total).

## 0.1.12 — 2026-06-14

A self-directed multi-agent deep audit (then adversarially verified, each finding
reproduced on a real sample). ~21 raw findings deduped to ~8 distinct, cross-platform
robustness ones; two suggestions were declined as over-engineering (see end).

Fixed (doctor)
- **UTF-8 BOM** no longer makes a valid note read as "no frontmatter block" — notes
  decode with `utf-8-sig` (Windows editors / PowerShell write a BOM by default).
- **No more false "orphan" on case-insensitive filesystems (Windows/macOS).** A
  pointer whose case differs from the file (`feedback_git_workflow.md` → file
  `feedback_Git_Workflow.md`) resolved via `os.path.isfile` but was keyed by the
  pointer's text, so the real note was reported as an orphan (exit 1). The graph now
  keys on the realpath-resolved name (which canonicalises case), matching the file.
- **A self-link no longer rescues a real orphan.** A note that only contains
  `[[itself]]` and isn't in the index is once again flagged (the wikilink graph
  excludes self-references).
- **`.MD` / `.Md` extensions are discovered and schema-checked** (was case-sensitive
  `.md`, so an uppercase-extension note silently bypassed type/date/Why-How validation
  while its pointer still resolved on a case-insensitive FS).
- **Pointer regex tightened:** `note.md.bak` / `note.md.tmp` are no longer truncated
  to `note.md` (false credit + misleading "missing file" text); control characters
  (incl. NUL) are excluded so a malformed pointer can't reach `realpath` and throw;
  backslash pointers are normalised so they resolve the same on Windows and Linux.
- **Byte sizes render via the shared `_kb()`** like check/hook — a sub-1 KB index
  shows "N B" not "0 KB", and an over-by-1-byte cap no longer prints "25 KB > 25 KB".

Fixed (hook)
- **The deny reason names only the dimension that actually grew.** Compacting line
  count while bytes rise (both over cap) no longer tells you to cut a line count that
  is shrinking.

Changed (docs)
- **README.md** mirrors the zh-CN "adopting an existing store" pointer in the install
  section (CONTRIBUTING asks both READMEs stay in sync).
- **INSTALL.md / README.zh-CN** align the Codex/Windsurf hook-maturity wording to the
  flat "coverage varies, only Claude Code is tested" phrasing already in the EN README.

Declined (out of scope for a single-writer, personal-scale, zero-dependency tool)
- O(n²) regex time on an *unbounded, malicious* note body (you'd have to put a 100 KB
  unclosed-bracket file in your own store; atomic groups aren't available pre-3.11).
- Why/How written *inside a code fence* counting as reflection (contrived; a Markdown
  code-block stripper adds more risk than the non-scenario removes).

+7 tests (80 total). Zero-dependency; no exit-code or judgment-logic change.

## 0.1.11 — 2026-06-14

A third-opinion audit (Codex) on 0.1.10. Findings verified on samples first; one
suggestion (enforce fixed four-type index sections) was declined — a thematic index
layout is a deliberately allowed shape, and enforcing sections would fail valid stores.

Fixed
- **The default install now produces compliant memories.** `rules-snippet.md` (the
  always-loaded primary path) taught name/description/type but not `created`/`updated`
  or Why/How, so an agent following only the default rules could write notes the doctor
  then flags. The snippet now states the full write-contract (frontmatter dates + a
  `Why:` / `How to apply:` line on feedback/project notes).
- **The hook no longer blocks a real compaction.** It treated *either* dimension
  growing as growth, so cutting line count while bytes ticked up (still under the byte
  cap) was wrongly DENIED. It now denies only when the dimension that is over its OWN
  cap grows — honouring the documented promise that shrinking/compaction edits pass.

Added
- **doctor flags duplicate index pointers** (the same note pointed to from more than
  one line) as INFO — redundant but non-failing (a thematic index may cross-reference
  on purpose).

Changed (docs honesty)
- **SKILL §1** stops calling the frontmatter "YAML": it's a restricted `key: value`
  subset (no multi-line values / lists), parsed by a zero-dependency reader.
- **README.zh-CN** the "Claude Code uses the same four types" claim now carries the
  same qualifier as the English (per anthropics/claude-code#58840; the public docs
  don't expose the type ontology).

+2 tests (73 total). Zero-dependency; no exit-code or judgment-logic change.

## 0.1.10 — 2026-06-14

A second-opinion audit (Codex) on the 0.1.9 release. Every finding was reproduced on
a real sample first; the fixes are correctness + doc-honesty, with no widening of what
the validator accepts.

Fixed
- **doctor scans only the note BODY for `Why:` / `How to apply:`** — a label sitting
  in the frontmatter no longer satisfies the reflection requirement.
- **doctor requires an exact `---` fence line** — `----` / `---x` is no longer
  mistaken for a frontmatter fence (a Markdown horizontal rule can't silently close
  it); CRLF endings are tolerated.
- **doctor escape check uses `realpath`** — a symlinked index pointer can no longer
  resolve outside the store root while passing the check.
- **check.py docstring** said WARN fires at `>= soft`; the code fires at `> soft`.
  Corrected.

Changed (docs honesty)
- **Cross-host cap claims tightened** (PORTING / SKILL §9): the deterministic cap is
  shipped and *tested only on Claude Code*; other hosts expose the hook API so it is
  portable, but you write and verify that shim yourself — not "already works on
  Cursor / Cline".
- **README.zh-CN synced to the English:** the differentiator no longer implies
  procedural memory is novel (it is prior art — the contribution is the bundle +
  discipline); the comparison table's basic-memory / mem0 cells match the English;
  and the missing **Known limitations** section was added.
- **INSTALL.md** no longer says memories "hold secrets" — they hold machine-local
  *locators*; a secret's *value* never belongs in memory (SKILL §5).

+4 tests (71 total). Zero-dependency; no exit-code or judgment-logic change.

## 0.1.9 — 2026-06-14

From a real first-adoption: migrating a 118-note Claude Code store to strict format
surfaced false-positives and triage gaps — none of the strictness was wrong, the
*reporting* was.

Fixed
- **doctor Why/How check accepts a full-width colon `：`** (CJK keyboards emit it)
  and a line-start Markdown prefix (`#`/`>`/`*`), and is now line-anchored so an
  incidental `Why:` in prose no longer counts. The full `How to apply:` label and an
  explicit colon are still required — a bare `## How` or short `How:` stays an ISSUE
  (the "to apply" cue is deliberate), but now prints a fix hint naming the variant.
- **doctor tolerates a host type-prefix in the name↔filename check** (Claude Code's
  `name: audit-methodology` vs file `feedback_audit_methodology.md`) — no more INFO
  noise on host-native stores.

Added
- **doctor groups its issues** into a bucketed summary (`N missing-date,
  N missing-why-how, N broken-pointer, …`) with a one-line manual fix per bucket, so
  a big existing store reads as a triage list, not a flat wall.
- **`Adopting an existing store` guide** (PORTING.md): `--no-schema` to triage
  structure first, a copy-paste stdlib snippet to backfill missing `created:`/
  `updated:` from mtime (dry-run, honestly captioned), then write Why/How by hand.

Changed
- **check / doctor / hook now name the breached dimension** (lines vs bytes) in the
  WARN / over-cap / over-shrink messages — matching the DENY path, which already did
  — plus a one-line "compact this dimension first" hint. (You could over-compress one
  axis without realising the other tripped.)
- **SKILL §2:** documents the canonical Why/How label form, and that a pure-status
  snapshot is negative scope (fold in or demote to `reference`), not a `project` note
  to force-fit with ceremonial Why/How.

All changes are zero-dependency, with no exit-code or judgment-logic change. +11
tests (67 total).

## 0.1.8 — 2026-06-14

Added
- **doctor `--no-schema` flag:** run only the structural checks (over-cap index,
  broken pointers, orphans, duplicate slugs) and skip the per-note frontmatter /
  protocol validation. Use it to health-check a store that isn't in strict Engramory
  format — e.g. a host-native auto-memory store — without the schema noise. The
  default stays strict (full validation). +2 tests (56 total).

## 0.1.7 — 2026-06-14

Fourth Codex round — make the "validator" actually validate, plus competitor-fact
and OSS-hygiene fixes.

Fixed
- **doctor is now a real protocol validator** (it had reported non-compliant stores
  as clean). Missing required `name`/`description`/`type`/`created`/`updated`, an
  invalid `type`, a non-calendar date (e.g. `2026-99-99`), malformed frontmatter /
  unclosed quotes, and missing `Why:` / `How to apply:` on feedback/project notes
  are now ISSUE (exit 1), not info; the `Why:`/`How:` check tolerates `**bold**`.
  The frontmatter grammar is a restricted `key: value` form (still zero-dependency).

Changed (docs accuracy)
- **README:** the "Claude Code uses the same four types" line now cites
  anthropics/claude-code#58840 (system prompt) and notes the public docs show only
  the index + topic files; the basic-memory cell is "schema + overwrite checks"
  (not "hygiene, not enforced"); OpenAI Codex is credited as shipped memory; the
  pre-write deny hooks list no longer singles out Codex as immature.
- **PORTING / SKILL §9:** hosts treating memory as managed/generated state (Letta,
  Codex's local Memories) cannot be ridden — use their rules and keep the Engramory
  store separate.
- **README:** added a **Known limitations** section (no versioning / provenance /
  scope / concurrency; personal-scale) — a store-level manifest is roadmap.

Added
- **CI:** GitHub Actions runs both test suites on Ubuntu + Windows × Python 3.8/3.12.
- +4 doctor validation tests (54 total).

## 0.1.6 — 2026-06-14

Changed (docs)
- **README EN banner drift fix:** it still said the cap is "always-on" while the zh
  banner and SKILL §8 had been corrected; the EN banner now matches — deterministic
  for the matched direct-edit tools, not a global write guard, single-writer assumed.
- **Tagline** sharpened to the accurate scope: "a strict curation discipline plus a
  validator for small-scale, local, file-based agent memory" (cross-agent stays the
  stated goal, not a present-tense claim).
- **Prior art:** credit Andrej Karpathy's LLM Wiki / Knowledge Base (markdown-over-RAG),
  noting it targets a knowledge encyclopedia where Engramory targets agent working
  memory. Fixed a leftover "the skill applies" → "the protocol applies".

## 0.1.5 — 2026-06-14

Fixed
- **doctor:** the note `name`-vs-filename check now ignores `-`/`_`/case, so a store
  written by the host (e.g. Claude Code uses `a-b` names with `a_b.md` filenames) is
  no longer flagged with spurious name-mismatch info; nested frontmatter (a
  `metadata:` block) is still read. +1 test (50 total).

## 0.1.4 — 2026-06-14

Positioning & protocol-rigor pass (third external Codex round). Repo history was
consolidated into a single clean commit before this release, so the earlier
"internal paths in history" caveat no longer applies. No breaking code changes.

Changed (honesty / scope)
- **Reliability (SKILL §8, SECURITY.md):** the cap hook is **deterministic only for
  the matched direct-edit tools** (`Edit | Write | MultiEdit`) — writes via Bash, MCP
  file tools, external editors, or sync clients are NOT intercepted. Dropped the
  "always-on and deterministic / globally reliable" framing.
- **Trust model (SKILL §2/§4, SECURITY.md):** reconciled feedback-as-behavior with
  recall-as-fallible-background — recalled memory is advisory, never overrides the
  user's live instructions or safety, and the store is treated as
  attacker-influenceable (a tampered note can be a stored prompt injection).
- **Skill vs rules:** removed the leftover "the discipline is a skill loaded by
  relevance" line (SKILL §8) that contradicted the 0.1.3 repositioning.
- **Comparison & differentiators (README):** corrected the unfair "mem0/Zep = facts
  only / opaque" cell (they support preferences/episodic/procedural; Zep supports a
  custom ontology) and the "least prior art" claim (the semantic/episodic/procedural
  split is CoALA / LangMem / mem0 prior art).
- **Concurrency:** documented the single-writer / serialized-writes assumption.

Added
- **doctor protocol lint:** `engramory_doctor.py` now validates note frontmatter
  (`description` and a valid `type` are required; `name` should equal the filename
  slug; `created`/`updated` should be ISO dates; feedback/project notes should carry
  `Why:` / `How to apply:`) and flags notes reachable only via a `[[wikilink]]` (not
  in the index, so they won't load at session start). It was previously only a
  reference/orphan checker. +6 tests (49 total).

## 0.1.3 — 2026-06-14

Second audit round (external Codex review). Fixes real issues the first pass missed
— including a doc claim that was wrong in the *opposite* direction.

Fixed
- **hook:** the non-blocking nudge (warn / over-but-shrinking) now emits
  `additionalContext` with NO `permissionDecision`, instead of
  `permissionDecision: "defer"`. Omitting the decision is the documented way to add
  context without affecting the permission flow, and is unambiguous across Claude
  Code's interactive and non-interactive modes (where `"defer"` behaves
  differently). Blocking still uses `deny`; the hook still never emits `allow`.
- **hook:** `ENGRAMORY_INDEX_PATH` matching now uses `normcase` + `realpath`, so a
  Windows case difference (`E:\Memory` vs `e:\memory`) or a symlink can't slip an
  edit to the guarded index past the gate.
- **doctor:** index pointers now resolve to the actual pointed path instead of a
  loose basename match — `wrong/path/a.md` is correctly flagged missing even when
  some `a.md` exists elsewhere, and a pointer escaping the store root
  (`../outside.md`) is flagged.
- **settings.snippet.json:** the script path is double-quoted so an install path
  with spaces (e.g. `Program Files`) works.

Changed
- **docs:** the 200-line / 25 KB `MEMORY.md` load window is now stated as
  *documented* Claude Code behavior (it is — see the official memory docs), not an
  "empirical, undocumented observation." (The first audit round had wrongly
  "refuted" this as fabricated.)
- **SKILL.md:** removed a `user`-vs-`feedback` contradiction (a reply-language
  preference is `feedback`, not `user`); the warn-threshold wording now matches the
  code's strict `> 150 / > 20 KB` (was "≥").
- +2 tests (43 total): doctor wrong-subpath and root-escape pointer checks; the
  warn/shrink assertions updated for the context-only nudge.

## 0.1.2 — 2026-06-14

Audit pass (multi-agent review + adversarial verification). No breaking changes —
all fixes are hardening, doc accuracy, and open-source readiness.

Fixed
- **doctor:** `templates/` / `archive/` exclusion now matches the first path
  component, not a raw string prefix (it no longer wrongly skips a sibling like
  `templates-old/`); index-pointer parsing resolves anchored / titled links
  (`note.md#sec`, `note.md "Title"`) and ignores external `.md` URLs; duplicate
  note slugs across dirs are reported instead of silently masking an orphan;
  unreadable files degrade to a reported issue instead of a traceback; byte size is
  measured on raw bytes (consistent with the hook / check on non-UTF-8 input).
- **check:** a usage error now exits `64` and an unreadable index exits `66`
  (distinct from the `0/1/2` OK/WARN/OVER result, so automation can tell
  "could not check" from "index is fine").
- **hook:** a non-positive (`0` / negative) env cap falls back to the default
  instead of bricking all index edits; the deny reason now points a surprised user
  at `ENGRAMORY_INDEX_PATH`; cap byte display and line pluralization tidied.

Changed
- LICENSE copyright holder → `Beijing Tinqiao Technology Co., Ltd.`
- Removed parent-project references from examples & templates (neutral, fictional
  illustrations only).
- README: added a **Security & privacy** section and a Python 3.8+ requirement.
- README.zh-CN: backported the stale 0.1.1 portability section and fixed a version
  self-contradiction (now matches the English README).
- Added `CONTRIBUTING.md` and `SECURITY.md`.
- +10 tests (41 total): check exit codes, byte-dimension shrink-defer,
  never-allow for Edit/MultiEdit, non-positive-env fallback, and doctor
  exclusion / anchored-pointer / url-pointer / duplicate-slug.

## 0.1.1 — 2026-06-13

Added
- **Portability layer** so non-Claude-Code hosts (Hermes, Cursor, Cline, Codex, …)
  can use Engramory: `PORTING.md` — per-host wiring (always-on rules, riding the
  host's own memory store) + the size-cap degradation ladder.
- `tools/engramory_check.py` — standalone index-size check; the no-hard-hook
  degradation. Run it after writing the index; exit code 0/1/2 = OK/WARN/OVER.
- `tools/engramory_doctor.py` — consistency backstop: flags an over-cap index,
  broken index pointers, and orphan notes (forward-ref `[[wikilinks]]` = info).
- SKILL.md §9 (portability & degradation ladder); README porting guide.
- +10 tool tests (31 total).

## 0.1.0 — 2026-06-13

First experimental release, as **engramory** (renamed from the too-common "engram").

- Curated, file-based memory **discipline** — no DB, no vectors: a four-type
  ontology (`user | feedback | project | reference`), one-file-one-fact atomic
  notes, a pointer-only `MEMORY.md` index, and an enforced curation contract.
- PreToolUse hard-cap hook (`hooks/engramory_index_guard.py`): line + byte caps;
  denies only edits that GROW an over-cap index (shrinking/compaction always
  allowed); never auto-approves; sequential Edit/MultiEdit simulation; fail-safe
  on non-UTF-8 / malformed env. 21 tests.
- Honest positioning: a discipline layer on the markdown-memory pattern, not a new
  architecture. 0.1 / experimental — deterministic only on Claude Code.
- Hardened via an external Codex audit + a multi-agent adversarial verify pass.
