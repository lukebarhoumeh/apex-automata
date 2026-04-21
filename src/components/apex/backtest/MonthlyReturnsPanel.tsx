import { Panel } from "@/components/apex/Panel";
import type { MonthlyReturn } from "@/types/backtest";

interface Props {
  data: readonly MonthlyReturn[];
}

export function MonthlyReturnsPanel({ data }: Props) {
  return (
    <Panel header pad={0} title="MONTHLY RETURNS">
      <div className="p-4">
        {data.map((m, i) => {
          const pos = m.r >= 0;
          const w = Math.abs(m.r) * 5;
          return (
            <div
              key={m.m}
              className="grid items-center gap-2.5 py-2"
              style={{
                gridTemplateColumns: "50px 1fr 70px",
                borderBottom: i < data.length - 1 ? "1px solid hsl(var(--obsidian-line))" : "none",
              }}
            >
              <span className="mono text-[12px] text-fg-1">{m.m}</span>
              <div className="relative h-3.5">
                <div className="absolute left-1/2 top-0 h-full w-px bg-obsidian-line-2" />
                <div
                  className="absolute top-0.5 h-2.5"
                  style={{
                    left: pos ? "50%" : `calc(50% - ${w}px)`,
                    width: w,
                    background: pos ? "hsl(var(--up))" : "hsl(var(--down))",
                    boxShadow: pos
                      ? "0 0 6px hsl(var(--up) / 0.45)"
                      : "0 0 6px hsl(var(--down) / 0.45)",
                    borderRadius: pos ? "0 3px 3px 0" : "3px 0 0 3px",
                  }}
                />
              </div>
              <span
                className={`mono text-right text-[13px] ${pos ? "text-up" : "text-down"}`}
              >
                {pos ? "+" : ""}
                {m.r.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
