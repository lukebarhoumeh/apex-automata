import { useState } from "react";
import { AlertsHero } from "@/components/apex/alerts/AlertsHero";
import { RuleList } from "@/components/apex/alerts/RuleList";
import { RuleEditor } from "@/components/apex/alerts/RuleEditor";
import { TriggerLogTable } from "@/components/apex/alerts/TriggerLogTable";
import { DemoBanner } from "@/components/apex/DemoBanner";
import { useAlertRules, useAlertFired } from "@/hooks/apex/useAlertsData";

export default function Alerts() {
  const rules = useAlertRules();
  const fired = useAlertFired();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!rules.data || !fired.data) return null;
  const resolvedId = selectedId ?? rules.data[0]?.id ?? null;
  const selected = rules.data.find((r) => r.id === resolvedId) ?? null;

  return (
    <div className="flex flex-col gap-4 p-6">
      <DemoBanner
        detail={
          <>
            Alert rules, the trigger log and channel targets here are seeded fixtures from{" "}
            <span className="mono">seed-data.ts</span>; nothing is armed and nothing was fired by this session.
            Real runtime alerts are written to Supabase <span className="mono">public.alerts</span> by the engine and
            surface as toasts — this page is not wired to them yet.
          </>
        }
      />
      <AlertsHero rules={rules.data} fired={fired.data} />

      <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 2fr" }}>
        <RuleList
          rules={rules.data}
          selectedId={resolvedId ?? ""}
          onSelect={setSelectedId}
        />
        {selected && <RuleEditor rule={selected} />}
      </div>

      <TriggerLogTable events={fired.data} />
    </div>
  );
}
