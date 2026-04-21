import { Plus, Download } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { cn } from "@/lib/utils";

export type JournalFilter = "ALL" | "WIN" | "LOSS";

interface Props {
  filter: JournalFilter;
  onFilter: (f: JournalFilter) => void;
  counts: { all: number; wins: number; losses: number };
}

export function JournalFilterBar({ filter, onFilter, counts }: Props) {
  const options: { k: JournalFilter; label: string; count: number }[] = [
    { k: "ALL", label: "All", count: counts.all },
    { k: "WIN", label: "Wins", count: counts.wins },
    { k: "LOSS", label: "Losses", count: counts.losses },
  ];

  return (
    <Panel header={false} pad={0}>
      <div className="flex items-center justify-between px-4 py-2.5">
        <div className="flex gap-1.5">
          {options.map((o) => (
            <button
              key={o.k}
              onClick={() => onFilter(o.k)}
              className={cn(
                "rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
                filter === o.k
                  ? "bg-accent/15 text-accent border border-accent/30"
                  : "bg-obsidian-2 text-fg-1 border border-obsidian-line hover:bg-obsidian-3",
              )}
            >
              {o.label}
              <span className="mono ml-2 opacity-60">{o.count}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button className="inline-flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1.5 text-[11.5px] text-fg-1 hover:bg-obsidian-3">
            <Download size={12} /> Export
          </button>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-[11.5px] font-medium text-accent hover:bg-accent/20">
            <Plus size={12} /> New entry
          </button>
        </div>
      </div>
    </Panel>
  );
}
