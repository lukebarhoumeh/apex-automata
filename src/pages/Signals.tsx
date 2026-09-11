import { MetaModelHero } from "@/components/apex/signals/MetaModelHero";
import { StrategyConfigCard } from "@/components/apex/signals/StrategyConfigCard";
import { SignalStreamPanel } from "@/components/apex/signals/SignalStreamPanel";
import {
  useMetaFilter,
  useSignalStream,
  useStrategyConfigs,
} from "@/hooks/apex/useSignalsData";
import { useActiveSession } from "@/runtime/session";

export default function Signals() {
  // Stream and per-strategy stats are scoped to the active paper session.
  const { engineRunning, sessionStartedAt } = useActiveSession();
  const meta = useMetaFilter();
  const signals = useSignalStream(engineRunning ? sessionStartedAt : null);
  const strategies = useStrategyConfigs();

  if (!meta.data || !signals.data || !strategies.data) return null;

  return (
    <div className="flex flex-col gap-4 p-6">
      <MetaModelHero meta={meta.data} signals={signals.data} sessionActive={engineRunning} />
      <div className="grid gap-4 md:grid-cols-2">
        {strategies.data.map((s) => (
          <StrategyConfigCard key={s.id} strat={s} sessionActive={engineRunning} />
        ))}
      </div>
      <SignalStreamPanel signals={signals.data} threshold={meta.data.threshold} live={engineRunning} />
    </div>
  );
}
