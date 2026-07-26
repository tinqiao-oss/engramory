"""Regression tests for the P0 continuity protocol documented by the skill."""

import re
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


if __name__ == "__main__":
    unittest.main()
