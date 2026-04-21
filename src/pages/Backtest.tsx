import { useEffect, useRef, useState } from "react";
import { TrendingUp } from "lucide-react";
import { BacktestHero } from "@/components/apex/backtest/BacktestHero";
import { ConfigPanel } from "@/components/apex/backtest/ConfigPanel";
import { EquityWithDD } from "@/components/apex/backtest/EquityWithDD";
import { MonthlyReturnsPanel } from "@/components/apex/backtest/MonthlyReturnsPanel";
import { RHistogram } from "@/components/apex/backtest/RHistogram";
import { TradeLogTable } from "@/components/apex/backtest/TradeLogTable";
import { Panel } from "@/components/apex/Panel";
import { useBacktestData } from "@/hooks/apex/useBacktestData";

export default function Backtest() {
  const bt = useBacktestData();
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartW, setChartW] = useState(760);

  useEffect(() => {
    if (!chartRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setChartW(Math.max(320, Math.floor(e.contentRect.width)));
    });
    ro.observe(chartRef.current);
    return () => ro.disconnect();
  }, []);

  if (!bt.data) return null;
  const B = bt.data;

  return (
    <div className="flex flex-col gap-4 p-6">
      <BacktestHero config={B.config} results={B.results} />
      <ConfigPanel config={B.config} preset={B.preset} />

      <div className="grid gap-4" style={{ gridTemplateColumns: "2fr 1fr" }}>
        <Panel
          header
          pad={0}
          title="EQUITY CURVE · DRAWDOWN UNDERLAY"
          right={
            <div className="flex items-center gap-3 text-[11px]">
              <div className="flex items-center gap-1.5">
                <TrendingUp size={12} className="text-up" />
                <span className="mono text-[10px] uppercase text-fg-2">EQUITY</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-3 rounded-sm bg-down/40" />
                <span className="mono text-[10px] uppercase text-fg-2">DRAWDOWN</span>
              </div>
            </div>
          }
        >
          <div ref={chartRef} className="px-2 pb-1 pt-2">
            <EquityWithDD data={B.equity} width={chartW - 8} height={280} />
          </div>
        </Panel>

        <MonthlyReturnsPanel data={B.monthlyReturns} />
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 2fr" }}>
        <RHistogram data={B.rDist} trades={B.results.trades} />
        <TradeLogTable trades={B.trades} />
      </div>
    </div>
  );
}
