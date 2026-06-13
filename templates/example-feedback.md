---
name: verify-before-done
description: Grep to confirm a change before reporting it done
type: feedback
created: 2026-06-13
updated: 2026-06-13
---

Before telling the user a code change is complete, run a quick search to confirm
the change actually landed where intended.

**Why:** the user has been burned before by "done" reports for edits that silently
failed to apply, so an unverified "done" costs their trust.

**How to apply:** after any edit, grep for the changed symbol/string and show the
matching line(s) in the report, or run the relevant test and quote the result.

Related: [[code-change-hygiene]]
