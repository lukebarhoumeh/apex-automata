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
            <span className="mono text-up">{meta.rocAuc.toFixed(2)}</span>. Raise the threshold for higher quality;
            lower for more volume.
          </p>
          <div className="mt-1 flex flex-wrap items-start gap-6">
            <Stat label="ROC AUC"   value={`${(meta.rocAuc * 100).toFixed(1)}%`}   tone="accent" />
            <Stat label="PRECISION" value={`${(meta.precision * 100).toFixed(1)}%`} />
            <Stat label="RECALL"    value={`${(meta.recall * 100).toFixed(1)}%`} />
            <Stat label="F1"        value={`${(meta.f1 * 100).toFixed(1)}%`} />
          </div>
        </div>

        <div className="flex flex-col gap-3 border-l border-obsidian-line px-5">
          <div className="flex items-center justify-between">
            <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
              PROBABILITY THRESHOLD
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
                width: `${((meta.threshold - 0.5) / 0.4) * 100}%`,
                boxShadow: "0 0 8px hsl(var(--accent-glow))",
              }}
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
