import { MetaModelHero } from "@/components/apex/signals/MetaModelHero";
import { StrategyConfigCard } from "@/components/apex/signals/StrategyConfigCard";
import { SignalStreamPanel } from "@/components/apex/signals/SignalStreamPanel";
import {
  useMetaModel,
  useSignalStream,
  useStrategyConfigs,
} from "@/hooks/apex/useSignalsData";

export default function Signals() {
  const meta = useMetaModel();
  const signals = useSignalStream();
  const strategies = useStrategyConfigs();

  if (!meta.data || !signals.data || !strategies.data) return null;

  return (
    <div className="flex flex-col gap-4 p-6">
      <MetaModelHero meta={meta.data} signals={signals.data} />
      <div className="grid gap-4 md:grid-cols-2">
        {strategies.data.map((s) => (
          <StrategyConfigCard key={s.id} strat={s} />
        ))}
      </div>
      <SignalStreamPanel signals={signals.data} threshold={meta.data.threshold} />
    </div>
  );
}
