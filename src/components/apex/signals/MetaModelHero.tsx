import { Filter } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Stat } from "@/components/apex/Stat";
import { cn } from "@/lib/utils";
import type { MetaFilterInfo } from "@/types/strategy";
import type { SignalRecord } from "@/types/signals";

interface Props {
  meta: MetaFilterInfo;
  signals: readonly SignalRecord[];
  /** True while a paper session runs — acceptance below is that session's. */
  sessionActive?: boolean;
}

/**
 * Rule-based meta-filter hero. The previous version framed this as an ML
 * model (ROC-AUC / precision / recall / F1, "trained on N trades") with every
 * metric hard-coded to 0 — there is no ML model in this codebase. It now
 * reports the real gate state from /api/metafilter/stats and acceptance over
 * the session's own signals. Rows from guardrails-killed strategies are
 * excluded from the acceptance math (they never reached the gate).
 */
export function MetaModelHero({ meta, signals, sessionActive = false }: Props) {
  const gated = signals.filter((s) => s.state !== "KILLED");
  const accepted = gated.filter((s) => s.state === "ACCEPTED").length;
  const rejected = gated.filter((s) => s.state === "REJECTED").length;
  const killed = signals.length - gated.length;
  const acceptRate = gated.length > 0 ? accepted / gated.length : 0;
  const enabledRules = meta.rules.filter((r) => r.enabled).length;

  const gateLabel =
    meta.enabled === null ? "GATE · UNKNOWN (ENGINE STOPPED)" : meta.enabled ? "GATE · ACTIVE" : "GATE · BYPASSED";
  const gateTone = meta.enabled === null ? "text-fg-3" : meta.enabled ? "text-accent" : "text-warn";

  return (
    <Panel header={false} pad={0} tone="accent" className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute opacity-60"
        style={{
          top: -80,
          right: -80,
          width: 280,
          height: 280,
          borderRadius: "50%",
          background: "radial-gradient(circle, hsl(var(--accent-glow)) 0%, transparent 70%)",
        }}
      />
      <div className="relative grid gap-6 p-6" style={{ gridTemplateColumns: "1.2fr 1fr 1fr" }}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-accent/15 text-accent ring-1 ring-accent/30">
              <Filter size={18} strokeWidth={1.6} />
            </div>
            <div className="flex flex-col">
              <span className={cn("mono text-[10px] font-medium uppercase tracking-[0.12em]", gateTone)} data-testid="meta-gate-state">
                META-FILTER · RULE-BASED · {gateLabel}
              </span>
              <span className="text-[15px] font-medium text-fg-0">{meta.name}</span>
            </div>
          </div>
          <p className="max-w-[440px] text-[12.5px] leading-[1.55] text-fg-1">
            Every signal passes a deterministic quality gate: cold-streak cooldown after a losing run,
            optional time-of-day / strength / volume rules, and a minimum quality score. No model is
            trained or scored here — <span className="mono text-fg-0">signals.meta_prob</span> stays NULL.
          </p>
          <div className="mt-1 flex flex-wrap items-start gap-6">
            {meta.rules.map((r) => (
              <Stat
                key={r.key}
                label={r.label.toUpperCase()}
                value={meta.enabled === null ? "—" : r.enabled ? "ON" : "OFF"}
                tone={meta.enabled !== null && r.enabled ? "accent" : undefined}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3 border-l border-obsidian-line px-5">
          <div className="flex items-center justify-between">
            <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
              MIN QUALITY SCORE
            </span>
            <span
              className="mono text-[28px] font-medium text-accent"
              style={{ textShadow: "0 0 20px hsl(var(--accent-glow))" }}
            >
              {(meta.threshold * 100).toFixed(0)}%
            </span>
          </div>
          <div className="relative h-1 w-full rounded-full bg-obsidian-3">
            <div
              className="absolute left-0 top-0 h-full rounded-full bg-accent"
              style={{
                width: `${Math.max(0, Math.min(100, meta.threshold * 100))}%`,
                boxShadow: "0 0 8px hsl(var(--accent-glow))",
              }}
            />
          </div>
          <div className="mono flex justify-between text-[9.5px] text-fg-3">
            <span>0%</span>
            <span>{enabledRules} of {meta.rules.length} rules on</span>
            <span>100%</span>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-l border-obsidian-line px-5">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            {sessionActive ? "THIS SESSION · ACCEPTANCE" : `RECENT (${gated.length}) · ENGINE STOPPED`}
          </span>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-obsidian-line bg-obsidian-2 p-3">
              <div className="mono text-[10px] uppercase text-fg-2">ACCEPTED</div>
              <div className="mono mt-1 text-[22px] font-medium text-up">{accepted}</div>
              <div className="text-[10px] text-fg-2">of {gated.length} gated signals</div>
            </div>
            <div className="rounded-lg border border-obsidian-line bg-obsidian-2 p-3">
              <div className="mono text-[10px] uppercase text-fg-2">REJECTED</div>
              <div className="mono mt-1 text-[22px] font-medium text-fg-1">{rejected}</div>
              <div className="text-[10px] text-fg-2">
                {killed > 0 ? `${killed} from killed strategies excluded` : "by rules / risk"}
              </div>
            </div>
          </div>
          <div>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="mono text-[10px] uppercase text-fg-2">ACCEPTANCE RATE</span>
              <span className="mono text-accent">{gated.length > 0 ? `${(acceptRate * 100).toFixed(1)}%` : "—"}</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-obsidian-3">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${acceptRate * 100}%`, boxShadow: "0 0 8px hsl(var(--accent-glow))" }}
              />
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}
