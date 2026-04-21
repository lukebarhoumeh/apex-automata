import type { LucideIcon } from "lucide-react";
import { User, Plug, Shield, Bell, Terminal } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { ToggleSwitch } from "@/components/apex/settings/parts/ToggleSwitch";
import { cn } from "@/lib/utils";
import type { AccountInfo } from "@/types/settings";

export type SettingsSectionKey = "account" | "venues" | "risk" | "notifications" | "advanced";

interface Props {
  section: SettingsSectionKey;
  onSection: (s: SettingsSectionKey) => void;
  account: AccountInfo;
  plan: string;
  killArmed: boolean;
  onKillArmed: (v: boolean) => void;
}

const SECTIONS: { k: SettingsSectionKey; label: string; icon: LucideIcon }[] = [
  { k: "account", label: "Account", icon: User },
  { k: "venues", label: "Venues · API keys", icon: Plug },
  { k: "risk", label: "Risk limits", icon: Shield },
  { k: "notifications", label: "Notifications", icon: Bell },
  { k: "advanced", label: "Advanced", icon: Terminal },
];

export function SettingsNav({ section, onSection, account, plan, killArmed, onKillArmed }: Props) {
  return (
    <div className="flex flex-col gap-3">
      <Panel header={false} pad={0}>
        <div className="border-b border-obsidian-line px-4 py-3.5">
          <div className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            WORKSPACE
          </div>
          <div className="mt-1 font-medium text-fg-0">{account.name}</div>
          <div className="mono mt-0.5 text-[10.5px] text-fg-2">{plan}</div>
        </div>
        <div className="p-1">
          {SECTIONS.map((s) => {
            const active = section === s.k;
            const Icon = s.icon;
            return (
              <button
                key={s.k}
                onClick={() => onSection(s.k)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded px-3 py-2 text-left text-[12.5px] transition-colors",
                  active
                    ? "bg-accent/10 text-accent border-l-2 border-l-accent"
                    : "border-l-2 border-l-transparent text-fg-1 hover:bg-obsidian-2",
                )}
              >
                <Icon size={13} />
                {s.label}
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel
        header={false}
        pad={0}
        className={cn(
          "border",
          killArmed ? "border-up/30" : "border-down/30",
        )}
      >
        <div className="p-4">
          <div className={cn("mono flex items-center gap-2 text-[10px] uppercase tracking-[0.12em]", killArmed ? "text-up" : "text-down")}>
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                killArmed
                  ? "bg-up shadow-[0_0_6px_hsl(var(--up)/0.45)]"
                  : "bg-down shadow-[0_0_6px_hsl(var(--down)/0.45)]",
              )}
            />
            KILL SWITCH
          </div>
          <div className="mt-2 text-[12px] leading-[1.5] text-fg-1">
            {killArmed
              ? "Armed. Engine will auto-flatten if any trigger ladder fires at level 4."
              : "DISARMED. No automatic shutdown."}
          </div>
          <button
            onClick={() => onKillArmed(!killArmed)}
            className={cn(
              "mt-2.5 w-full rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors",
              killArmed
                ? "border-obsidian-line bg-obsidian-2 text-fg-1 hover:bg-obsidian-3"
                : "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20",
            )}
          >
            {killArmed ? "Disarm" : "Arm kill switch"}
          </button>
        </div>
      </Panel>
    </div>
  );
}
