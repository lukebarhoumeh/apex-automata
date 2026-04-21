import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { InferenceEvent } from "@/types/model";

interface Props {
  events: readonly InferenceEvent[];
}

export function LiveInferencePanel({ events }: Props) {
  return (
    <Panel
      header
      pad={0}
      title="LIVE INFERENCE TRACE"
      right={
        <span className="mono text-[10px] text-fg-2 uppercase">LAST {events.length}</span>
      }
    >
      <div className="max-h-[420px] overflow-y-auto">
        {events.map((r, i) => (
          <div
            key={`${r.ts}-${i}`}
            className={cn("px-4 py-2.5", i < events.length - 1 && "border-b border-obsidian-line")}
          >
            <div className="mb-1 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="mono text-[10.5px] text-fg-3">{r.ts}</span>
                <span className="text-[12.5px] font-medium text-fg-0">{r.sym}</span>
              </div>
              <Pill tone={r.state === "ACCEPTED" ? "up" : "default"}>{r.state}</Pill>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-obsidian-3">
                <div
                  className={cn("h-full rounded-full", r.p >= 0.65 ? "bg-up" : "bg-fg-2")}
                  style={{
                    width: `${r.p * 100}%`,
                    boxShadow: r.p >= 0.65 ? "0 0 6px hsl(var(--up) / 0.45)" : undefined,
                  }}
                />
              </div>
              <span
                className={cn(
                  "mono text-[11px] min-w-[36px]",
                  r.p >= 0.65 ? "text-up" : "text-fg-2",
                )}
              >
                {(r.p * 100).toFixed(0)}%
              </span>
            </div>
            <div className="mono mt-1 text-[10.5px] text-fg-2">top: {r.top}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
