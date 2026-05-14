<!--
PR template per sprint plan task I5. Keep sections short. Delete any
section that does not apply, but do NOT delete the conditional checklist
boxes - leave them unticked so reviewers can see what was considered.
-->

## Summary

<!-- 1-3 sentences: what changed and why. Link the SPRINT-PLAN-FINAL task ID
     (e.g. "Closes A1") if applicable. -->

## Test plan

<!-- Bullet list of commands run + expected results.
     Backend: `cd atlas/apps/core-node && pnpm test` -> 38 files / 529 tests.
     Frontend: `pnpm lint && pnpm build`.
     Backtest changes: paste 1-line summary + a link to backtest_<ts>.json. -->

## Risk

<!-- One paragraph: blast radius if this is wrong. Rollback steps if
     non-trivial. For migrations, name the affected tables. -->

---

## Required acknowledgements

Tick every box that applies. **An unticked relevant box is a request for
changes — do not merge until ticked.**

### Strategy / params changes

- [ ] This PR touches `atlas/config/guardrails.yaml`,
      `atlas/apps/core-node/src/strategies/**`, or
      `atlas/apps/core-node/src/trading/**` — and either:
  - [ ] **Fee-impact analysis attached** (cite `docs/research/2026-05-14_min-trade-size-hl-fees.md`
        or attach a worked example showing expected per-trade EV at HL fees), or
  - [ ] N/A — change is mechanical / refactor only with no behavioural impact.

### Migrations / schema

- [ ] This PR touches `supabase/migrations/**` — and:
  - [ ] **Schema reviewed** by `code-reviewer` agent (or human equivalent),
        and the migration is idempotent (`IF NOT EXISTS` guards), and
  - [ ] If columns were dropped or types changed: a `pg_dump` snapshot was
        taken before applying, and a rollback migration is staged.

### Coinbase client internals (untouchable per CLAUDE.md)

- [ ] This PR touches `atlas/apps/core-node/src/exchanges/coinbase/{rest-client,websocket,index}.ts`
      — and:
  - [ ] **Explicit user approval recorded** in the PR description with the
        date and a quote of the approval text. CLAUDE.md says "Do NOT modify
        existing Coinbase client internals" — overriding it requires a
        person on the record.

### Test + standards baseline

- [ ] Backend tests still pass: `cd atlas/apps/core-node && pnpm test` is
      **38 files / 529 tests** or higher (zero failures, zero skipped that
      were previously passing).
- [ ] Frontend lint + build clean: `pnpm lint && pnpm build`.
- [ ] Conventional commit format on every commit (`feat:`, `fix:`,
      `docs:`, `chore:`, etc., with optional scope).
- [ ] PR scope is **a single task** per `atlas/var/tmp/monitor/SPRINT-PLAN-FINAL.md`.
      If you bundled multiple task IDs, split into separate PRs.

### CI gate

- [ ] If this PR triggered `backtest-gate` (any path under
      `strategies/`, `trading/`, `backtesting/`, or `guardrails.yaml`),
      that workflow is **green** in the Checks tab.
      Branch protection is OFF per locked sprint decision — this is
      enforcement-by-convention. Do not merge if the gate is red.
