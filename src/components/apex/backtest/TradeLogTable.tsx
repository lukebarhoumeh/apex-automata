import { Download } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { BacktestTrade } from "@/types/backtest";

interface Props {
  trades: readonly BacktestTrade[];
}

export function TradeLogTable({ trades }: Props) {
  return (
    <Panel
      header
      pad={0}
      title="TRADE LOG · SAMPLE"
      right={
        <button className="inline-flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1 text-[11px] text-fg-1 hover:bg-obsidian-3">
          <Download size={12} /> CSV
        </button>
      }
    >
      <table className="w-full">
        <thead>
          <tr className="border-b border-obsidian-line">
            {["DATE", "SYM", "SIDE", "ENTRY", "EXIT", "R", "P&L", "HOLD"].map((h) => (
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
          {trades.map((t) => {
            const posR = t.r >= 0;
            const posPnl = t.pnl >= 0;
            return (
              <tr key={t.id} className="border-b border-obsidian-line/60">
                <td className="mono px-3 py-2 text-[11px] text-fg-2">{t.date}</td>
                <td className="px-3 py-2 text-[12.5px] font-medium text-fg-0">{t.sym}</td>
                <td className="px-3 py-2">
                  <Pill tone={t.side === "LONG" ? "up" : "down"}>{t.side}</Pill>
                </td>
                <td className="mono px-3 py-2 text-right text-[11.5px]">
                  {t.entry.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td className="mono px-3 py-2 text-right text-[11.5px]">
                  {t.exit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td
                  className={cn(
                    "mono px-3 py-2 text-right text-[11.5px]",
                    posR ? "text-up" : "text-down",
                  )}
                >
                  {posR ? "+" : ""}
                  {t.r.toFixed(2)}R
                </td>
                <td
                  className={cn(
                    "mono px-3 py-2 text-right text-[11.5px]",
                    posPnl ? "text-up" : "text-down",
                  )}
                >
                  {posPnl ? "+" : "-"}${Math.abs(t.pnl).toLocaleString()}
                </td>
                <td className="mono px-3 py-2 text-[11px] text-fg-1">{t.dur}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
