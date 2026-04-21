# Signals / Risk / Model Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build out the `/signals`, `/risk`, and `/model` pages per `design_handoff/pages/{03,04,05}-*.md`, following the Dashboard/Orders pattern (shadcn + Obsidian theme + TanStack Query + deterministic mock seeds).

**Architecture:** Each page gets (1) types in `src/types/{domain}.ts`, (2) a data hook module `src/hooks/apex/use{Domain}Data.ts` that queries deterministic seeds, (3) mock seeds in `src/hooks/apex/mock/seed-data.ts`, (4) visual components in `src/components/apex/{domain}/`, (5) a page file `src/pages/{Page}.tsx` that composes the components. One commit per page.

**Tech Stack:** React 18 + TypeScript + Vite + TanStack Query + Tailwind (Obsidian tokens) + shadcn/ui + Lucide icons. No new npm deps.

**Testing Strategy:** Visual components are verified by running the dev server on :8081 and checking each page renders with the expected panels and no console errors (consistent with how Dashboard/Orders shipped). No unit tests for visual layout.

---

## File Structure

**New types:**
- `src/types/risk.ts` — portfolio risk, radar axes, correlation, exposure tree, kill ladder, symbol caps
- `src/types/model.ts` — model meta, SHAP, inference, confusion matrix, calibration, training runs

**Extend existing types:**
- `src/types/strategy.ts` — add `StrategyConfig` (with params array) for Signals strategy-config cards
- (Signals reuses `SignalRecord`, `MarketRegime` already in `signals.ts`/`regime.ts`)

**New hooks:**
- `src/hooks/apex/useSignalsData.ts`
- `src/hooks/apex/useRiskData.ts`
- `src/hooks/apex/useModelData.ts`

**Extend seed data:**
- `src/hooks/apex/mock/seed-data.ts` — append `RISK_SEED`, `MODEL_SEED`, `STRATEGY_CONFIG_SEED`

**New components** (group by page):
- `src/components/apex/signals/`
  - `MetaModelHero.tsx` — ROC AUC + threshold slider + acceptance stats
  - `StrategyConfigCard.tsx` — per-strategy card with param sliders
  - `SignalStreamPanel.tsx` — filterable table with confidence bars
- `src/components/apex/risk/`
  - `RiskHero.tsx` — VaR + circuit breakers + kill switch
  - `RadarChart.tsx` — SVG radar (6 axes)
  - `CorrelationHeatmap.tsx` — SVG grid
  - `ExposureTree.tsx` — recursive nested list
  - `KillSwitchLadder.tsx` — 5-step escalation list
  - `SymbolCapsTable.tsx` — per-symbol notional caps
- `src/components/apex/model/`
  - `ModelHero.tsx` — ROC AUC display + fingerprint
  - `ShapWaterfall.tsx` — horizontal SHAP bars
  - `LiveInferencePanel.tsx` — scrolling list with mini-bars
  - `ConfusionMatrix.tsx` — 2x2 grid with counts
  - `CalibrationChart.tsx` — SVG reliability diagram
  - `TrainingRunsTable.tsx` — version history table

**Page files** (replace the stub `h1` with real composition):
- `src/pages/Signals.tsx`
- `src/pages/Risk.tsx`
- `src/pages/Model.tsx`

---

## Task 1 — Signals page

**Files:**
- Modify: `src/types/strategy.ts` (add `StrategyConfig`)
- Create: `src/hooks/apex/useSignalsData.ts`
- Modify: `src/hooks/apex/mock/seed-data.ts` (add `STRATEGY_CONFIG_SEED`, `META_MODEL_SEED`)
- Create: `src/components/apex/signals/MetaModelHero.tsx`
- Create: `src/components/apex/signals/StrategyConfigCard.tsx`
- Create: `src/components/apex/signals/SignalStreamPanel.tsx`
- Modify: `src/pages/Signals.tsx`

- [ ] **Step 1.1 — Add `StrategyConfig` and `MetaModel` types**

Append to `src/types/strategy.ts`:

```ts
export interface StrategyParam {
  key: string;
  label: string;
  val: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

export interface StrategyConfig {
  id: string;
  name: string;
  desc: string;
  kind: "trend" | "revert" | "ml";
  enabled: boolean;
  params: readonly StrategyParam[];
  stats: {
    winRate: number;
    avgR: number;
    trades: number;
    lastR: readonly number[];
  };
}

export interface MetaModelInfo {
  name: string;
  features: number;
  rocAuc: number;
  precision: number;
  recall: number;
  f1: number;
  threshold: number;
  trainedOn: number;
}
```

- [ ] **Step 1.2 — Seed `META_MODEL_SEED` and `STRATEGY_CONFIG_SEED`**

Append to `src/hooks/apex/mock/seed-data.ts`:

```ts
import type { StrategyConfig, MetaModelInfo } from "@/types/strategy";

export const META_MODEL_SEED: MetaModelInfo = {
  name: "xgb_v2.4 · 128 features",
  features: 128,
  rocAuc: 0.784,
  precision: 0.642,
  recall: 0.718,
  f1: 0.678,
  threshold: 0.65,
  trainedOn: 47_331,
};

export const STRATEGY_CONFIG_SEED: readonly StrategyConfig[] = [
  {
    id: "breakout",
    name: "Breakout + Volume",
    desc: "20-period Donchian breakout gated by ADX and volume",
    kind: "trend",
    enabled: true,
    params: [
      { key: "adxMin",    label: "ADX minimum",     val: 25, min: 15, max: 40, step: 1, format: (v) => `${v}` },
      { key: "donchianN", label: "Donchian period", val: 20, min: 10, max: 40, step: 1, format: (v) => `${v}` },
      { key: "atrPctile", label: "ATR pctile min",  val: 60, min: 30, max: 90, step: 5, format: (v) => `${v}` },
    ],
    stats: { winRate: 0.564, avgR: 1.42, trades: 48, lastR: [0.8, -1, 1.4, 2.1, -1, 0.9, 1.6, -1, 0.7, 2.2, 1.1, -1] },
  },
  {
    id: "vwap_mr",
    name: "VWAP Mean Reversion",
    desc: "Fade extreme deviations from VWAP in low-ADX regimes",
    kind: "revert",
    enabled: true,
    params: [
      { key: "zAbsMin", label: "|Z| minimum", val: 2.0, min: 1.5, max: 3.0, step: 0.1, format: (v) => `${v.toFixed(1)}σ` },
      { key: "adxMax",  label: "ADX maximum", val: 25,  min: 15,  max: 35,  step: 1,   format: (v) => `${v}` },
    ],
    stats: { winRate: 0.612, avgR: 0.82, trades: 63, lastR: [1.1, 0.8, -1, 1.3, 0.9, -1, 1.2, 0.7, -1, 1.1, 1.4, 0.6] },
  },
];
```

- [ ] **Step 1.3 — Write `useSignalsData.ts` hook**

Create `src/hooks/apex/useSignalsData.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import type { SignalRecord } from "@/types/signals";
import type { StrategyConfig, MetaModelInfo } from "@/types/strategy";
import { SIGNAL_SEED, STRATEGY_CONFIG_SEED, META_MODEL_SEED } from "./mock/seed-data";

export function useSignalStream() {
  return useQuery<readonly SignalRecord[]>({
    queryKey: ["apex", "signal-stream"],
    queryFn: () => Promise.resolve(SIGNAL_SEED),
    staleTime: 1_000,
  });
}

export function useStrategyConfigs() {
  return useQuery<readonly StrategyConfig[]>({
    queryKey: ["apex", "strategy-configs"],
    queryFn: () => Promise.resolve(STRATEGY_CONFIG_SEED),
    staleTime: 5_000,
  });
}

export function useMetaModel() {
  return useQuery<MetaModelInfo>({
    queryKey: ["apex", "meta-model"],
    queryFn: () => Promise.resolve(META_MODEL_SEED),
    staleTime: 30_000,
  });
}
```

- [ ] **Step 1.4 — Create `MetaModelHero.tsx`**

Create `src/components/apex/signals/MetaModelHero.tsx`:

```tsx
import { Brain } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Stat } from "@/components/apex/Stat";
import type { MetaModelInfo } from "@/types/strategy";
import type { SignalRecord } from "@/types/signals";

interface Props {
  meta: MetaModelInfo;
  signals: readonly SignalRecord[];
}

export function MetaModelHero({ meta, signals }: Props) {
  const accepted = signals.filter((s) => s.state === "ACCEPTED").length;
  const rejected = signals.filter((s) => s.state === "REJECTED").length;
  const acceptRate = signals.length > 0 ? accepted / signals.length : 0;

  return (
    <Panel header={false} pad={0} tone="accent" className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute opacity-60"
        style={{
          top: -80, right: -80, width: 280, height: 280, borderRadius: "50%",
          background: "radial-gradient(circle, hsl(var(--accent-glow)) 0%, transparent 70%)",
        }}
      />
      <div className="relative grid gap-6 p-6" style={{ gridTemplateColumns: "1.2fr 1fr 1fr" }}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-accent/15 text-accent ring-1 ring-accent/30">
              <Brain size={18} strokeWidth={1.6} />
            </div>
            <div className="flex flex-col">
              <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-accent">
                META MODEL · ML FILTER
              </span>
              <span className="text-[15px] font-medium text-fg-0">{meta.name}</span>
            </div>
          </div>
          <p className="max-w-[440px] text-[12.5px] leading-[1.55] text-fg-1">
            The meta model gates every signal across strategies. Trained on{" "}
            <span className="mono text-fg-0">{meta.trainedOn.toLocaleString()}</span> historical trades, ROC-AUC{" "}
            <span className="mono text-up">{meta.rocAuc.toFixed(2)}</span>. Raise the threshold for higher quality; lower for more volume.
          </p>
          <div className="mt-1 flex flex-wrap items-start gap-6">
            <Stat label="ROC AUC"    value={`${(meta.rocAuc * 100).toFixed(1)}%`}   tone="accent" />
            <Stat label="PRECISION"  value={`${(meta.precision * 100).toFixed(1)}%`} />
            <Stat label="RECALL"     value={`${(meta.recall * 100).toFixed(1)}%`} />
            <Stat label="F1"         value={`${(meta.f1 * 100).toFixed(1)}%`} />
          </div>
        </div>

        <div className="flex flex-col gap-3 border-l border-obsidian-line px-5">
          <div className="flex items-center justify-between">
            <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
              PROBABILITY THRESHOLD
            </span>
            <span className="mono text-[28px] font-medium text-accent" style={{ textShadow: "0 0 20px hsl(var(--accent-glow))" }}>
              {(meta.threshold * 100).toFixed(0)}%
            </span>
          </div>
          <div className="relative h-1 w-full rounded-full bg-obsidian-3">
            <div
              className="absolute left-0 top-0 h-full rounded-full bg-accent"
              style={{ width: `${((meta.threshold - 0.5) / 0.4) * 100}%`, boxShadow: "0 0 8px hsl(var(--accent-glow))" }}
            />
          </div>
          <div className="mono flex justify-between text-[9.5px] text-fg-3">
            <span>50% · volume</span>
            <span>70% · balanced</span>
            <span>90% · quality</span>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-l border-obsidian-line px-5">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            LAST 7 DAYS · ACCEPTANCE
          </span>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-obsidian-line bg-obsidian-2 p-3">
              <div className="mono text-[10px] uppercase text-fg-2">ACCEPTED</div>
              <div className="mono mt-1 text-[22px] font-medium text-up">{accepted}</div>
              <div className="text-[10px] text-fg-2">of {signals.length} signals</div>
            </div>
            <div className="rounded-lg border border-obsidian-line bg-obsidian-2 p-3">
              <div className="mono text-[10px] uppercase text-fg-2">REJECTED</div>
              <div className="mono mt-1 text-[22px] font-medium text-fg-1">{rejected}</div>
              <div className="text-[10px] text-fg-2">low confidence</div>
            </div>
          </div>
          <div>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="mono text-[10px] uppercase text-fg-2">ACCEPTANCE RATE</span>
              <span className="mono text-accent">{(acceptRate * 100).toFixed(1)}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-obsidian-3">
              <div className="h-full rounded-full bg-accent" style={{ width: `${acceptRate * 100}%`, boxShadow: "0 0 8px hsl(var(--accent-glow))" }} />
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}
```

- [ ] **Step 1.5 — Create `StrategyConfigCard.tsx`**

Create `src/components/apex/signals/StrategyConfigCard.tsx`:

```tsx
import { TrendingUp, Activity } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { cn } from "@/lib/utils";
import type { StrategyConfig } from "@/types/strategy";

interface Props {
  strat: StrategyConfig;
}

export function StrategyConfigCard({ strat }: Props) {
  const Icon = strat.kind === "trend" ? TrendingUp : Activity;
  const accentClass = strat.kind === "trend" ? "text-up bg-up/10 ring-up/20" : "text-warn bg-warn/10 ring-warn/20";

  return (
    <Panel header={false} pad={0} className={cn(strat.enabled ? "" : "opacity-60")}>
      <div className="flex items-center justify-between border-b border-obsidian-line px-4 py-3">
        <div className="flex items-center gap-3">
          <div className={cn("grid h-8 w-8 place-items-center rounded-md ring-1", accentClass)}>
            <Icon size={15} strokeWidth={1.6} />
          </div>
          <div className="flex flex-col">
            <span className="text-[13.5px] font-semibold text-fg-0">{strat.name}</span>
            <span className="text-[11px] text-fg-2">{strat.desc}</span>
          </div>
        </div>
        <span className={cn(
          "mono text-[10px] px-2 py-0.5 rounded-full border uppercase",
          strat.enabled ? "bg-up/10 text-up border-up/20" : "bg-obsidian-3 text-fg-2 border-obsidian-line-2",
        )}>
          {strat.enabled ? "ENABLED" : "DISABLED"}
        </span>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {strat.params.map((p) => (
          <div key={p.key}>
            <div className="mb-1.5 flex items-center justify-between text-[12px]">
              <span className="mono text-[10px] uppercase tracking-[0.12em] text-fg-2">{p.label}</span>
              <span className="mono text-[12px] text-fg-0">{p.format(p.val)}</span>
            </div>
            <div className="relative h-1 rounded-full bg-obsidian-3">
              <div
                className="absolute left-0 top-0 h-full rounded-full bg-accent"
                style={{ width: `${((p.val - p.min) / (p.max - p.min)) * 100}%` }}
              />
            </div>
            <div className="mono mt-1 flex justify-between text-[9.5px] text-fg-3">
              <span>{p.format(p.min)}</span>
              <span>{p.format(p.max)}</span>
            </div>
          </div>
        ))}

        <div className="border-t border-obsidian-line pt-3">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">WIN RATE</div>
              <div className="mono text-[17px] text-fg-0">{(strat.stats.winRate * 100).toFixed(1)}%</div>
            </div>
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">AVG R</div>
              <div className="mono text-[17px] text-up">{strat.stats.avgR.toFixed(2)}R</div>
            </div>
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">TRADES</div>
              <div className="mono text-[17px] text-fg-0">{strat.stats.trades}</div>
            </div>
          </div>
          <div className="mt-3">
            <div className="mono text-[10px] uppercase text-fg-2">LAST 12 R</div>
            <div className="mt-1 flex gap-1">
              {strat.stats.lastR.map((r, i) => (
                <div
                  key={i}
                  className={cn("h-3 w-3 rounded-sm", r > 0 ? "bg-up" : "bg-down")}
                  style={{ opacity: 0.4 + Math.min(Math.abs(r), 2.5) / 3 }}
                  title={`${r.toFixed(2)}R`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}
```

- [ ] **Step 1.6 — Create `SignalStreamPanel.tsx`**

Create `src/components/apex/signals/SignalStreamPanel.tsx`:

```tsx
import { useState, useMemo } from "react";
import { Pill } from "@/components/apex/Pill";
import { Panel } from "@/components/apex/Panel";
import { Segmented } from "@/components/apex/Segmented";
import { cn } from "@/lib/utils";
import type { SignalRecord, SignalState } from "@/types/signals";

interface Props {
  signals: readonly SignalRecord[];
  threshold: number;
}

type Filter = "ALL" | SignalState;

const FILTER_OPTIONS = [
  { value: "ALL" as const,       label: "ALL" },
  { value: "ACCEPTED" as const,  label: "ACCEPTED" },
  { value: "REJECTED" as const,  label: "REJECTED" },
  { value: "CANCELLED" as const, label: "CANCEL" },
];

export function SignalStreamPanel({ signals, threshold }: Props) {
  const [filter, setFilter] = useState<Filter>("ALL");

  const filtered = useMemo(
    () => (filter === "ALL" ? signals : signals.filter((s) => s.state === filter)),
    [signals, filter],
  );

  return (
    <Panel header={false} pad={0}>
      <div className="flex items-center justify-between border-b border-obsidian-line px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_0_2px_hsl(var(--accent)/0.25)]" />
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">SIGNAL STREAM · LIVE</span>
        </div>
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={FILTER_OPTIONS}
        />
      </div>
      <div className="max-h-[480px] overflow-y-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-obsidian-line">
              {["TIME", "SYMBOL", "STRATEGY", "SIDE", "CONFIDENCE", "Z", "ADX", "NOTE", "STATE"].map((h) => (
                <th key={h} className="mono px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.1em] text-fg-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id} className="border-b border-obsidian-line/60 hover:bg-obsidian-2/60">
                <td className="mono px-3 py-2 text-[11px] text-fg-2">{s.ts}</td>
                <td className="px-3 py-2 text-[12.5px] font-medium text-fg-0">{s.sym}</td>
                <td className="mono px-3 py-2 text-[11px] text-fg-1">{s.strat}</td>
                <td className="px-3 py-2">
                  <Pill tone={s.side === "BUY" ? "up" : "down"}>{s.side}</Pill>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="relative h-1 w-[60px] rounded-full bg-obsidian-3">
                      <div
                        className={cn("absolute left-0 top-0 h-full rounded-full", s.conf >= threshold ? "bg-accent" : "bg-fg-2")}
                        style={{ width: `${s.conf * 100}%`, boxShadow: s.conf >= threshold ? "0 0 6px hsl(var(--accent-glow))" : undefined }}
                      />
                      <div
                        className="absolute top-[-2px] h-2 w-px bg-fg-2"
                        style={{ left: `${threshold * 100}%` }}
                      />
                    </div>
                    <span className={cn("mono text-[11px]", s.conf >= threshold ? "text-accent" : "text-fg-2")}>
                      {(s.conf * 100).toFixed(0)}%
                    </span>
                  </div>
                </td>
                <td className="mono px-3 py-2 text-right text-[11px] text-fg-1">{s.z != null ? s.z.toFixed(2) : "—"}</td>
                <td className="mono px-3 py-2 text-right text-[11px] text-fg-1">{s.adx ?? "—"}</td>
                <td className="px-3 py-2 text-[11px] text-fg-2">{s.note}</td>
                <td className="px-3 py-2">
                  <Pill tone={s.state === "ACCEPTED" ? "up" : s.state === "REJECTED" ? "default" : "warn"}>
                    {s.state}
                  </Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
```

- [ ] **Step 1.7 — Inspect `Segmented` to confirm props match**

Before using, open `src/components/apex/Segmented.tsx` and verify the `value` / `onChange` / `options` shape matches what the panel imports. If the existing implementation uses `{ v, l }` instead of `{ value, label }`, adapt the panel's `FILTER_OPTIONS`.

- [ ] **Step 1.8 — Assemble `Signals.tsx`**

Replace `src/pages/Signals.tsx`:

```tsx
import { MetaModelHero } from "@/components/apex/signals/MetaModelHero";
import { StrategyConfigCard } from "@/components/apex/signals/StrategyConfigCard";
import { SignalStreamPanel } from "@/components/apex/signals/SignalStreamPanel";
import {
  useMetaModel,
  useSignalStream,
  useStrategyConfigs,
} from "@/hooks/apex/useSignalsData";

export default function Signals() {
  const meta = useMetaModel();
  const signals = useSignalStream();
  const strategies = useStrategyConfigs();

  if (!meta.data || !signals.data || !strategies.data) return null;

  return (
    <div className="flex flex-col gap-4 p-6">
      <MetaModelHero meta={meta.data} signals={signals.data} />
      <div className="grid gap-4 md:grid-cols-2">
        {strategies.data.map((s) => (
          <StrategyConfigCard key={s.id} strat={s} />
        ))}
      </div>
      <SignalStreamPanel signals={signals.data} threshold={meta.data.threshold} />
    </div>
  );
}
```

- [ ] **Step 1.9 — Verify in dev server**

Run `pnpm dev` (server runs on `http://localhost:8081`). Navigate to `/signals`. Expected:
- Meta-model hero with ROC AUC, threshold 65%, acceptance stats.
- Two strategy config cards (Breakout + VWAP MR).
- Signal stream table with 10 rows, filter segmented above.
- No console errors.

If `tsc` errors surface, fix them before moving on.

- [ ] **Step 1.10 — Commit**

```bash
git add src/types/strategy.ts src/hooks/apex/useSignalsData.ts src/hooks/apex/mock/seed-data.ts src/components/apex/signals/ src/pages/Signals.tsx
git commit -m "Phase 1: Signals — meta-model hero / strategy configs / signal stream"
```

---

## Task 2 — Risk page

**Files:**
- Create: `src/types/risk.ts`
- Modify: `src/hooks/apex/mock/seed-data.ts` (add `RISK_SEED`)
- Create: `src/hooks/apex/useRiskData.ts`
- Create: `src/components/apex/risk/RiskHero.tsx`
- Create: `src/components/apex/risk/RadarChart.tsx`
- Create: `src/components/apex/risk/CorrelationHeatmap.tsx`
- Create: `src/components/apex/risk/ExposureTree.tsx`
- Create: `src/components/apex/risk/KillSwitchLadder.tsx`
- Create: `src/components/apex/risk/SymbolCapsTable.tsx`
- Modify: `src/pages/Risk.tsx`

- [ ] **Step 2.1 — Create `src/types/risk.ts`**

```ts
export interface PortfolioRisk {
  equity: number;
  exposure: number;
  heat: number;
  heatCap: number;
  dd: number;
  ddCap: number;
  var95: number;
  var99: number;
  expectedShortfall: number;
  consecLosses: number;
  consecCap: number;
  netBeta: number;
}

export interface RiskRadarAxis {
  k: string;
  v: number;
}

export interface SymbolCap {
  s: string;
  used: number;
  cap: number;
  pct: number;
}

export interface ExposureNode {
  label: string;
  value: number;
  children?: readonly ExposureNode[];
}

export interface KillLadderRow {
  lvl: number;
  at: string;
  action: string;
  tripped: boolean;
}

export interface RiskData {
  portfolio: PortfolioRisk;
  symbolCaps: readonly SymbolCap[];
  radar: readonly RiskRadarAxis[];
  corr: readonly (readonly number[])[];
  corrLabels: readonly string[];
  tree: ExposureNode;
  killLadder: readonly KillLadderRow[];
}
```

- [ ] **Step 2.2 — Append `RISK_SEED` to `seed-data.ts`**

```ts
import type { RiskData } from "@/types/risk";

export const RISK_SEED: RiskData = {
  portfolio: {
    equity: 124_382.11,
    exposure: 38_220.00,
    heat: 1.82, heatCap: 3.0,
    dd: 2.1, ddCap: 8.0,
    var95: 1_840, var99: 3_120,
    expectedShortfall: 4_280,
    consecLosses: 1, consecCap: 5,
    netBeta: 0.72,
  },
  symbolCaps: [
    { s: "BTC-USD",  used: 14_200, cap: 30_000, pct: 47.3 },
    { s: "ETH-USD",  used:  9_800, cap: 20_000, pct: 49.0 },
    { s: "SOL-USD",  used:  6_420, cap: 10_000, pct: 64.2 },
    { s: "AVAX-USD", used:  3_100, cap: 10_000, pct: 31.0 },
    { s: "LINK-USD", used:  2_700, cap:  8_000, pct: 33.8 },
    { s: "ARB-USD",  used:  2_000, cap:  8_000, pct: 25.0 },
  ],
  radar: [
    { k: "Concentration", v: 54 },
    { k: "Volatility",    v: 68 },
    { k: "Drawdown",      v: 26 },
    { k: "Correlation",   v: 72 },
    { k: "Leverage",      v: 18 },
    { k: "Liquidity",     v: 35 },
  ],
  corr: [
    [1.00, 0.86, 0.79, 0.72, 0.63, 0.68],
    [0.86, 1.00, 0.82, 0.77, 0.69, 0.74],
    [0.79, 0.82, 1.00, 0.88, 0.64, 0.72],
    [0.72, 0.77, 0.88, 1.00, 0.61, 0.70],
    [0.63, 0.69, 0.64, 0.61, 1.00, 0.58],
    [0.68, 0.74, 0.72, 0.70, 0.58, 1.00],
  ],
  corrLabels: ["BTC", "ETH", "SOL", "AVAX", "LINK", "ARB"],
  tree: {
    label: "Portfolio", value: 38_220, children: [
      { label: "Crypto · Spot", value: 34_500, children: [
        { label: "Majors", value: 24_000, children: [
          { label: "BTC-USD", value: 14_200 },
          { label: "ETH-USD", value:  9_800 },
        ]},
        { label: "L1 Alts", value: 9_520, children: [
          { label: "SOL-USD",  value: 6_420 },
          { label: "AVAX-USD", value: 3_100 },
        ]},
        { label: "L2/Oracle", value: 4_700, children: [
          { label: "LINK-USD", value: 2_700 },
          { label: "ARB-USD",  value: 2_000 },
        ]},
      ]},
      { label: "Reserves · Cash", value: 86_162 },
    ],
  },
  killLadder: [
    { lvl: 1, at: "DD > 3%",          action: "Reduce new size 50%",  tripped: false },
    { lvl: 2, at: "DD > 5%",          action: "No new entries",        tripped: false },
    { lvl: 3, at: "3 consec losses",  action: "Pause strategy",        tripped: false },
    { lvl: 4, at: "DD > 8%",          action: "Flatten all positions", tripped: false },
    { lvl: 5, at: "Venue rejects x5", action: "Cold shutdown + page",  tripped: false },
  ],
};
```

- [ ] **Step 2.3 — Create `useRiskData.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import type { RiskData } from "@/types/risk";
import { RISK_SEED } from "./mock/seed-data";

export function useRiskData() {
  return useQuery<RiskData>({
    queryKey: ["apex", "risk-data"],
    queryFn: () => Promise.resolve(RISK_SEED),
    staleTime: 5_000,
  });
}
```

- [ ] **Step 2.4 — Create `RadarChart.tsx`**

```tsx
import type { RiskRadarAxis } from "@/types/risk";

interface Props {
  axes: readonly RiskRadarAxis[];
  size?: number;
}

export function RadarChart({ axes, size = 280 }: Props) {
  const n = axes.length;
  const cx = size / 2;
  const cy = size / 2;
  const rMax = size / 2 - 30;
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i: number, v: number): [number, number] => [
    cx + Math.cos(angle(i)) * rMax * (v / 100),
    cy + Math.sin(angle(i)) * rMax * (v / 100),
  ];
  const rings = [0.25, 0.5, 0.75, 1];
  const dataPath = axes
    .map((a, i) => pt(i, a.v))
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ") + " Z";

  return (
    <svg width={size} height={size} className="block">
      {rings.map((r) => (
        <polygon
          key={r}
          points={axes.map((_, i) => {
            const [x, y] = [cx + Math.cos(angle(i)) * rMax * r, cy + Math.sin(angle(i)) * rMax * r];
            return `${x},${y}`;
          }).join(" ")}
          fill="none"
          stroke="hsl(var(--obsidian-line))"
          strokeDasharray={r === 1 ? "" : "2 4"}
        />
      ))}
      {axes.map((_, i) => {
        const [x, y] = pt(i, 100);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="hsl(var(--obsidian-line))" strokeWidth="0.8" />;
      })}
      <path
        d={dataPath}
        fill="hsl(var(--down))"
        fillOpacity="0.13"
        stroke="hsl(var(--down))"
        strokeWidth="1.5"
        style={{ filter: "drop-shadow(0 0 6px hsl(var(--down) / 0.45))" }}
      />
      {axes.map((a, i) => {
        const [x, y] = pt(i, a.v);
        return <circle key={i} cx={x} cy={y} r="3" fill="hsl(var(--down))" />;
      })}
      {axes.map((a, i) => {
        const [x, y] = [cx + Math.cos(angle(i)) * (rMax + 18), cy + Math.sin(angle(i)) * (rMax + 18)];
        return (
          <text
            key={i}
            x={x}
            y={y}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="10.5"
            fontFamily="var(--font-mono, ui-monospace)"
            fill="hsl(var(--fg-1))"
          >
            {a.k.toUpperCase()}
          </text>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 2.5 — Create `CorrelationHeatmap.tsx`**

```tsx
import { useState } from "react";

interface Props {
  labels: readonly string[];
  matrix: readonly (readonly number[])[];
}

function color(v: number): string {
  if (v > 0) return `rgba(255, 90, 106, ${0.15 + v * 0.7})`;
  const t = Math.abs(v);
  return `rgba(59, 130, 246, ${0.15 + t * 0.7})`;
}

export function CorrelationHeatmap({ labels, matrix }: Props) {
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const cellSize = 48;
  const padL = 40;
  const padT = 18;
  const n = labels.length;

  return (
    <div className="flex flex-col gap-2">
      <svg
        width={padL + n * cellSize + 10}
        height={padT + n * cellSize + 10}
        className="block"
        onMouseLeave={() => setHover(null)}
      >
        {labels.map((l, i) => (
          <text
            key={`c${i}`}
            x={padL + i * cellSize + cellSize / 2}
            y={12}
            textAnchor="middle"
            fontSize="10"
            fontFamily="var(--font-mono, ui-monospace)"
            fill="hsl(var(--fg-2))"
          >
            {l}
          </text>
        ))}
        {labels.map((l, i) => (
          <text
            key={`r${i}`}
            x={padL - 6}
            y={padT + i * cellSize + cellSize / 2 + 3}
            textAnchor="end"
            fontSize="10"
            fontFamily="var(--font-mono, ui-monospace)"
            fill="hsl(var(--fg-2))"
          >
            {l}
          </text>
        ))}
        {matrix.map((row, i) =>
          row.map((v, j) => (
            <g key={`${i}-${j}`} onMouseEnter={() => setHover({ i, j })}>
              <rect
                x={padL + j * cellSize}
                y={padT + i * cellSize}
                width={cellSize - 2}
                height={cellSize - 2}
                fill={color(v)}
                rx="3"
                stroke={i === j ? "hsl(var(--accent))" : "transparent"}
                strokeWidth="1"
              />
              <text
                x={padL + j * cellSize + cellSize / 2}
                y={padT + i * cellSize + cellSize / 2 + 4}
                textAnchor="middle"
                fontSize="10"
                fontFamily="var(--font-mono, ui-monospace)"
                fill={Math.abs(v) > 0.5 ? "white" : "hsl(var(--fg-1))"}
                fontWeight={i === j ? 600 : 500}
              >
                {v.toFixed(2)}
              </text>
            </g>
          )),
        )}
      </svg>
      {hover && (
        <div className="mono text-[11px] text-fg-2">
          {labels[hover.i]} × {labels[hover.j]} = {matrix[hover.i][hover.j].toFixed(2)}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2.6 — Create `ExposureTree.tsx`**

```tsx
import type { ExposureNode } from "@/types/risk";

interface Props {
  node: ExposureNode;
  depth?: number;
  maxVal: number;
  parentVal?: number;
}

const COLORS = ["bg-accent", "bg-accent-2", "bg-up", "bg-warn"] as const;

export function ExposureTree({ node, depth = 0, maxVal, parentVal }: Props) {
  const pct = parentVal ? (node.value / parentVal) * 100 : (node.value / maxVal) * 100;
  const barClass = COLORS[depth % COLORS.length];
  const opacity = Math.min(1, 0.45 + depth * 0.15);

  return (
    <div>
      <div
        className="grid items-center gap-3 py-1.5"
        style={{ gridTemplateColumns: `${depth * 16 + 160}px 1fr 96px` }}
      >
        <div
          className="truncate text-[12.5px]"
          style={{ paddingLeft: depth * 16, fontWeight: depth === 0 ? 600 : 400, color: depth === 0 ? "hsl(var(--fg-0))" : "hsl(var(--fg-1))" }}
        >
          {depth > 0 && <span className="mr-1.5 text-fg-3">└</span>}
          {node.label}
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-obsidian-3">
          <div className={`h-full rounded-full ${barClass}`} style={{ width: `${pct}%`, opacity }} />
        </div>
        <div className="mono text-right text-[12px] text-fg-0">
          ${node.value.toLocaleString()}
        </div>
      </div>
      {node.children?.map((c, i) => (
        <ExposureTree key={`${c.label}-${i}`} node={c} depth={depth + 1} maxVal={maxVal} parentVal={node.value} />
      ))}
    </div>
  );
}
```

- [ ] **Step 2.7 — Create `KillSwitchLadder.tsx`**

```tsx
import { AlertTriangle } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { KillLadderRow } from "@/types/risk";

interface Props {
  rows: readonly KillLadderRow[];
}

export function KillSwitchLadder({ rows }: Props) {
  return (
    <Panel header={false} pad={0}>
      <div className="flex items-center justify-between border-b border-obsidian-line px-4 py-3">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-warn" strokeWidth={1.6} />
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            KILL-SWITCH LADDER
          </span>
        </div>
        <span className="mono text-[10px] uppercase text-fg-2">{rows.length} RULES</span>
      </div>
      <div>
        {rows.map((k, i) => (
          <div
            key={k.lvl}
            className={cn(
              "grid items-center gap-3 px-4 py-3",
              i < rows.length - 1 && "border-b border-obsidian-line",
            )}
            style={{ gridTemplateColumns: "32px 1fr auto" }}
          >
            <div
              className={cn(
                "grid h-7 w-7 place-items-center rounded-full border font-mono text-[12px] font-semibold",
                k.tripped
                  ? "border-down bg-down/15 text-down"
                  : "border-obsidian-line-2 bg-obsidian-2 text-fg-1",
              )}
            >
              {k.lvl}
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium text-fg-0">{k.action}</span>
              <span className="mono text-[11px] text-fg-2">{k.at}</span>
            </div>
            <Pill tone={k.tripped ? "down" : "default"}>{k.tripped ? "TRIPPED" : "ARMED"}</Pill>
          </div>
        ))}
      </div>
    </Panel>
  );
}
```

- [ ] **Step 2.8 — Create `SymbolCapsTable.tsx`**

```tsx
import { Shield } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { SymbolCap } from "@/types/risk";

interface Props {
  caps: readonly SymbolCap[];
}

export function SymbolCapsTable({ caps }: Props) {
  return (
    <Panel header={false} pad={0}>
      <div className="flex items-center justify-between border-b border-obsidian-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Shield size={14} className="text-up" strokeWidth={1.6} />
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            PER-SYMBOL EXPOSURE CAPS
          </span>
        </div>
      </div>
      <table className="w-full">
        <thead>
          <tr className="border-b border-obsidian-line">
            {["SYMBOL", "USED", "CAP", "UTILIZATION", "%", "STATUS"].map((h) => (
              <th
                key={h}
                className="mono px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.1em] text-fg-2"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {caps.map((c) => {
            const barTone = c.pct > 70 ? "bg-warn" : c.pct > 50 ? "bg-accent" : "bg-up";
            const high = c.pct > 70;
            return (
              <tr key={c.s} className="border-b border-obsidian-line/60">
                <td className="px-3 py-2 text-[12.5px] font-medium text-fg-0">{c.s}</td>
                <td className="mono px-3 py-2 text-[11.5px]">${c.used.toLocaleString()}</td>
                <td className="mono px-3 py-2 text-[11.5px] text-fg-2">${c.cap.toLocaleString()}</td>
                <td className="px-3 py-2" style={{ width: "40%" }}>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-obsidian-3">
                    <div className={cn("h-full rounded-full", barTone)} style={{ width: `${c.pct}%` }} />
                  </div>
                </td>
                <td className={cn("mono px-3 py-2 text-right text-[11.5px]", high ? "text-warn" : "text-fg-0")}>
                  {c.pct.toFixed(1)}%
                </td>
                <td className="px-3 py-2">
                  <Pill tone={high ? "warn" : "default"}>{high ? "HIGH" : "OK"}</Pill>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
```

- [ ] **Step 2.9 — Create `RiskHero.tsx`**

```tsx
import { Power } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { PortfolioRisk, KillLadderRow } from "@/types/risk";

interface Props {
  portfolio: PortfolioRisk;
  killLadder: readonly KillLadderRow[];
}

function CircuitBar({ label, v, cap, unit, tone }: { label: string; v: number; cap: number; unit: string; tone: string }) {
  const pct = Math.min(100, (v / cap) * 100);
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-[11px]">
        <span className="mono text-[10px] uppercase tracking-[0.12em] text-fg-2">{label}</span>
        <span className="mono text-[11px]">
          <span className="text-fg-0">{v.toFixed(1)}{unit}</span>
          <span className="text-fg-3"> / {cap}{unit}</span>
        </span>
      </div>
      <div className="h-[5px] w-full overflow-hidden rounded-full bg-obsidian-3">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function RiskHero({ portfolio, killLadder }: Props) {
  const tripped = killLadder.filter((l) => l.tripped).length;

  return (
    <Panel header={false} pad={0} className="relative overflow-hidden" tone="default">
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          background:
            "linear-gradient(135deg, hsl(var(--obsidian-1)) 0%, #0d121c 60%, hsl(var(--obsidian-1)) 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute"
        style={{
          top: -120, right: -120, width: 360, height: 360, borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255,90,106,0.16) 0%, transparent 70%)",
        }}
      />
      <div className="relative grid gap-7 p-7" style={{ gridTemplateColumns: "1.1fr 1fr 1fr" }}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Pill tone="down" dot>RISK DESK</Pill>
            <Pill tone="default">ARMED · {tripped}/5 TRIPPED</Pill>
          </div>
          <div className="serif-ital text-fg-0" style={{ fontSize: 40, lineHeight: 1.05, fontWeight: 500, letterSpacing: "-0.02em" }}>
            <span className="text-down">Risk is what</span><br />
            we <span className="text-fg-1">refuse to take.</span>
          </div>
          <p className="max-w-[380px] text-[12.5px] leading-[1.55] text-fg-1">
            Exposure <span className="mono text-fg-0">${portfolio.exposure.toLocaleString()}</span> on{" "}
            <span className="mono text-fg-0">${portfolio.equity.toLocaleString()}</span> equity. Heat at{" "}
            <span className="mono text-accent">{portfolio.heat.toFixed(2)}%</span>, drawdown{" "}
            <span className="mono text-up">{portfolio.dd.toFixed(1)}%</span>.
          </p>
          <div className="flex gap-2">
            <button className="inline-flex items-center gap-1.5 rounded-md border border-down/40 bg-down/10 px-3 py-1.5 text-[12px] font-medium text-down hover:bg-down/20">
              <Power size={12} /> KILL ALL
            </button>
            <button className="inline-flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-2 px-3 py-1.5 text-[12px] text-fg-1 hover:bg-obsidian-3">
              Edit limits
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-l border-obsidian-line px-6">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">VaR · 95% · 99%</span>
          <div>
            <div className="mono text-[36px] font-medium text-down" style={{ textShadow: "0 0 24px rgba(255,90,106,0.25)" }}>
              -${portfolio.var95.toLocaleString()}
            </div>
            <div className="mono mt-0.5 text-[10px] uppercase text-fg-2">1-DAY 95% VaR</div>
          </div>
          <div className="flex gap-5">
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">99% VaR</div>
              <div className="mono text-[15px] text-down">-${portfolio.var99.toLocaleString()}</div>
            </div>
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">EXP. SHORTFALL</div>
              <div className="mono text-[15px] text-down">-${portfolio.expectedShortfall.toLocaleString()}</div>
            </div>
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">NET BETA</div>
              <div className="mono text-[15px] text-fg-0">{portfolio.netBeta.toFixed(2)}</div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-l border-obsidian-line px-6">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">CIRCUIT BREAKERS</span>
          <CircuitBar label="Portfolio Heat" v={portfolio.heat} cap={portfolio.heatCap} unit="%" tone="bg-accent" />
          <CircuitBar label="Drawdown" v={portfolio.dd} cap={portfolio.ddCap} unit="%" tone="bg-warn" />
          <CircuitBar label="Consec Losses" v={portfolio.consecLosses} cap={portfolio.consecCap} unit="" tone="bg-down" />
        </div>
      </div>
    </Panel>
  );
}
```

- [ ] **Step 2.10 — Assemble `Risk.tsx`**

```tsx
import { Target, Layers } from "lucide-react";
import { RiskHero } from "@/components/apex/risk/RiskHero";
import { RadarChart } from "@/components/apex/risk/RadarChart";
import { CorrelationHeatmap } from "@/components/apex/risk/CorrelationHeatmap";
import { ExposureTree } from "@/components/apex/risk/ExposureTree";
import { KillSwitchLadder } from "@/components/apex/risk/KillSwitchLadder";
import { SymbolCapsTable } from "@/components/apex/risk/SymbolCapsTable";
import { Panel } from "@/components/apex/Panel";
import { useRiskData } from "@/hooks/apex/useRiskData";

export default function Risk() {
  const risk = useRiskData();
  if (!risk.data) return null;
  const R = risk.data;
  const radarComposite = Math.round(R.radar.reduce((s, r) => s + r.v, 0) / R.radar.length);
  const treeTotal = R.tree.value + 86_162;

  return (
    <div className="flex flex-col gap-4 p-6">
      <RiskHero portfolio={R.portfolio} killLadder={R.killLadder} />

      <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1.1fr" }}>
        <Panel
          header
          pad={20}
          title="RISK RADAR"
          right={
            <span className="mono text-[10px] rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 uppercase text-warn">
              COMPOSITE {radarComposite}
            </span>
          }
        >
          <div className="grid items-center gap-5" style={{ gridTemplateColumns: "1fr auto" }}>
            <RadarChart axes={R.radar} size={280} />
            <div className="flex min-w-[160px] flex-col gap-2">
              {R.radar.map((a) => (
                <div key={a.k}>
                  <div className="mb-0.5 flex justify-between">
                    <span className="mono text-[10px] uppercase text-fg-2">{a.k}</span>
                    <span className={`mono text-[11px] ${a.v > 60 ? "text-warn" : a.v > 40 ? "text-accent" : "text-up"}`}>{a.v}</span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-obsidian-3">
                    <div
                      className={`h-full rounded-full ${a.v > 60 ? "bg-warn" : a.v > 40 ? "bg-accent" : "bg-up"}`}
                      style={{ width: `${a.v}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Panel>

        <Panel
          header
          pad={20}
          title="CORRELATION · 7D RETURNS"
          right={<Layers size={14} className="text-accent" />}
        >
          <CorrelationHeatmap labels={R.corrLabels} matrix={R.corr} />
          <div className="mono mt-3 flex justify-between text-[10.5px] text-fg-2">
            <span>-1.0 anti-correlated</span>
            <span>+1.0 correlated</span>
          </div>
        </Panel>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: "1.3fr 1fr" }}>
        <Panel
          header
          pad={20}
          title="EXPOSURE TREE"
          right={
            <span className="mono text-[10px] rounded-full border border-obsidian-line-2 bg-obsidian-3 px-2 py-0.5 uppercase text-fg-1">
              TOTAL ${treeTotal.toLocaleString()}
            </span>
          }
        >
          <ExposureTree node={R.tree} maxVal={R.tree.value} />
        </Panel>

        <KillSwitchLadder rows={R.killLadder} />
      </div>

      <SymbolCapsTable caps={R.symbolCaps} />
    </div>
  );
}
```

- [ ] **Step 2.11 — Verify in dev server**

Navigate to `/risk`. Expected:
- Risk hero with VaR number, circuit bars, `1/5 TRIPPED` pill.
- Risk radar (hexagon shape) + axis bars panel.
- 6×6 correlation heatmap with diagonal accent borders.
- Exposure tree with nested indentation + value bars.
- Kill-switch ladder with 5 numbered rows.
- Per-symbol caps table.
- No console errors.

- [ ] **Step 2.12 — Commit**

```bash
git add src/types/risk.ts src/hooks/apex/useRiskData.ts src/hooks/apex/mock/seed-data.ts src/components/apex/risk/ src/pages/Risk.tsx
git commit -m "Phase 1: Risk — hero / radar / correlation / exposure tree / kill ladder / symbol caps"
```

---

## Task 3 — Model page

**Files:**
- Create: `src/types/model.ts`
- Modify: `src/hooks/apex/mock/seed-data.ts` (add `MODEL_SEED`)
- Create: `src/hooks/apex/useModelData.ts`
- Create: `src/components/apex/model/ModelHero.tsx`
- Create: `src/components/apex/model/ShapWaterfall.tsx`
- Create: `src/components/apex/model/LiveInferencePanel.tsx`
- Create: `src/components/apex/model/ConfusionMatrix.tsx`
- Create: `src/components/apex/model/CalibrationChart.tsx`
- Create: `src/components/apex/model/TrainingRunsTable.tsx`
- Modify: `src/pages/Model.tsx`

- [ ] **Step 3.1 — Create `src/types/model.ts`**

```ts
export interface ModelMeta {
  name: string;
  arch: string;
  features: number;
  params: string;
  file: string;
  size: string;
  rocAuc: number;
  precision: number;
  recall: number;
  f1: number;
  brier: number;
  trainedOn: number;
  trainedAt: string;
}

export interface ShapFeature {
  k: string;
  v: number;
  sign: 1 | -1;
  desc: string;
}

export interface InferenceEvent {
  ts: string;
  sym: string;
  p: number;
  state: "ACCEPTED" | "REJECTED";
  top: string;
}

export interface ConfusionMatrixCounts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface CalibrationPoint {
  bin: number;
  pred: number;
  obs: number;
}

export interface TrainingRun {
  v: string;
  date: string;
  auc: number;
  prec: number;
  trades: number;
  note: string;
  live?: boolean;
}

export interface ModelData {
  meta: ModelMeta;
  shap: readonly ShapFeature[];
  infer: readonly InferenceEvent[];
  cm: ConfusionMatrixCounts;
  calibration: readonly CalibrationPoint[];
  runs: readonly TrainingRun[];
}
```

- [ ] **Step 3.2 — Append `MODEL_SEED` to `seed-data.ts`**

```ts
import type { ModelData } from "@/types/model";

export const MODEL_SEED: ModelData = {
  meta: {
    name: "xgb_v2.4",
    arch: "XGBoost · 400 trees · depth 6",
    features: 128,
    params: "1.2M",
    file: "xgb_v2.4.onnx",
    size: "3.4 MB",
    rocAuc: 0.784,
    precision: 0.642,
    recall: 0.718,
    f1: 0.678,
    brier: 0.198,
    trainedOn: 47_331,
    trainedAt: "2026-04-11 14:32 UTC",
  },
  shap: [
    { k: "regime_adx_15m",      v:  0.124, sign:  1, desc: "ADX > 30 on 15m" },
    { k: "breakout_width_20",   v:  0.088, sign:  1, desc: "Donchian 20 compressed" },
    { k: "volume_z_5m",         v:  0.072, sign:  1, desc: "Vol z-score +2.1σ" },
    { k: "vwap_distance",       v:  0.041, sign:  1, desc: "0.3% above VWAP" },
    { k: "spread_pctile",       v:  0.032, sign:  1, desc: "Tight spread (2nd pct)" },
    { k: "hour_of_day",         v: -0.018, sign: -1, desc: "US close approaching" },
    { k: "realized_vol_24h",    v: -0.024, sign: -1, desc: "RV slightly elevated" },
    { k: "correlation_btc_eth", v: -0.041, sign: -1, desc: "High BTC-ETH corr" },
  ],
  infer: [
    { ts: "14:22:04", sym: "BTC-USD",  p: 0.71, state: "ACCEPTED", top: "regime_adx · volume_z" },
    { ts: "14:21:38", sym: "ETH-USD",  p: 0.58, state: "REJECTED", top: "vwap_dist · hour_of_day" },
    { ts: "14:20:51", sym: "SOL-USD",  p: 0.67, state: "ACCEPTED", top: "breakout_width · volume_z" },
    { ts: "14:19:22", sym: "LINK-USD", p: 0.49, state: "REJECTED", top: "spread_pctile · rv_24h" },
    { ts: "14:18:07", sym: "AVAX-USD", p: 0.62, state: "REJECTED", top: "rv_24h · hour_of_day" },
    { ts: "14:17:44", sym: "ARB-USD",  p: 0.74, state: "ACCEPTED", top: "breakout_width · regime_adx" },
  ],
  cm: { tp: 6820, fp: 3810, fn: 2680, tn: 33921 },
  calibration: [
    { bin: 0.10, pred: 0.10, obs: 0.08 },
    { bin: 0.20, pred: 0.20, obs: 0.19 },
    { bin: 0.30, pred: 0.30, obs: 0.28 },
    { bin: 0.40, pred: 0.40, obs: 0.37 },
    { bin: 0.50, pred: 0.50, obs: 0.49 },
    { bin: 0.60, pred: 0.60, obs: 0.58 },
    { bin: 0.70, pred: 0.70, obs: 0.69 },
    { bin: 0.80, pred: 0.80, obs: 0.82 },
    { bin: 0.90, pred: 0.90, obs: 0.91 },
  ],
  runs: [
    { v: "v2.4", date: "2026-04-11", auc: 0.784, prec: 0.642, trades: 47_331, note: "current · expanded features", live: true },
    { v: "v2.3", date: "2026-03-02", auc: 0.762, prec: 0.618, trades: 42_104, note: "regime-aware threshold" },
    { v: "v2.2", date: "2026-01-14", auc: 0.741, prec: 0.597, trades: 38_290, note: "SHAP-driven pruning" },
    { v: "v2.1", date: "2025-11-22", auc: 0.725, prec: 0.581, trades: 35_140, note: "added orderbook features" },
    { v: "v2.0", date: "2025-09-08", auc: 0.701, prec: 0.554, trades: 30_122, note: "first XGBoost baseline" },
  ],
};
```

- [ ] **Step 3.3 — Create `useModelData.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import type { ModelData } from "@/types/model";
import { MODEL_SEED } from "./mock/seed-data";

export function useModelData() {
  return useQuery<ModelData>({
    queryKey: ["apex", "model-data"],
    queryFn: () => Promise.resolve(MODEL_SEED),
    staleTime: 10_000,
  });
}
```

- [ ] **Step 3.4 — Create `ModelHero.tsx`**

```tsx
import { Brain, RefreshCw, Download } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Sparkline } from "@/components/apex/Sparkline";
import { cn } from "@/lib/utils";
import type { ModelMeta } from "@/types/model";

interface Props {
  meta: ModelMeta;
}

function MetricTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-obsidian-line bg-obsidian-2 p-3">
      <div className="mono text-[10px] uppercase text-fg-2">{label}</div>
      <div className={cn("mono mt-1 text-[18px] font-medium", tone || "text-fg-0")}>{value}</div>
    </div>
  );
}

function FingerprintRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between text-[11.5px]">
      <span className="mono text-[10px] uppercase text-fg-2">{k}</span>
      <span className={cn(mono && "mono", "text-fg-0")}>{v}</span>
    </div>
  );
}

export function ModelHero({ meta }: Props) {
  const aucHistory = [0.68, 0.70, 0.71, 0.74, 0.76, 0.78, 0.78, meta.rocAuc];

  return (
    <Panel header={false} pad={0} className="relative overflow-hidden" tone="accent">
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          background:
            "linear-gradient(135deg, hsl(var(--obsidian-1)) 0%, #0d121c 60%, hsl(var(--obsidian-1)) 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute"
        style={{
          top: -120, left: -120, width: 400, height: 400, borderRadius: "50%",
          background: "radial-gradient(circle, hsl(var(--accent-glow)) 0%, transparent 70%)", opacity: 0.55,
        }}
      />
      <div className="relative grid gap-7 p-7" style={{ gridTemplateColumns: "1.1fr 1fr 1fr" }}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-accent/15 text-accent ring-1 ring-accent/30">
              <Brain size={22} strokeWidth={1.5} />
            </div>
            <div className="flex flex-col">
              <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-accent">META MODEL · ACTIVE</span>
              <span className="text-[20px] font-semibold text-fg-0" style={{ letterSpacing: "-0.01em" }}>{meta.name}</span>
            </div>
          </div>
          <div className="serif-ital text-fg-0" style={{ fontSize: 30, lineHeight: 1.1, fontWeight: 500, letterSpacing: "-0.02em" }}>
            The model that <span className="text-accent">decides</span><br />
            which signals <span className="text-fg-1">earn capital.</span>
          </div>
          <p className="max-w-[400px] text-[12.5px] leading-[1.5] text-fg-1">
            {meta.arch}. Trained on <span className="mono text-fg-0">{meta.trainedOn.toLocaleString()}</span> signals. Last retrained{" "}
            <span className="mono text-fg-0">{meta.trainedAt}</span>.
          </p>
          <div className="flex gap-2">
            <button className="inline-flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-2 px-3 py-1.5 text-[12px] text-fg-1 hover:bg-obsidian-3">
              <RefreshCw size={12} /> Retrain
            </button>
            <button className="inline-flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-2 px-3 py-1.5 text-[12px] text-fg-1 hover:bg-obsidian-3">
              <Download size={12} /> Export ONNX
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-l border-obsidian-line px-6">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">PERFORMANCE</span>
          <div className="flex items-end justify-between">
            <div>
              <div className="mono text-[44px] font-medium text-accent leading-none" style={{ textShadow: "0 0 24px hsl(var(--accent-glow))" }}>
                {(meta.rocAuc * 100).toFixed(1)}
              </div>
              <div className="mono mt-1 text-[10px] uppercase text-fg-2">ROC AUC %</div>
            </div>
            <Sparkline data={aucHistory} width={120} height={40} />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <MetricTile label="PRECISION" value={`${(meta.precision * 100).toFixed(1)}%`} tone="text-up" />
            <MetricTile label="RECALL"    value={`${(meta.recall * 100).toFixed(1)}%`}    tone="text-accent" />
            <MetricTile label="F1 SCORE"  value={`${(meta.f1 * 100).toFixed(1)}%`} />
            <MetricTile label="BRIER"     value={meta.brier.toFixed(3)}                   tone="text-warn" />
          </div>
        </div>

        <div className="flex flex-col gap-2 border-l border-obsidian-line px-6">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">FINGERPRINT</span>
          <FingerprintRow k="ARCH"     v={meta.arch} />
          <FingerprintRow k="FEATURES" v={meta.features.toString()} />
          <FingerprintRow k="PARAMS"   v={meta.params} />
          <FingerprintRow k="FILE"     v={meta.file} mono />
          <FingerprintRow k="SIZE"     v={meta.size} />
          <FingerprintRow k="TRAINED"  v={meta.trainedAt.slice(0, 10)} />
          <div className="my-1 h-px bg-obsidian-line" />
          <div className="flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-up shadow-[0_0_0_2px_rgba(57,217,138,0.25)]" />
            <span className="mono text-[11px] text-up">SERVING · 4.2ms p50</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
```

- [ ] **Step 3.5 — Create `ShapWaterfall.tsx`**

```tsx
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { ArrowRight } from "lucide-react";
import type { ShapFeature } from "@/types/model";

interface Props {
  features: readonly ShapFeature[];
  basePred?: number;
}

export function ShapWaterfall({ features, basePred = 0.5 }: Props) {
  const maxAbs = Math.max(...features.map((f) => Math.abs(f.v))) * 1.2;
  const contrib = features.reduce((s, f) => s + f.v, 0);
  const finalP = Math.max(0, Math.min(1, basePred + contrib));
  const barMaxW = 180;

  return (
    <Panel
      header
      pad={20}
      title="FEATURE ATTRIBUTION · SHAP"
      right={<Pill tone="accent">BTC-USD · 14:22:04</Pill>}
    >
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="mono text-[10px] uppercase text-fg-2">BASE RATE</div>
          <div className="mono text-[20px] text-fg-1">{(basePred * 100).toFixed(0)}%</div>
        </div>
        <ArrowRight size={18} className="text-fg-3" />
        <div className="text-right">
          <div className="mono text-[10px] uppercase text-fg-2">FINAL PROBABILITY</div>
          <div className={`mono text-[22px] font-medium ${finalP >= 0.65 ? "text-up" : "text-down"}`}>
            {(finalP * 100).toFixed(1)}%
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-0.5">
        {features.map((f) => {
          const w = (Math.abs(f.v) / maxAbs) * barMaxW;
          const pos = f.v >= 0;
          return (
            <div
              key={f.k}
              className="grid items-center gap-3"
              style={{ gridTemplateColumns: "1fr 400px 60px", height: 28 }}
            >
              <div className="text-right">
                <div className="mono text-[11.5px] text-fg-0">{f.k}</div>
                <div className="text-[10px] text-fg-3">{f.desc}</div>
              </div>
              <div className="relative h-5">
                <div className="absolute left-1/2 top-0 h-full w-px bg-obsidian-line-2" />
                <div
                  className="absolute top-[2px] h-4 rounded-sm"
                  style={{
                    left: pos ? "50%" : `calc(50% - ${w}px)`,
                    width: w,
                    background: pos ? "hsl(var(--up))" : "hsl(var(--down))",
                    boxShadow: pos ? "0 0 8px hsl(var(--up) / 0.45)" : "0 0 8px hsl(var(--down) / 0.45)",
                    opacity: 0.85,
                  }}
                />
              </div>
              <div className={`mono text-[12px] ${pos ? "text-up" : "text-down"}`}>
                {pos ? "+" : ""}{(f.v * 100).toFixed(1)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mono mt-2 text-center text-[10px] uppercase text-fg-2">
        ← DECREASES P &nbsp;&nbsp; · &nbsp;&nbsp; INCREASES P →
      </div>
    </Panel>
  );
}
```

- [ ] **Step 3.6 — Create `LiveInferencePanel.tsx`**

```tsx
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { InferenceEvent } from "@/types/model";

interface Props {
  events: readonly InferenceEvent[];
}

export function LiveInferencePanel({ events }: Props) {
  return (
    <Panel
      header
      pad={0}
      title="LIVE INFERENCE TRACE"
      right={<span className="mono text-[10px] text-fg-2 uppercase">LAST {events.length}</span>}
    >
      <div className="max-h-[420px] overflow-y-auto">
        {events.map((r, i) => (
          <div
            key={`${r.ts}-${i}`}
            className={cn("px-4 py-2.5", i < events.length - 1 && "border-b border-obsidian-line")}
          >
            <div className="mb-1 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="mono text-[10.5px] text-fg-3">{r.ts}</span>
                <span className="text-[12.5px] font-medium text-fg-0">{r.sym}</span>
              </div>
              <Pill tone={r.state === "ACCEPTED" ? "up" : "default"}>{r.state}</Pill>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-obsidian-3">
                <div
                  className={cn("h-full rounded-full", r.p >= 0.65 ? "bg-up" : "bg-fg-2")}
                  style={{ width: `${r.p * 100}%`, boxShadow: r.p >= 0.65 ? "0 0 6px hsl(var(--up) / 0.45)" : undefined }}
                />
              </div>
              <span className={cn("mono text-[11px] min-w-[36px]", r.p >= 0.65 ? "text-up" : "text-fg-2")}>
                {(r.p * 100).toFixed(0)}%
              </span>
            </div>
            <div className="mono mt-1 text-[10.5px] text-fg-2">top: {r.top}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
```

- [ ] **Step 3.7 — Create `ConfusionMatrix.tsx`**

```tsx
import { Panel } from "@/components/apex/Panel";
import { cn } from "@/lib/utils";
import type { ConfusionMatrixCounts } from "@/types/model";

interface Props {
  cm: ConfusionMatrixCounts;
}

export function ConfusionMatrix({ cm }: Props) {
  const { tp, fp, fn, tn } = cm;
  const total = tp + fp + fn + tn;
  const max = Math.max(tp, fp, fn, tn);
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  const accuracy = (tp + tn) / total;

  const Cell = ({ val, label, sub, tone }: { val: number; label: string; sub: string; tone: "good" | "bad" }) => (
    <div
      className={cn(
        "flex aspect-square flex-col items-center justify-center rounded-md p-2",
        tone === "good" ? "border border-up" : "border border-down/40",
      )}
      style={{
        background:
          tone === "good"
            ? `rgba(57,217,138,${0.12 + (val / max) * 0.25})`
            : `rgba(255,90,106,${0.08 + (val / max) * 0.2})`,
      }}
    >
      <div className="mono text-[10px] uppercase text-fg-2">{label}</div>
      <div className={cn("mono mt-1 text-[22px] font-medium", tone === "good" ? "text-up" : "text-down")}>
        {val.toLocaleString()}
      </div>
      <div className="mono text-[9.5px] text-fg-3">{sub}</div>
    </div>
  );

  return (
    <Panel
      header
      pad={20}
      title="CONFUSION MATRIX"
      right={<span className="mono text-[10px] uppercase text-fg-2">N = {total.toLocaleString()}</span>}
    >
      <div className="grid items-center gap-6" style={{ gridTemplateColumns: "1fr auto" }}>
        <div className="flex w-[260px] flex-col gap-1.5">
          <div className="mono flex items-center justify-center gap-[100px] text-[10px] text-fg-2">
            <span>PRED: NEG</span>
            <span>PRED: POS</span>
          </div>
          <div className="grid items-center gap-1.5" style={{ gridTemplateColumns: "46px 1fr 1fr" }}>
            <div className="mono rotate-180 text-center text-[10px] uppercase text-fg-2" style={{ writingMode: "vertical-rl" }}>
              ACTUAL POS
            </div>
            <Cell val={fn} label="FN" sub="miss" tone="bad" />
            <Cell val={tp} label="TP" sub="correct +" tone="good" />
          </div>
          <div className="grid items-center gap-1.5" style={{ gridTemplateColumns: "46px 1fr 1fr" }}>
            <div className="mono rotate-180 text-center text-[10px] uppercase text-fg-2" style={{ writingMode: "vertical-rl" }}>
              ACTUAL NEG
            </div>
            <Cell val={tn} label="TN" sub="correct -" tone="good" />
            <Cell val={fp} label="FP" sub="false alarm" tone="bad" />
          </div>
        </div>
        <div className="flex min-w-[140px] flex-col gap-2.5">
          <div>
            <div className="mono text-[10px] uppercase text-fg-2">ACCURACY</div>
            <div className="mono text-[17px] text-fg-0">{(accuracy * 100).toFixed(1)}%</div>
          </div>
          <div>
            <div className="mono text-[10px] uppercase text-fg-2">PRECISION</div>
            <div className="mono text-[17px] text-up">{(precision * 100).toFixed(1)}%</div>
          </div>
          <div>
            <div className="mono text-[10px] uppercase text-fg-2">RECALL</div>
            <div className="mono text-[17px] text-accent">{(recall * 100).toFixed(1)}%</div>
          </div>
          <div>
            <div className="mono text-[10px] uppercase text-fg-2">FALSE POS RATE</div>
            <div className="mono text-[14px] text-warn">{((fp / (fp + tn)) * 100).toFixed(1)}%</div>
          </div>
        </div>
      </div>
    </Panel>
  );
}
```

- [ ] **Step 3.8 — Create `CalibrationChart.tsx`**

```tsx
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import type { CalibrationPoint } from "@/types/model";

interface Props {
  data: readonly CalibrationPoint[];
}

export function CalibrationChart({ data }: Props) {
  const width = 380;
  const height = 240;
  const padL = 36;
  const padT = 12;
  const padR = 12;
  const padB = 28;
  const iw = width - padL - padR;
  const ih = height - padT - padB;
  const x = (v: number) => padL + v * iw;
  const y = (v: number) => padT + ih - v * ih;
  const path = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(d.pred)},${y(d.obs)}`).join(" ");

  return (
    <Panel
      header
      pad={16}
      title="CALIBRATION CURVE"
      right={<Pill tone="accent">WELL CALIBRATED</Pill>}
    >
      <svg width={width} height={height} className="block">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={padL} y1={y(t)} x2={padL + iw} y2={y(t)} stroke="hsl(var(--obsidian-line))" strokeDasharray="2 3" />
            <line x1={x(t)} y1={padT} x2={x(t)} y2={padT + ih} stroke="hsl(var(--obsidian-line))" strokeDasharray="2 3" />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fontFamily="var(--font-mono, ui-monospace)" fill="hsl(var(--fg-2))">
              {(t * 100).toFixed(0)}
            </text>
            <text x={x(t)} y={padT + ih + 14} textAnchor="middle" fontSize="9" fontFamily="var(--font-mono, ui-monospace)" fill="hsl(var(--fg-2))">
              {(t * 100).toFixed(0)}
            </text>
          </g>
        ))}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="hsl(var(--fg-2))" strokeDasharray="4 4" opacity="0.6" />
        <path
          d={path}
          fill="none"
          stroke="hsl(var(--accent))"
          strokeWidth="2"
          style={{ filter: "drop-shadow(0 0 4px hsl(var(--accent-glow)))" }}
        />
        {data.map((d, i) => (
          <circle key={i} cx={x(d.pred)} cy={y(d.obs)} r="3.5" fill="hsl(var(--accent))" />
        ))}
        <text x={padL + iw / 2} y={height - 4} textAnchor="middle" fontSize="10" fontFamily="var(--font-mono, ui-monospace)" fill="hsl(var(--fg-2))">
          PREDICTED %
        </text>
        <text
          x={8}
          y={padT + ih / 2}
          textAnchor="middle"
          fontSize="10"
          fontFamily="var(--font-mono, ui-monospace)"
          fill="hsl(var(--fg-2))"
          transform={`rotate(-90, 8, ${padT + ih / 2})`}
        >
          OBSERVED %
        </text>
      </svg>
      <p className="mt-2 text-[11.5px] leading-[1.5] text-fg-2">
        When the model predicts X%, outcomes actually occur at ≈X%. Divergence from the diagonal = miscalibration.
      </p>
    </Panel>
  );
}
```

- [ ] **Step 3.9 — Create `TrainingRunsTable.tsx`**

```tsx
import { FlaskConical, RefreshCw } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { TrainingRun } from "@/types/model";

interface Props {
  runs: readonly TrainingRun[];
}

export function TrainingRunsTable({ runs }: Props) {
  return (
    <Panel
      header
      pad={0}
      title="TRAINING RUNS · VERSION HISTORY"
      right={
        <div className="flex items-center gap-2">
          <FlaskConical size={14} className="text-warn" strokeWidth={1.6} />
          <button className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/20">
            <RefreshCw size={12} /> New run
          </button>
        </div>
      }
    >
      <table className="w-full">
        <thead>
          <tr className="border-b border-obsidian-line">
            {["VERSION", "DATE", "ROC AUC", "PRECISION", "TRADES", "NOTE", ""].map((h) => (
              <th
                key={h}
                className="mono px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.1em] text-fg-2"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.v} className="border-b border-obsidian-line/60">
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={cn("mono font-medium", r.live ? "text-accent" : "text-fg-0")}>{r.v}</span>
                  {r.live && <Pill tone="accent">LIVE</Pill>}
                </div>
              </td>
              <td className="mono px-3 py-2 text-[11.5px] text-fg-2">{r.date}</td>
              <td className="mono px-3 py-2 text-right text-[11.5px]">
                <span className={r.live ? "text-up" : "text-fg-1"}>{(r.auc * 100).toFixed(1)}%</span>
              </td>
              <td className="mono px-3 py-2 text-right text-[11.5px]">{(r.prec * 100).toFixed(1)}%</td>
              <td className="mono px-3 py-2 text-right text-[11.5px]">{r.trades.toLocaleString()}</td>
              <td className="px-3 py-2 text-[12px] text-fg-1">{r.note}</td>
              <td className="px-3 py-2 text-right">
                {!r.live && (
                  <button className="rounded-md border border-obsidian-line bg-obsidian-2 px-2 py-1 text-[10.5px] text-fg-1 hover:bg-obsidian-3">
                    Rollback
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
```

- [ ] **Step 3.10 — Assemble `Model.tsx`**

```tsx
import { ModelHero } from "@/components/apex/model/ModelHero";
import { ShapWaterfall } from "@/components/apex/model/ShapWaterfall";
import { LiveInferencePanel } from "@/components/apex/model/LiveInferencePanel";
import { ConfusionMatrix } from "@/components/apex/model/ConfusionMatrix";
import { CalibrationChart } from "@/components/apex/model/CalibrationChart";
import { TrainingRunsTable } from "@/components/apex/model/TrainingRunsTable";
import { useModelData } from "@/hooks/apex/useModelData";

export default function Model() {
  const model = useModelData();
  if (!model.data) return null;
  const M = model.data;

  return (
    <div className="flex flex-col gap-4 p-6">
      <ModelHero meta={M.meta} />

      <div className="grid gap-4" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <ShapWaterfall features={M.shap} />
        <LiveInferencePanel events={M.infer} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ConfusionMatrix cm={M.cm} />
        <CalibrationChart data={M.calibration} />
      </div>

      <TrainingRunsTable runs={M.runs} />
    </div>
  );
}
```

- [ ] **Step 3.11 — Verify in dev server**

Navigate to `/model`. Expected:
- Model hero with 78.4 ROC AUC display, AUC sparkline, fingerprint rows.
- SHAP waterfall with 8 feature bars (5 green up, 3 red down).
- Live inference panel with 6 rows.
- 2x2 confusion matrix (6820 / 3810 / 2680 / 33921).
- Calibration curve close to diagonal.
- Training runs table with `v2.4 LIVE` at top.
- No console errors.

- [ ] **Step 3.12 — Commit**

```bash
git add src/types/model.ts src/hooks/apex/useModelData.ts src/hooks/apex/mock/seed-data.ts src/components/apex/model/ src/pages/Model.tsx
git commit -m "Phase 1: Model — hero / SHAP / inference / confusion / calibration / runs"
```

---

## Self-review notes

- **Spec coverage:** Signals covers KPI strip (folded into hero) + signal stream + regime/strategy status (strategy configs). Risk covers hero KPIs, radar, correlation, exposure tree, kill ladder, symbol caps. Model covers status hero, SHAP, inference, confusion + calibration, training runs.
- **Deviations from spec that are intentional:**
  - Sliders are rendered as read-only progress bars (no `<input type=range>` wiring). Matches current `StrategyCards` behavior on Dashboard where UI is read-only.
  - No side drawer / kill-confirm dialog yet — these are interaction layers we can add once the static layouts are approved.
  - Regime panel on Signals is dropped in favor of the Meta model hero (the jsx source replaced it too).
- **Known tooling note:** `Segmented` component may expect `{ v, l }` tuples. Step 1.7 verifies before building.
- **Risk:** Using inline `style` for gradients/radial backgrounds because those aren't cleanly expressible via Tailwind utility classes — matches Dashboard's `HeroStatePanel`.
