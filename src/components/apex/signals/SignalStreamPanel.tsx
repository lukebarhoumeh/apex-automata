import { useState, useMemo } from "react";
import { Pill } from "@/components/apex/Pill";
import { Panel } from "@/components/apex/Panel";
import { Segmented } from "@/components/apex/Segmented";
import { cn } from "@/lib/utils";
import type { SignalRecord, SignalState } from "@/types/signals";

interface Props {
  signals: readonly SignalRecord[];
  threshold: number;
}

type Filter = "ALL" | SignalState;

const FILTER_OPTIONS = [
  { value: "ALL" as const,       label: "ALL" },
  { value: "ACCEPTED" as const,  label: "ACCEPTED" },
  { value: "REJECTED" as const,  label: "REJECTED" },
  { value: "CANCELLED" as const, label: "CANCEL" },
];

export function SignalStreamPanel({ signals, threshold }: Props) {
  const [filter, setFilter] = useState<Filter>("ALL");

  const filtered = useMemo(
    () => (filter === "ALL" ? signals : signals.filter((s) => s.state === filter)),
    [signals, filter],
  );

  return (
    <Panel header={false} pad={0}>
      <div className="flex items-center justify-between border-b border-obsidian-line px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_0_2px_hsl(var(--accent)/0.25)]" />
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            SIGNAL STREAM · THIS SESSION
          </span>
        </div>
        <Segmented<Filter> value={filter} onChange={setFilter} options={FILTER_OPTIONS} />
      </div>
      <div className="max-h-[480px] overflow-y-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-obsidian-line">
              {["TIME", "SYMBOL", "STRATEGY", "SIDE", "CONFIDENCE", "Z", "ADX", "NOTE", "STATE"].map((h) => (
                <th
                  key={h}
                  className="mono px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.1em] text-fg-2"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="py-10 text-center text-[12px] text-fg-2" data-testid="signal-stream-empty">
                  {signals.length === 0
                    ? "No signals this session — the stream shows only decisions made since the active session opened."
                    : "No signals match the current filter."}
                </td>
              </tr>
            )}
            {filtered.map((s) => (
              <tr key={s.id} className={cn("border-b border-obsidian-line/60 hover:bg-obsidian-2/60", s.killed && "opacity-60")}>
                <td className="mono px-3 py-2 text-[11px] text-fg-2">{s.ts}</td>
                <td className="px-3 py-2 text-[12.5px] font-medium text-fg-0">{s.sym}</td>
                <td className="mono px-3 py-2 text-[11px] text-fg-1">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn(s.killed && "line-through text-fg-3")}>{s.strat}</span>
                    {s.killed && (
                      <span
                        className="rounded-full border border-warn/30 bg-warn/10 px-1.5 py-px text-[9px] uppercase tracking-wider text-warn"
                        title="Strategy is in guardrails.yaml disabled_strategies (GET /api/strategies/policy). Signals from it never reach order routing."
                        data-testid={`signal-killed-${s.id}`}
                      >
                        killed
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <Pill tone={s.side === "BUY" ? "up" : "down"}>{s.side}</Pill>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="relative h-1 w-[60px] rounded-full bg-obsidian-3">
                      <div
                        className={cn(
                          "absolute left-0 top-0 h-full rounded-full",
                          s.conf >= threshold ? "bg-accent" : "bg-fg-2",
                        )}
                        style={{
                          width: `${s.conf * 100}%`,
                          boxShadow: s.conf >= threshold ? "0 0 6px hsl(var(--accent-glow))" : undefined,
                        }}
                      />
                      <div
                        className="absolute top-[-2px] h-2 w-px bg-fg-2"
                        style={{ left: `${threshold * 100}%` }}
                      />
                    </div>
                    <span
                      className={cn(
                        "mono text-[11px]",
                        s.conf >= threshold ? "text-accent" : "text-fg-2",
                      )}
                    >
                      {(s.conf * 100).toFixed(0)}%
                    </span>
                  </div>
                </td>
                <td className="mono px-3 py-2 text-right text-[11px] text-fg-1">
                  {s.z != null ? s.z.toFixed(2) : "—"}
                </td>
                <td className="mono px-3 py-2 text-right text-[11px] text-fg-1">{s.adx ?? "—"}</td>
                <td className="px-3 py-2 text-[11px] text-fg-2">{s.note}</td>
                <td className="px-3 py-2">
                  <Pill
                    tone={
                      s.state === "ACCEPTED" ? "up" : s.state === "REJECTED" ? "default" : "warn"
                    }
                  >
                    {s.state}
                  </Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
