import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { RDistBucket } from "@/types/backtest";

interface Props {
  data: readonly RDistBucket[];
  trades: number;
}

export function RHistogram({ data, trades }: Props) {
  const max = Math.max(...data.map((d) => d.n));

  return (
    <Panel
      header
      pad={0}
      title="R-MULTIPLE DISTRIBUTION"
      right={<Pill tone="default">{trades} TRADES</Pill>}
    >
      <div className="flex flex-col gap-2 p-4">
        {data.map((b) => {
          const isLoss = b.bucket.startsWith("<") || b.bucket.startsWith("-");
          return (
            <div
              key={b.bucket}
              className="grid items-center gap-2"
              style={{ gridTemplateColumns: "72px 1fr 32px" }}
            >
              <span className="mono text-right text-[10.5px] text-fg-2">{b.bucket}</span>
              <div className="h-3.5 w-full overflow-hidden rounded-full bg-obsidian-3">
                <div
                  className={cn("h-full rounded-full", isLoss ? "bg-down" : "bg-up")}
                  style={{
                    width: `${(b.n / max) * 100}%`,
                    boxShadow: isLoss
                      ? "0 0 6px hsl(var(--down) / 0.45)"
                      : "0 0 6px hsl(var(--up) / 0.45)",
                    opacity: 0.85,
                  }}
                />
              </div>
              <span className="mono text-right text-[11px] text-fg-0">{b.n}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
