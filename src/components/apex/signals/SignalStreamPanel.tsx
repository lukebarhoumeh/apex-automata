import { useState, useMemo } from "react";
import { Pill } from "@/components/apex/Pill";
import { Panel } from "@/components/apex/Panel";
import { Segmented } from "@/components/apex/Segmented";
import { cn } from "@/lib/utils";
import type { SignalRecord, SignalState } from "@/types/signals";

interface Props {
  signals: readonly SignalRecord[];
  threshold: number;
  /** True while a paper session runs — the stream is session-scoped and live. */
  live?: boolean;
}

type Filter = "ALL" | SignalState;

const FILTER_OPTIONS = [
  { value: "ALL" as const,       label: "ALL" },
  { value: "ACCEPTED" as const,  label: "ACCEPTED" },
  { value: "REJECTED" as const,  label: "REJECTED" },
  { value: "CANCELLED" as const, label: "CANCEL" },
  { value: "KILLED" as const,    label: "KILLED" },
];

const STATE_TONE: Record<SignalState, "up" | "default" | "warn"> = {
  ACCEPTED: "up",
  REJECTED: "default",
  CANCELLED: "warn",
  // Strategy is in guardrails.yaml disabled_strategies — audit row, never routed.
  KILLED: "warn",
};

export function SignalStreamPanel({ signals, threshold, live = false }: Props) {
  const [filter, setFilter] = useState<Filter>("ALL");

  const filtered = useMemo(
    () => (filter === "ALL" ? signals : signals.filter((s) => s.state === filter)),
    [signals, filter],
  );
  const killedCount = signals.filter((s) => s.state === "KILLED").length;

  return (
    <Panel header={false} pad={0}>
      <div className="flex items-center justify-between border-b border-obsidian-line px-4 py-3">
        <div className="flex items-center gap-3">
          <span
            className={
              live
                ? "inline-block h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_0_2px_hsl(var(--accent)/0.25)]"
                : "inline-block h-1.5 w-1.5 rounded-full bg-fg-3"
            }
          />
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2" data-testid="signal-stream-header">
            {live ? "SIGNAL STREAM · LIVE · THIS SESSION" : "SIGNAL STREAM · RECENT · ENGINE STOPPED"}
          </span>
          {killedCount > 0 && (
            <span className="mono text-[10px] uppercase tracking-[0.09em] text-warn/90" title="Rows from strategies killed in guardrails.yaml disabled_strategies — historical, never routed">
              {killedCount} killed-strategy rows
            </span>
          )}
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
            {filtered.map((s) => (
              <tr key={s.id} className="border-b border-obsidian-line/60 hover:bg-obsidian-2/60">
                <td className="mono px-3 py-2 text-[11px] text-fg-2">{s.ts}</td>
                <td className="px-3 py-2 text-[12.5px] font-medium text-fg-0">{s.sym}</td>
                <td className="mono px-3 py-2 text-[11px] text-fg-1">{s.strat}</td>
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
                    tone={STATE_TONE[s.state]}
                    title={s.state === "KILLED" ? "Strategy killed in guardrails.yaml disabled_strategies — audit row, never routed" : undefined}
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
