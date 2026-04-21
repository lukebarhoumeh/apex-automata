import { Bell, Mail, Phone, Terminal, Slack } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { SectionHeader } from "@/components/apex/settings/parts/SectionHeader";
import { ToggleSwitch } from "@/components/apex/settings/parts/ToggleSwitch";
import { cn } from "@/lib/utils";
import type { NotificationChannel } from "@/types/settings";

interface Props {
  notifs: readonly NotificationChannel[];
  onChange: (next: NotificationChannel[]) => void;
}

const CHANNEL_ICONS: Record<string, LucideIcon> = {
  Slack: Slack,
  Email: Mail,
  PagerDuty: Bell,
  SMS: Phone,
  Webhook: Terminal,
};

export function NotificationsSection({ notifs, onChange }: Props) {
  const toggle = (i: number) => {
    onChange(
      notifs.map((n, j) => (i === j ? { ...n, enabled: !n.enabled } : n)) as NotificationChannel[],
    );
  };

  return (
    <Panel header={false} pad={0}>
      <SectionHeader
        icon={Bell}
        title="Notifications"
        subtitle="Where the system reaches you"
        tone="warn"
      />
      <table className="w-full">
        <thead>
          <tr className="border-b border-obsidian-line">
            {["CHANNEL", "TARGET", "TEST", "ENABLED"].map((h) => (
              <th
                key={h}
                className="mono px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-[0.1em] text-fg-2"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {notifs.map((n, i) => {
            const Icon = CHANNEL_ICONS[n.channel] ?? Bell;
            return (
              <tr key={n.channel} className="border-b border-obsidian-line/60">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={cn(
                        "grid h-7 w-7 place-items-center rounded border border-obsidian-line bg-obsidian-2",
                        n.enabled ? "text-accent" : "text-fg-3",
                      )}
                    >
                      <Icon size={14} />
                    </div>
                    <span className="font-medium text-fg-0">{n.channel}</span>
                  </div>
                </td>
                <td className="mono px-4 py-3 text-[11.5px] text-fg-1">{n.target}</td>
                <td className="px-4 py-3">
                  <button className="rounded-md border border-obsidian-line bg-obsidian-2 px-2 py-0.5 text-[10.5px] text-fg-1 hover:bg-obsidian-3">
                    Send test
                  </button>
                </td>
                <td className="px-4 py-3">
                  <ToggleSwitch on={n.enabled} onChange={() => toggle(i)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
