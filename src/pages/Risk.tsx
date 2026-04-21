import { Layers } from "lucide-react";
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
            <span className="mono rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-[10px] uppercase text-warn">
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
                    <span
                      className={`mono text-[11px] ${
                        a.v > 60 ? "text-warn" : a.v > 40 ? "text-accent" : "text-up"
                      }`}
                    >
                      {a.v}
                    </span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-obsidian-3">
                    <div
                      className={`h-full rounded-full ${
                        a.v > 60 ? "bg-warn" : a.v > 40 ? "bg-accent" : "bg-up"
                      }`}
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
            <span className="mono rounded-full border border-obsidian-line-2 bg-obsidian-3 px-2 py-0.5 text-[10px] uppercase text-fg-1">
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
