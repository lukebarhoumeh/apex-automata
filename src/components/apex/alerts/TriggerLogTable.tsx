import { Activity, Download } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import type { AlertFiredEvent } from "@/types/alerts";

interface Props {
  events: readonly AlertFiredEvent[];
}

export function TriggerLogTable({ events }: Props) {
  return (
    <Panel
      header
      pad={0}
      title="TRIGGER LOG · LAST 24H"
      right={
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-warn" strokeWidth={1.6} />
          <button className="inline-flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1 text-[11px] text-fg-1 hover:bg-obsidian-3">
            <Download size={12} /> Export
          </button>
        </div>
      }
    >
      <table className="w-full">
        <thead>
          <tr className="border-b border-obsidian-line">
            {["TS", "RULE", "DETAIL", "LEVEL", ""].map((h) => (
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
          {events.map((a, i) => (
            <tr key={`${a.ts}-${i}`} className="border-b border-obsidian-line/60">
              <td className="mono px-3 py-2 text-[11px] text-fg-2">{a.ts}</td>
              <td className="px-3 py-2 text-[12.5px] font-medium text-fg-0">{a.rule}</td>
              <td className="mono px-3 py-2 text-[11px] text-fg-1">{a.detail}</td>
              <td className="px-3 py-2">
                <Pill tone={a.level === "danger" ? "down" : "warn"}>
                  {a.level.toUpperCase()}
                </Pill>
              </td>
              <td className="px-3 py-2 text-right">
                <button className="rounded-md border border-obsidian-line bg-obsidian-2 px-2 py-0.5 text-[10.5px] text-fg-1 hover:bg-obsidian-3">
                  Inspect
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
