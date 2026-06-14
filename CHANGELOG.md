# Changelog

All notable changes to Engramory. Versions from 0.1.3 onward are git tags (0.1.0–
0.1.2 predate the 0.1.3 history consolidation). This is an experimental 0.x project
— expect rough edges off Claude Code (see SKILL.md §8 / §9).

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
