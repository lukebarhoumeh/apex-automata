# Wave 1 — Open PR adversarial review

> **Tracked location since 2026-05-14 (Wave 2 G7).** Previously at `atlas/var/tmp/monitor/` (gitignored).

**Repo:** `lukebarhoumeh/apex-automata`  
**Scope:** PRs **#16–#34** (19 open), read-only review, **2026-05-14**  
**Source plan:** `atlas/var/tmp/monitor/SPRINT-PLAN-FINAL.md` Wave 1 table (19 tasks (D9 + I4 are no-PR ops items))

---

## Risk rubric (this pass)

| Level | Meaning here |
|--------|----------------|
| **Critical** | Live/backtest correctness, order/position/risk paths, fee realism, RLS/migrations, CI gates that block strategy merges |
| **Medium** | Strategies/backtest wiring, position fanout, audit/CLI, workflows with secret/parse fragility |
| **Low** | Docs, templates, monitoring YAML, deletions with no runtime path |

---

## Executive verdict (per PR)

| PR | Title (short) | Risk | Verdict |
|----|----------------|------|---------|
| **34** | D10 position `position:updated` debounce | **Critical** | **Merge-ready** — strong event-order tests; accept **shutdown / `stopUpdateLoop` drops pending tail emit** as explicit tradeoff (DB may lag last intra-second mark if process dies mid-window). |
| **33** | F2 `recordTradeOutcome` from `BacktestEngine` | **Critical** | **Merge-ready after #24** — base branch is `wave1/f1-funnel-residuals-fix`; **`main` merge must serialize F1 → F2**. Swallowed MetaFilter telemetry failure is deliberate; confirm no caller assumes “outcome recorded” invariant for downstream control. |
| **24** | F1 bar-time (`nowMs`) through funnel | **Critical** | **Merge-ready with call-graph caveat** — defaults `nowMs = Date.now()` mean **any future internal callsite that omits `nowMs` in backtest revives the latch** (composition / maintenance hazard). Tests cover meta-filter / arbiter / processor slices, not the full engine surface. |
| **22** | E4 `audit-trades` CLI | **Medium** | **Merge-ready** — live run showing 18/18 dirty is **expected canary**, not CI failure mode; **`--help` uses `console.log` + `process.exit(0)`** (acceptable for CLI; still a second logging channel vs `Logger`). Audit rules assume specific FK/window semantics—**schema drift → false negatives** possible if writers change shape. |
| **30** | I3 backtest CI gate | **Medium** | **Needs hardening before you trust it** — enforcement is **reviewer convention** (branch protection off). **`grep '^Total Trades:' | awk '{print $3}'` couples to CLI stdout grammar** (format drift = false red). **`ENCRYPTION_KEY` all-zero fallback** safe only if literally nothing mutates crypto at import; verify after refactors. **Rollup unpack path pinned to `rollup@4.53.3` + pnpm layout** — version bump without workflow update → silent breakage. Gate **does not run on this PR itself** (path filter). Threshold **≥5 trades / 7d** is calibrated to **pre-F1 pathology**; **once F24 lands,_raise threshold** or gate becomes weak signal. |
| **21** | D5 RLS initplan migration | **Critical** (DB) | **Merge-ready as file-only** — author states **not applied live**; **deploy risk is Wave 2**. Assumes **only those 3 policies** still used raw `auth.uid()` / `auth.role()` on prod; **if `pg_policies` drifted, migration is incomplete** (partial win, not wrong-on-apply). |
| **20** | C1 Risk Desk math | **Critical** (UI truth) | **Merge-ready** — removes double-scaling and fake equity. **Composition:** consecutive-loss / streak UI now **only** via `/api/risk/status` (analytics path removed); if operators relied on richer analytics streaks, that’s a **behavior change**, not a bugfix. **503 on `/api/pnl` treated as null**; other 5xx still throw (good). |
| **16** | E1 Prometheus scrape | **Medium** | **Merge-ready** — runtime effect is **ops config + secrets**; failure mode is **scrape auth / host template** misconfig → blind flying, not engine crash. |
| **17** | D2 delete 7 Edge Functions | **Low** | **Merge-ready** — risk is **latent external callers** (mobile, old bookmarks, ops scripts); author’s grep narrative is plausible. **Verify** `src/test/sprint-1.7-edge-functions.test.ts` still valid on `main` after delete. |
| **18** | E2 log query runbook | **Low** | **Merge-ready** — dialect mismatch (BigQuery vs SQL editor) is documented; **zero runtime**. |
| **19** | D3 delete realtime bridge | **Low** | **Merge-ready** — zero-importer claim; **confirm** no dynamic import / lazy path. |
| **23** | C6 dashboard polish | **Medium** | **Merge-ready** — removes synthetic signal injection (**abuse case closed**). Deferred items (`engineVersion` pill, `PositionsTable` jitter) remain **honest falseness** in UI. |
| **25** | G1 `env.example` | **Low** | **Merge-ready** — doc drift risk if code adds env without updating example (ongoing). |
| **26** | G2 secret rotation | **Low** | **Merge-ready** — procedure accuracy depends on vendor UIs; not executable code. |
| **27** | G6 CLAUDE/AGENTS | **Low** | **Merge-ready** — plan said “after C2” for ML wording; this **anticipates** that. **Test counts** in docs will **lag** test growth (535+ after F1/F2 PRs) until next doc sweep. |
| **28** | H2 min trade / ATR | **Low** | **Merge-ready** — research only; **ATR “estimates”** can mis-rank symbols if taken as live gates. |
| **29** | H6 consec-loss quant | **Low** | **Merge-ready** — i.i.d. assumption **understates** clustered-loss reality; fine for **A4** input, bad as sole safety proof. |
| **31** | E6 backtest report archive | **Low** | **Merge-ready** — **local gzip** called out; no repo guarantee those gz exist for clones. |
| **32** | I5 PR template | **Low** | **Merge-ready** — checkboxes **do not enforce** anything (same class as I3). |

**Net:** **0 PRs** flagged “do not merge”; **2** (**#30**, **#24/#33 integration**) need **process / sequencing / threshold** attention more than code rewrites.

---

## Critical / Medium — adversarial findings (scenario-first)

### PR 34 — D10 debounce

- **Shutdown during an open burst:** `stopUpdateLoop` **cancels** pending debounced updates **without flushing** → Supabase / UI can end **one tick stale** vs last in-memory `marketPrice` if the process exits inside the 1s window. *Trigger: SIGTERM mid-burst.* **Mitigation:** accept (realtime cap > perfect final tick) or add optional `flushAllPendingPositionUpdates()` on graceful shutdown.
- **Time resolution vs `lastUpdateTime`:** `lastUpdateTime = new Date()` on every tick now reflects **wall clock**, not exchange event time—**cross-layer assumption** if anything correlates `lastUpdateTime` to bar time.

### PR 33 — F2 outcomes

- **Telemetry swallow chain:** `recordOutcomeToSignalProcessor` **logs + swallows** → MetaFilter can stay cold while backtest metrics think a trade closed. *Abuse:* plugin throws inside `recordTradeOutcome` — backtest **continues with silent filter desync** (by design; confirm observability enough).
- **Public `getSignalProcessor()`:** widens introspection surface for tests/future UI—**no auth boundary here**, but **future endpoints** must not expose raw processor without scoping.

### PR 24 — F1 `nowMs`

- **Partial propagation = silent revival of latch:** any **new** code path calling `filter` / `arbitrate` / `processSignal` without threading simulated time **reintroduces wall-clock coupling** with **no compile failure** (defaults hide it).
- **MetaFilter time-of-day rules:** moving “now” to `new Date(nowMs)` is correct for backtest, but **assumes `nowMs` matches bar timezone semantics** everywhere (DST / exchange session edges not covered by current tests).

### PR 30 — I3 gate

- **Composition with branch protection off:** a “green merge” culture slip **bypasses the entire gate**; parallel merge agent **can merge red** without technical friction.
- **Data availability:** `ETH-PERP-INTX` may have **sparse `bars`** — gate might pass on **spot-only** activity while **perps path is untested** (author acknowledges; still an assumption).
- **`date -u -d`** on Ubuntu is fine today; **portability** is not the goal but **forks/macOS runners** would break (low probability).

### PR 22 — E4 audit

- **Operational false confidence:** **`--strict` in nightly** with current DB drift → **persistent red** → alert fatigue → humans disable the check (**recovery-induced failure cascade**).
- **Windowing:** audits `trade_log.entry_time >= since` — **late-arriving/backfilled rows** outside assumption of “steady clock” could shift pass/fail run-to-run without writer bugs.

### PR 21 — D5 migration

- **Production `pg_policies` ≠ author snapshot:** migration **quietly skips** missing tables/policies in `DO` blocks—**you can “apply successfully” yet leave hotspots** if naming drifted.
- **Transaction wrapping:** whole migration `BEGIN … COMMIT` — **locks policy churn** briefly; acceptable at small scale but **ordering with concurrent DDL** still an ops assumption.

### PR 20 — C1 Risk UI

- **Heat / leverage display when equity null:** engine stopped → equity `--`, heat forced **0** even if **`/api/risk/status` still carries exposure**—**UX lie** vs risk reality during partial API failure modes (explicit product choice).

### PR 23 — C6

- **Signal starvation:** removing synthetic pulses exposes **Supabase/query slowness**—dashboard may look “dead” during incidents (**truthful but operationally alarming**).

---

## Cross-PR conflict prediction

| Files / hotspot | PRs | Conflict / sequencing |
|-----------------|-----|-------------------------|
| `atlas/apps/core-node/src/backtesting/backtest-engine.ts` | **#24**, **#33** | **Guaranteed textual conflict** if branches aren’t stacked; **intended stack: #33 onto #24** then **squash-merge order F1→F2→main**. |
| `CLAUDE.md` / `AGENTS.md` | **#27** (+ future doc PRs) | Low; only #27 touches in this wave. |
| `.github/workflows/*` | **#30**, **#32** | Disjoint paths (`workflows/` vs `PULL_REQUEST_TEMPLATE.md`) — **no conflict**. |
| `position-tracker.ts` vs debounce consumers | **#34** vs anything touching same emit semantics | Only #34 touches in this PR set — **clean**. |

---

## Residual Wave 1 gaps vs `SPRINT-PLAN-FINAL.md` §4 Wave 1 (19 tasks (D9 + I4 are no-PR ops items))

Wave-1 table items: **C1, C6, D2, D3, D5, D9, D10, E1, E2, E4, E6, F1, F2, G2, G6, H2, H6, I4, I5**.

**Mapped to open PRs:**  
C1=#20, C6=#23, D2=#17, D3=#19, D5=#21, D10=#34, E1=#16, E2=#18, E4=#22, E6=#31, F1=#24, F2=#33, G2=#26, G6=#27, H2=#28, H6=#29, I5=#32.

**Explicitly missing as an open PR (Wave 1 still open after this set merges):**

1. **D9 — Supabase budget / spend alert (~$50/mo)**  
   Dashboard/ops toggle; **no PR in #16–#34**.

2. **I4 — Branch protection on `main`**  
   **No PR** — intentionally replaced by ** convention + I5 template + partial substitute I3 (#30)** per PR bodies. Treat as **policy gap**, not forgetting: **CI can still merge red**.

**In-scope but adjacent (not part of Wave-1 enumerated 18 yet present):**

- **PR #25 (G1 `env.example`)** — aligns with **Wave 0 W0.5 G1**, not Wave-1 rows; valuable early merge.
- **PR #30 (I3)** — Wave-2 §I3 “pipeline review,” **pulled forward** vs Wave-1’s **I4** slot.

**Success-gate wording drift**

- Plan’s Wave-1 gate still says **“522/522 backend tests.”** Several PR descriptions cite **529 / 532 / 535** — **pure doc debt** unless someone pins CI to obsolete numbers.

---

## Testing / verification gaps worth a deliberate smoke pass

1. **`/risk`** with engine **stopped** and **running** — confirm drawdown `%` equals `/api/status` / `/api/pnl` fields (C1).
2. **Backtest CLI** on realistic Supabase **`bars` window post-F1** — confirm **`Total Trades` line format** unchanged (I3).
3. **Paper run telemetry** — `atlas_realtime_messages_used` trajectory (D10 author’s deferred checkbox).
4. **First PR touching strategies after I3 merges** — **first real CI exercise** of `backtest-gate.yml`.

---

## JSON machine summary (persona appendix)

```json
{
  "reviewer": "adversarial",
  "repo": "lukebarhoumeh/apex-automata",
  "prs_reviewed_open_count": 19,
  "findings": [
    {
      "title": "Merge ordering: PR 33 stacks on PR 24; naive merge loses F2 deltas or reintroduces conflicts",
      "severity": "operational",
      "prs": [24, 33],
      "evidence": [
        "PR 33 headRefName is wave1/f1-funnel-residuals-fix while PR 24 owns backtest-engine F1 edits",
        "Both modify backtest-engine.ts — textual overlap certain if rebased blindly"
      ],
      "autofix_class": "advisory",
      "owner": "human"
    },
    {
      "title": "CI gate brittle coupling: parses fixed 'Total Trades:' stdout tokens and assumes secrets + rollup shim path stability",
      "severity": "medium",
      "prs": [30],
      "evidence": [
        "Verify step uses grep/awk over stdout, not structured JSON artifact",
        "Rollup unpack targets hardcoded rollup@4.53.3 under atlas/node_modules/.pnpm"
      ],
      "autofix_class": "advisory",
      "owner": "human"
    },
    {
      "title": "Default-parameter hazard: optional nowMs=Date.now() hides missing threading on future strategy/backtest edits",
      "severity": "design",
      "prs": [24],
      "evidence": [
        "Any new internal callsite forgetting nowMs silently reverts to wall-clock in backtests"
      ],
      "autofix_class": "advisory",
      "owner": "human"
    },
    {
      "title": "Debounced emits cancelled on shutdown: last mark price may never reach observers/persistence when stopping inside debounce window",
      "severity": "low-med",
      "prs": [34],
      "evidence": [
        "stopUpdateLoop calls cancelPendingPositionUpdate for all symbols without flushing pending map"
      ],
      "autofix_class": "advisory",
      "owner": "human"
    },
    {
      "title": "Strict audit-trades in automation: chronic DB drift produces alert fatigue and risks disabling the canary",
      "severity": "operational",
      "prs": [22],
      "evidence": [
        "Author sample run: 0/18 clean on live — expected data issue, toxic if wired to paging without triage"
      ],
      "autofix_class": "advisory",
      "owner": "human"
    }
  ],
  "residual_risks": [
    "D9 and I4 absent from open PR set — billing alert + merge discipline still external",
    "Relying on grep-of-stdout CI gate until F1 threshold is re-tuned upward post-merge"
  ],
  "testing_gaps": [
    "I3 workflow not exercised by its own PR (path filters)",
    "End-to-backtest validation of signal counts post-F1 is deferred to operator F3/F4 runs per plan",
    "C1 lacks automated frontend assertion in this PR set — manual smoke only"
  ]
}
```
