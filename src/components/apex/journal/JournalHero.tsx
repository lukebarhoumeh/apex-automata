import { BookOpen } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import type { JournalEntry } from "@/types/journal";

interface Props {
  entries: readonly JournalEntry[];
}

export function JournalHero({ entries }: Props) {
  const wins = entries.filter((j) => j.outcome === "WIN").length;
  const losses = entries.filter((j) => j.outcome === "LOSS").length;
  const totalPnl = entries.reduce((s, j) => s + j.pnl, 0);
  const avgR = entries.length > 0 ? entries.reduce((s, j) => s + j.r, 0) / entries.length : 0;

  const tagCounts: Record<string, number> = {};
  entries.forEach((j) => j.tags.forEach((t) => (tagCounts[t] = (tagCounts[t] || 0) + 1)));
  const tags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

  return (
    <Panel header={false} pad={0} className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          background:
            "linear-gradient(135deg, hsl(var(--obsidian-1)) 0%, #13100d 60%, hsl(var(--obsidian-1)) 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute"
        style={{
          top: -100,
          left: "40%",
          width: 320,
          height: 320,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255,196,87,0.12) 0%, transparent 70%)",
        }}
      />
      <div className="relative grid gap-7 p-7" style={{ gridTemplateColumns: "1.4fr 1fr 1fr" }}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Pill tone="warn">
              <BookOpen size={10} strokeWidth={2} /> TRADE JOURNAL
            </Pill>
            <Pill tone="default">{entries.length} ENTRIES</Pill>
          </div>
          <div
            className="serif-ital text-fg-0"
            style={{ fontSize: 38, lineHeight: 1.05, fontWeight: 500, letterSpacing: "-0.02em" }}
          >
            Every trade
            <br />
            tells a <span className="text-warn">story.</span>
          </div>
          <p className="max-w-[420px] text-[12.5px] leading-[1.55] text-fg-1">
            Automated logs pair each execution with your thesis and post-mortem. Pattern recognition
            across winners and losers compounds faster than equity.
          </p>
        </div>

        <div className="flex flex-col gap-3 border-l border-obsidian-line px-6">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            OUTCOME BREAKDOWN
          </span>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mono text-[30px] font-medium text-up">{wins}</div>
              <div className="mono text-[10px] uppercase text-fg-2">WINS</div>
            </div>
            <div>
              <div className="mono text-[30px] font-medium text-down">{losses}</div>
              <div className="mono text-[10px] uppercase text-fg-2">LOSSES</div>
            </div>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-obsidian-2">
            <div
              className="bg-up"
              style={{ flex: wins, boxShadow: "0 0 6px hsl(var(--up) / 0.45)" }}
            />
            <div className="bg-down" style={{ flex: losses }} />
          </div>
          <div className="flex justify-between">
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">TOTAL P&L</div>
              <div
                className={`mono text-[17px] ${totalPnl >= 0 ? "text-up" : "text-down"}`}
              >
                {totalPnl >= 0 ? "+" : "-"}${Math.abs(totalPnl).toLocaleString()}
              </div>
            </div>
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">AVG R</div>
              <div className="mono text-[17px] text-accent">
                {avgR >= 0 ? "+" : ""}
                {avgR.toFixed(2)}R
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-l border-obsidian-line px-6">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            TAG DISTRIBUTION
          </span>
          <div className="flex flex-wrap gap-1.5">
            {tags.map(([t, n]) => (
              <span
                key={t}
                className="mono rounded border border-obsidian-line bg-obsidian-2 px-2 py-1 text-[10.5px] text-fg-1"
              >
                #{t} <span className="ml-1 text-accent">{n}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}
