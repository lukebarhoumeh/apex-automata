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
    <div className="grid gap-4 p-6" style={{ gridTemplateColumns: "220px 1fr" }}>
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
  );
}
