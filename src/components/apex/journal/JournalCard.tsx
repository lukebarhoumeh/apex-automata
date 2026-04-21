import { useState } from "react";
import { TrendingUp, TrendingDown, ChevronDown, ChevronRight } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import { MiniTradeChart } from "./MiniTradeChart";
import type { JournalEntry } from "@/types/journal";

interface Props {
  entry: JournalEntry;
}

function LevelCell({ lbl, v, tone }: { lbl: string; v: number; tone?: string }) {
  const digits = v >= 1000 ? 0 : 2;
  return (
    <div>
      <div className="mono text-[10px] uppercase text-fg-2">{lbl}</div>
      <div className={cn("mono text-[13px]", tone || "text-fg-0")}>
        {v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}
      </div>
    </div>
  );
}

export function JournalCard({ entry: j }: Props) {
  const [open, setOpen] = useState(false);
  const win = j.outcome === "WIN";
  const Icon = win ? TrendingUp : TrendingDown;

  return (
    <Panel
      header={false}
      pad={0}
      className={cn(
        "border",
        win ? "border-up/25" : "border-down/25",
      )}
    >
      <div className="border-b border-obsidian-line p-4">
        <div className="mb-2 flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className={cn(
                "grid h-7 w-7 place-items-center rounded border",
                win ? "border-up bg-up/15 text-up" : "border-down bg-down/15 text-down",
              )}
            >
              <Icon size={14} />
            </div>
            <div>
              <div className="text-[14px] font-medium text-fg-0">
                {j.sym} ·{" "}
                <span className={j.side === "LONG" ? "text-up" : "text-down"}>{j.side}</span>
              </div>
              <div className="mono text-[10.5px] text-fg-2">
                #{j.id} · {j.date} · {j.time}
              </div>
            </div>
          </div>
          <Pill tone={win ? "up" : "down"}>{j.outcome}</Pill>
        </div>

        <div className="flex items-end justify-between">
          <div className="flex gap-5">
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">R</div>
              <div className={cn("mono text-[16px]", win ? "text-up" : "text-down")}>
                {j.r >= 0 ? "+" : ""}
                {j.r.toFixed(2)}R
              </div>
            </div>
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">P&L</div>
              <div className={cn("mono text-[16px]", win ? "text-up" : "text-down")}>
                {j.pnl >= 0 ? "+" : "-"}${Math.abs(j.pnl).toLocaleString()}
              </div>
            </div>
          </div>
          <MiniTradeChart seed={j.seed} entry={j.entry} exit={j.exit} side={j.side} win={win} />
        </div>
      </div>

      <div className="border-b border-obsidian-line p-4">
        <div className="mono text-[10px] uppercase text-fg-2">THESIS</div>
        <div className="mt-1 text-[12.5px] leading-[1.5] text-fg-0">{j.thesis}</div>
      </div>

      <div className="grid grid-cols-4 gap-3 border-b border-obsidian-line p-3.5">
        <LevelCell lbl="ENTRY" v={j.entry} />
        <LevelCell lbl="EXIT" v={j.exit} tone={win ? "text-up" : "text-down"} />
        <LevelCell lbl="STOP" v={j.stop} tone="text-down" />
        <LevelCell lbl="TARGET" v={j.target} tone="text-up" />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 p-3.5">
        {j.tags.map((t) => (
          <span
            key={t}
            className="mono rounded border border-obsidian-line bg-obsidian-2 px-1.5 py-0.5 text-[10px] text-fg-1"
          >
            #{t}
          </span>
        ))}
        <button
          onClick={() => setOpen((v) => !v)}
          className="mono ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-[10.5px] text-fg-2 hover:text-fg-0"
        >
          {open ? "Hide lessons" : "Show lessons"}
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </button>
      </div>

      {open && (
        <div
          className="border-t border-obsidian-line p-4"
          style={{ background: "rgba(255,196,87,0.03)" }}
        >
          <div className="mono text-[10px] uppercase text-warn">LESSONS · POST-MORTEM</div>
          <div className="serif-ital mt-1 text-[12.5px] leading-[1.5] text-fg-0">{j.lessons}</div>
        </div>
      )}
    </Panel>
  );
}
