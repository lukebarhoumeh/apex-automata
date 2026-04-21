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

  const Cell = ({
    val,
    label,
    sub,
    tone,
  }: {
    val: number;
    label: string;
    sub: string;
    tone: "good" | "bad";
  }) => (
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
      <div
        className={cn(
          "mono mt-1 text-[22px] font-medium",
          tone === "good" ? "text-up" : "text-down",
        )}
      >
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
      right={
        <span className="mono text-[10px] uppercase text-fg-2">N = {total.toLocaleString()}</span>
      }
    >
      <div className="grid items-center gap-6" style={{ gridTemplateColumns: "1fr auto" }}>
        <div className="flex w-[260px] flex-col gap-1.5">
          <div className="mono flex items-center justify-center gap-[100px] text-[10px] text-fg-2">
            <span>PRED: NEG</span>
            <span>PRED: POS</span>
          </div>
          <div
            className="grid items-center gap-1.5"
            style={{ gridTemplateColumns: "46px 1fr 1fr" }}
          >
            <div
              className="mono rotate-180 text-center text-[10px] uppercase text-fg-2"
              style={{ writingMode: "vertical-rl" }}
            >
              ACTUAL POS
            </div>
            <Cell val={fn} label="FN" sub="miss" tone="bad" />
            <Cell val={tp} label="TP" sub="correct +" tone="good" />
          </div>
          <div
            className="grid items-center gap-1.5"
            style={{ gridTemplateColumns: "46px 1fr 1fr" }}
          >
            <div
              className="mono rotate-180 text-center text-[10px] uppercase text-fg-2"
              style={{ writingMode: "vertical-rl" }}
            >
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
            <div className="mono text-[14px] text-warn">
              {((fp / (fp + tn)) * 100).toFixed(1)}%
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}
