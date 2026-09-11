import { useState } from "react";
import { HeroStatePanel } from "@/components/apex/dashboard/HeroStatePanel";
import { KpiRow } from "@/components/apex/dashboard/KpiRow";
import { EquityChartPanel } from "@/components/apex/dashboard/EquityChartPanel";
import { StrategyCards } from "@/components/apex/dashboard/StrategyCards";
import { LiveSignalFeed } from "@/components/apex/dashboard/LiveSignalFeed";
import { PositionsTable } from "@/components/apex/dashboard/PositionsTable";
import { RegimeCard } from "@/components/apex/dashboard/RegimeCard";
import {
  useDashboardKpis,
  useEquityCurve,
  useMarketRegime,
  useOpenPositions,
  useSessionStats,
  useSignalFeed,
  useStrategyStatus,
} from "@/hooks/apex/useDashboardData";
import { useLiveMarks } from "@/hooks/apex/useLiveMarks";
import { useActiveSession } from "@/runtime/session";
import type { EquityRange } from "@/types/equity";

export default function Dashboard() {
  const [range, setRange] = useState<EquityRange>("ALL");

  // Every Supabase-backed panel is scoped to the active paper session so the
  // dashboard describes THIS run, not whatever last wrote to the tables.
  const { engineRunning, sessionStartedAt } = useActiveSession();
  const session = useSessionStats();
  const equity = useEquityCurve(range);
  const positions = useOpenPositions();
  const strategies = useStrategyStatus();
  const feed = useSignalFeed(engineRunning ? sessionStartedAt : null);
  const regime = useMarketRegime();
  const marks = useLiveMarks();
  const { data: kpis } = useDashboardKpis(marks);

  if (!session.data || !equity.data || !positions.data || !strategies.data || !feed.data || !regime.data) {
    return null;
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <HeroStatePanel
        session={session.data}
        regime={regime.data}
        intradayEquity={equity.data}
      />

      <KpiRow tiles={kpis} />

      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
        <div className="flex flex-col gap-4">
          <EquityChartPanel
            data={equity.data}
            range={range}
            onChangeRange={setRange}
          />
          <StrategyCards strategies={strategies.data} sessionActive={engineRunning} />
        </div>

        <LiveSignalFeed initialEvents={feed.data} live={engineRunning} />
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) 300px" }}>
        <PositionsTable positions={positions.data.positions} source={positions.data.source} marks={marks} />
        <RegimeCard regime={regime.data} />
      </div>
    </div>
  );
}
