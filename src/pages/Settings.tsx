import { useState } from "react";
import {
  SettingsNav,
  type SettingsSectionKey,
} from "@/components/apex/settings/SettingsNav";
import { AccountSection } from "@/components/apex/settings/sections/AccountSection";
import { VenuesSection } from "@/components/apex/settings/sections/VenuesSection";
import { RiskLimitsSection } from "@/components/apex/settings/sections/RiskLimitsSection";
import { NotificationsSection } from "@/components/apex/settings/sections/NotificationsSection";
import { AdvancedSection } from "@/components/apex/settings/sections/AdvancedSection";
import { DemoBanner } from "@/components/apex/DemoBanner";
import { useSettings } from "@/hooks/apex/useSettingsData";
import type { NotificationChannel, RiskLimits } from "@/types/settings";

export default function Settings() {
  const settings = useSettings();
  const [section, setSection] = useState<SettingsSectionKey>("account");
  const [limits, setLimits] = useState<RiskLimits | null>(null);
  const [notifs, setNotifs] = useState<NotificationChannel[] | null>(null);
  const [killArmed, setKillArmed] = useState<boolean | null>(null);

  if (!settings.data) return null;
  const S = settings.data;

  const effectiveLimits = limits ?? S.riskLimits;
  const effectiveNotifs = notifs ?? (S.notifications as NotificationChannel[]);
  const effectiveKillArmed = killArmed ?? S.riskLimits.killSwitchArmed;

  return (
    <div className="flex flex-col gap-4 p-6">
      <DemoBanner
        detail={
          <>
            Account, venues &amp; API keys, notification channels, risk limits and the kill-switch arm state on this
            page are seeded fixtures from <span className="mono">seed-data.ts</span>. No venue shown here is
            connected, no key is issued, and saving changes nothing. The runtime's real limits live in{" "}
            <span className="mono">atlas/config/guardrails.yaml</span> (see the <span className="text-fg-0">Risk</span>{" "}
            page); exchange credentials come from the backend <span className="mono">.env</span> only.
          </>
        }
      />
    <div className="grid gap-4" style={{ gridTemplateColumns: "220px 1fr" }}>
      <SettingsNav
        section={section}
        onSection={setSection}
        account={S.account}
        plan={S.account.plan}
        killArmed={effectiveKillArmed}
        onKillArmed={setKillArmed}
      />

      <div className="flex flex-col gap-4">
        {section === "account" && <AccountSection account={S.account} />}
        {section === "venues" && <VenuesSection venues={S.venues} />}
        {section === "risk" && (
          <RiskLimitsSection limits={effectiveLimits} onChange={setLimits} />
        )}
        {section === "notifications" && (
          <NotificationsSection notifs={effectiveNotifs} onChange={setNotifs} />
        )}
        {section === "advanced" && <AdvancedSection />}
      </div>
    </div>
    </div>
  );
}
