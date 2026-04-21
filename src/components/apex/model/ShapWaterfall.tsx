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
          <div
            className={`mono text-[22px] font-medium ${finalP >= 0.65 ? "text-up" : "text-down"}`}
          >
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
                    boxShadow: pos
                      ? "0 0 8px hsl(var(--up) / 0.45)"
                      : "0 0 8px hsl(var(--down) / 0.45)",
                    opacity: 0.85,
                  }}
                />
              </div>
              <div className={`mono text-[12px] ${pos ? "text-up" : "text-down"}`}>
                {pos ? "+" : ""}
                {(f.v * 100).toFixed(1)}
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
