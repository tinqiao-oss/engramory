"""Regression tests for the P0 continuity protocol documented by the skill."""

import re
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ContinuityProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        cls.rules = (ROOT / "rules-snippet.md").read_text(encoding="utf-8")
        cls.codex = (
            ROOT / "adapters" / "codex" / "README.md"
        ).read_text(encoding="utf-8")

    def test_skill_trigger_covers_recall_and_continuity_boundaries(self):
        frontmatter = self.skill.split("---", 2)[1].lower()
        self.assertIn("resuming unfinished work", frontmatter)
        self.assertIn("before compacting", frontmatter)
        self.assertIn("clearing context", frontmatter)
        self.assertIn("opening a fresh thread", frontmatter)

    def test_store_has_four_types_and_no_handoff_type(self):
        self.assertIn(
            "type: user | feedback | project | reference", self.skill)
        self.assertRegex(
            self.skill.lower(),
            r"do not create a second [\"“]?handoff[\"”]? memory type",
        )
        self.assertNotRegex(
            self.skill.lower(),
            r"type:\s*[^\n]*\|\s*handoff(?:\s|\|)",
        )

    def test_sync_order_and_cold_start_gate_are_explicit(self):
        sync = self.skill.split("### Unified continuity sync", 1)[1]
        sync = sync.split("\n---", 1)[0]
        expected = (
            "**Scan**",
            "**Dedup/update**",
            "**Project:**",
            "**Feedback:**",
            "**Reference:**",
            "**Retire:**",
            "**Validate:**",
            "**Cold-start test:**",
        )
        offsets = [sync.index(item) for item in expected]
        self.assertEqual(offsets, sorted(offsets))
        self.assertIn("archive/delete stale notes", sync)
        self.assertIn("completed transient project state", sync)
        self.assertIn("engramory_doctor.py", sync)

    def test_write_report_contract_names_every_category_and_size(self):
        sync = self.skill.split("### Unified continuity sync", 1)[1]
        report = sync.split("After any memory write or sync", 1)[1].split(
            "\n\n", 1
        )[0]
        for category in ("added", "updated", "archived", "skipped"):
            self.assertIn("**{}**".format(category), report)
        self.assertIn("with a reason", report)
        self.assertRegex(report, r"line/byte size")
        self.assertIn("check result", report)

    def test_project_and_feedback_lifecycles_remain_distinct(self):
        lower = self.skill.lower()
        self.assertIn(
            "only save a correction or workflow here if it is reusable", lower)
        for field in (
            "goals",
            "current status",
            "blockers",
            "next concrete step",
        ):
            self.assertIn(field, lower)
        self.assertIn("re-verify it on recall", lower)

    def test_always_loaded_rules_require_sync_before_new_thread(self):
        lower = self.rules.lower()
        self.assertIn("before a deliberate compact, clear, or new thread", lower)
        self.assertIn("cold-started", lower)
        for category in ("added", "updated", "archived", "skipped"):
            self.assertIn(category, lower)

    def test_codex_contract_blocks_only_known_manual_compaction(self):
        lower = re.sub(r"\s+", " ", self.codex.lower())
        self.assertIn("precompact", lower)
        self.assertIn("manual", lower)
        self.assertIn("automatic", lower)
        self.assertIn("fail open", lower)
        self.assertIn("needs_reconcile", lower)
        self.assertIn("/hooks", self.codex)
        self.assertIn("mark-synced", lower)
        self.assertIn(
            "does not run semantic curation, create a note, or modify memory content",
            lower,
        )


def _plain(text):
    """Markdown emphasis and line wrapping removed, so an assertion matches a sentence
    however the snippet happens to wrap or emphasise it."""
    return re.sub(r"\s+", " ", re.sub(r"[*`]+", "", text)).lower()


class ContinuityReachesEveryStandingSurfaceTests(unittest.TestCase):
    """The write-side rules must reach EVERY always-loaded surface, not just SKILL.md.

    0.6.x shipped a protocol change that landed in SKILL.md and never reached the
    per-host snippets, so the rule was absent from the only layer an agent actually
    sees on the turn it writes. A downstream team then removed the snippet entirely,
    rebuilt the store as type-named subdirectories with a dated state file per day,
    and reported the protocol as too heavy. These assertions are the regression net
    for that class of drift.

    Phrases are asserted whole rather than by keyword: "flat" and "subdirectories"
    both appear in a sentence that says the opposite, so a keyword pair proves
    nothing. The dsh plugin is NOT checked here — its rules are asserted against the
    registered skill content in adapters/dsh/plugin/test.js, which a comment or dead
    code cannot satisfy; test_dsh_surface_is_covered_by_the_node_suite keeps that
    coverage from quietly disappearing.
    """

    MARKDOWN_SURFACES = ("rules-snippet.md", "adapters/kiro/steering-engramory.md")

    def _surfaces(self):
        for rel in self.MARKDOWN_SURFACES:
            yield rel, _plain((ROOT / rel).read_text(encoding="utf-8"))

    def test_one_live_project_note_is_a_ceiling_not_a_quota(self):
        # "exactly one" would make a note mandatory for every unfinished task and
        # collide with "when nothing is worth keeping, write nothing".
        for rel, text in self._surfaces():
            with self.subTest(surface=rel):
                self.assertIn("at most one live project note", text)
                self.assertIn("in place", text)
                self.assertNotIn("exactly one live project note", text)

    def test_no_dated_snapshot_series_and_no_parallel_handoff_log(self):
        for rel, text in self._surfaces():
            with self.subTest(surface=rel):
                self.assertRegex(text, r"never (a dated series|accumulate snapshots)")
                self.assertRegex(text, r"never (index )?a second parallel handoff log")

    def test_active_layout_is_flat_without_disowning_archive(self):
        for rel, text in self._surfaces():
            with self.subTest(surface=rel):
                self.assertIn("active store is flat", text)
                self.assertRegex(text, r"not\s+subdirectories")
                # archive/ is part of the protocol; a flat claim must not erase it
                self.assertIn("archive/ is the one reserved subdirectory", text)

    def test_completion_checkpoint_is_a_judgement_scoped_to_this_task(self):
        for rel, text in self._surfaces():
            with self.subTest(surface=rel):
                self.assertIn("curation checkpoint", text)
                self.assertIn("judgement, not a write", text)
                self.assertRegex(text, r"write nothing and say so")
                # the checkpoint touches THIS task's note, never another task's
                self.assertRegex(text, r"(this task's|the current task)")
                # the ban is on logging INTO the store, not on scratch files at large
                self.assertIn("per-turn log to the store", text)
                # the anti-ritual clause: a downstream guard was satisfied by `touch`
                self.assertIn("timestamp is not a memory", text)

    def test_the_skill_is_the_authority_for_every_standing_rule(self):
        # A rule that lives only in a snippet forks the protocol from the spec the
        # snippet itself points at as authoritative.
        skill = _plain((ROOT / "SKILL.md").read_text(encoding="utf-8"))
        for phrase in (
            "at most one live project note",          # the ceiling, not just the words
            "never create a series of snapshot files",
            "archive/ # retired / superseded memories",  # the layout, incl. its exception
            "judgement, not a write",
            "never append a per-turn log to the store",
            "timestamp is not a memory",
        ):
            self.assertIn(phrase, skill)
        # and the completion trigger has to be discoverable by a relevance-loaded host
        frontmatter = _plain(
            (ROOT / "SKILL.md").read_text(encoding="utf-8").split("---", 2)[1])
        self.assertIn("when a task finishes", frontmatter)

    def test_read_only_snippet_states_layout_without_gaining_a_write_side(self):
        text = _plain((ROOT / "adapters" / "reader" / "reader-snippet.md").read_text(
            encoding="utf-8"))
        self.assertIn("active store is flat", text)
        self.assertIn("archive/ is the one reserved subdirectory", text)
        self.assertIn("never write here", text)
        self.assertNotIn("curation checkpoint", text)

    def test_dsh_surface_is_covered_by_the_node_suite(self):
        """The dsh rules are asserted in JS; keep that coverage from being deleted.

        Commenting the assertions out would defeat a plain substring search, so each
        one must also be on a line that is not commented.
        """
        lines = (ROOT / "adapters" / "dsh" / "plugin" / "test.js").read_text(
            encoding="utf-8").splitlines()
        live = [ln for ln in lines if not ln.lstrip().startswith("//")]
        for phrase in (
            "ACTIVE store is flat",
            "AT MOST ONE live `project` note",
            "never a second handoff log indexed beside it",
            "judgement, not a write",
            "per-turn log TO THE STORE",
        ):
            self.assertTrue(
                any(phrase in ln and "assert" in ln for ln in live),
                "no live assertion in adapters/dsh/plugin/test.js for: " + phrase)

    def test_no_standing_surface_is_left_unregistered(self):
        """A new host must be added to one of the lists above, not forgotten.

        The inventory comes from the installer's own host table rather than from a
        filename pattern: a wired host has to appear there or it cannot be installed
        at all, whereas a glob over `adapters/**/*.md` misses a `.mdc`, a
        `.clinerules`, or anything not named "snippet". Hand-copied templates that
        no host config points at are listed here explicitly.
        """
        sys.path.insert(0, str(ROOT / "tools"))
        try:
            import engramory_init
        finally:
            sys.path.pop(0)
        wired = {cfg.get("snippet", "rules-snippet.md")
                 for cfg in engramory_init.HOST_CONFIG.values()}
        hand_copied = {"adapters/kiro/steering-engramory.md"}  # no installer support yet
        known = set(self.MARKDOWN_SURFACES) | {
            "adapters/reader/reader-snippet.md",     # read-only: layout only
        }
        self.assertEqual(
            (wired | hand_copied) - known, set(),
            "standing-rules surface(s) no test covers; add them to MARKDOWN_SURFACES "
            "(write side) or to the known set (read-only side)")


class SetupRunbookTests(unittest.TestCase):
    """The runbook has to name two failures that are invisible from the outside."""

    @classmethod
    def setUpClass(cls):
        cls.setup = (ROOT / "AGENT-SETUP.md").read_text(encoding="utf-8")

    def test_fit_check_precedes_the_survey(self):
        self.assertIn("## Step 3b — Does the way they work fit a curated store?",
                      self.setup)
        lower = _plain(self.setup)
        self.assertIn("work log", lower)
        self.assertIn("one writer", lower)
        self.assertLess(self.setup.index("## Step 3b"), self.setup.index("## Step 4"))

    def test_missing_standing_rules_is_reported_on_its_own_line(self):
        # This lives inside Step 4's "half install" trap rather than in a step of its
        # own: Step 4 already owns present/configured/active/verified and the
        # deliberate-deviation rule, and a parallel section drifted from both.
        lower = _plain(self.setup)
        self.assertIn("a half install looks like a working one", lower)
        self.assertIn('never folded into "installed"', lower)
        self.assertIn("present but not active", lower)
        # a relevance-loaded skill can still reach a task: absent != never applies
        self.assertIn("no longer guaranteed", lower)
        self.assertNotIn("## step 5b", lower)


if __name__ == "__main__":
    unittest.main()
