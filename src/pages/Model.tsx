import { AlertTriangle } from "lucide-react";
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
      <div className="flex items-start gap-3 rounded-md border border-warn/30 bg-warn/10 px-4 py-3">
        <AlertTriangle size={16} className="mt-0.5 text-warn" strokeWidth={1.8} />
        <div className="text-[12.5px] leading-[1.5] text-fg-1">
          <span className="mono font-semibold uppercase tracking-[0.1em] text-warn">
            Placeholder UI — no ML model loaded
          </span>
          <div className="mt-1 text-fg-2">
            The live meta-filter is rule-based (cold-streak cooldown, time-of-day filters).
            The metrics, SHAP waterfall, confusion matrix, calibration curve and training
            runs on this page are design placeholders. See the{" "}
            <span className="text-fg-0">Signals</span> page for live filter activity and
            the <span className="text-fg-0">Dashboard</span> for real KPIs.
          </div>
        </div>
      </div>

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
