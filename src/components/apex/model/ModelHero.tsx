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
          top: -120,
          left: -120,
          width: 400,
          height: 400,
          borderRadius: "50%",
          background: "radial-gradient(circle, hsl(var(--accent-glow)) 0%, transparent 70%)",
          opacity: 0.55,
        }}
      />
      <div className="relative grid gap-7 p-7" style={{ gridTemplateColumns: "1.1fr 1fr 1fr" }}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-accent/15 text-accent ring-1 ring-accent/30">
              <Brain size={22} strokeWidth={1.5} />
            </div>
            <div className="flex flex-col">
              <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-accent">
                META MODEL · ACTIVE
              </span>
              <span
                className="text-[20px] font-semibold text-fg-0"
                style={{ letterSpacing: "-0.01em" }}
              >
                {meta.name}
              </span>
            </div>
          </div>
          <div
            className="serif-ital text-fg-0"
            style={{ fontSize: 30, lineHeight: 1.1, fontWeight: 500, letterSpacing: "-0.02em" }}
          >
            The model that <span className="text-accent">decides</span>
            <br />
            which signals <span className="text-fg-1">earn capital.</span>
          </div>
          <p className="max-w-[400px] text-[12.5px] leading-[1.5] text-fg-1">
            {meta.arch}. Trained on{" "}
            <span className="mono text-fg-0">{meta.trainedOn.toLocaleString()}</span> signals. Last
            retrained <span className="mono text-fg-0">{meta.trainedAt}</span>.
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
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            PERFORMANCE
          </span>
          <div className="flex items-end justify-between">
            <div>
              <div
                className="mono text-[44px] font-medium text-accent leading-none"
                style={{ textShadow: "0 0 24px hsl(var(--accent-glow))" }}
              >
                {(meta.rocAuc * 100).toFixed(1)}
              </div>
              <div className="mono mt-1 text-[10px] uppercase text-fg-2">ROC AUC %</div>
            </div>
            <Sparkline data={aucHistory} width={120} height={40} />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <MetricTile
              label="PRECISION"
              value={`${(meta.precision * 100).toFixed(1)}%`}
              tone="text-up"
            />
            <MetricTile
              label="RECALL"
              value={`${(meta.recall * 100).toFixed(1)}%`}
              tone="text-accent"
            />
            <MetricTile label="F1 SCORE" value={`${(meta.f1 * 100).toFixed(1)}%`} />
            <MetricTile label="BRIER" value={meta.brier.toFixed(3)} tone="text-warn" />
          </div>
        </div>

        <div className="flex flex-col gap-2 border-l border-obsidian-line px-6">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            FINGERPRINT
          </span>
          <FingerprintRow k="ARCH" v={meta.arch} />
          <FingerprintRow k="FEATURES" v={meta.features.toString()} />
          <FingerprintRow k="PARAMS" v={meta.params} />
          <FingerprintRow k="FILE" v={meta.file} mono />
          <FingerprintRow k="SIZE" v={meta.size} />
          <FingerprintRow k="TRAINED" v={meta.trainedAt.slice(0, 10)} />
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
