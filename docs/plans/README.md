# docs/plans/

Sprint planning, phase status, adversarial reviews, closure checklists, and
related working research for Apex Automata / AtlasBot v2.

## Why this directory exists

Previously these docs lived in `atlas/var/tmp/monitor/`, which is excluded by
`atlas/.gitignore` (`var/**/*.md`). That meant edits made after the fact — for
example, correcting Wave 1's `522/522 -> 548/548` test count and the
`18 tasks -> 19 tasks` count — never shipped with the code that motivated
them. Moved into a tracked location on **2026-05-14** as Wave 2 task G7.

## Naming convention

| Pattern | Meaning |
|---|---|
| `SPRINT-PLAN-*.md` | Synthesized sprint plan (the canonical wave/task list) |
| `SPRINT-PHASE-STATUS-YYYY-MM-DD.md` | Phase status snapshot for that date |
| `WAVE*-CLOSURE-CHECKLIST-YYYY-MM-DD.md` | Operator runbook for closing a wave |
| `wave*-pr-adversarial-review.md` | Adversarial PR review for a wave |
| `<topic>-research.md` | Deep-research artifact tied to a sprint decision |
| `*-staging.md` | Pre-finalized draft of a planning doc |

## Convention

Updates to these docs live alongside the code changes they describe. When a
PR fixes a test count, task count, dependency note, etc., the corresponding
doc edit should be in the same PR (or a follow-up PR cross-referencing it).
Treat these as first-class artifacts, the same way as `CLAUDE.md` / `AGENTS.md`.
