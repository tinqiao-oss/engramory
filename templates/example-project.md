---
name: api-gateway-v2-status
description: API gateway v2 migration shipped — release 2.0
type: project
scope: repo
created: 2026-01-15
updated: 2026-01-15
---

The API gateway v2 migration reached final rollout and shipped on 2026-01-15 as
release 2.0. The original 2.0 roadmap item (request-level rate limiting) was
deferred to 2.1.

**Why:** the deferral was a deliberate scope decision, and neither the code nor
the git history records *why* rate limiting is absent from 2.0 — without this,
someone re-litigates it or files it as a bug.

**How to apply:** when rate limiting comes up, know it was deliberately deferred
out of 2.0 rather than forgotten. For the version to target now, ask the project's
version tool — this note deliberately does not carry that number, because it is
current state and would rot here (SKILL.md §2).

Related: [[deploy-runbook]] · [[release-versioning]]
