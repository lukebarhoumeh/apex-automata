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
