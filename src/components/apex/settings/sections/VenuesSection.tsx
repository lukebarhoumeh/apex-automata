import { Plug, Plus } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { SectionHeader } from "@/components/apex/settings/parts/SectionHeader";
import type { Venue } from "@/types/settings";

interface Props {
  venues: readonly Venue[];
}

/**
 * Venue cards. This section is fed only by `SETTINGS_SEED`: no venue here is
 * wired to the runtime, so a seeded "connected" venue renders as a DEMO
 * placeholder — never as LIVE with a latency and a key. Real exchange
 * credentials live in the backend `.env`; the UI never holds them.
 */
export function VenuesSection({ venues }: Props) {
  return (
    <Panel header={false} pad={0}>
      <SectionHeader
        icon={Plug}
        title="Venues · API keys"
        subtitle="Seeded placeholders — no venue on this page is connected; credentials come from the backend .env"
        tone="warn"
      />
      <div className="grid gap-3 p-5 md:grid-cols-2">
        {venues.map((v) => {
          const connected = v.status === "connected";
          return (
            <div
              key={v.name}
              className="rounded-md border border-obsidian-line bg-obsidian-2 p-4"
              data-testid={`venue-${v.name}`}
            >
              <div className="mb-3 flex items-start justify-between">
                <div>
                  <div className="text-[14px] font-semibold text-fg-0">{v.name}</div>
                  <div className="mono mt-0.5 text-[10.5px] text-fg-2">{v.kind}</div>
                </div>
                {connected ? (
                  <Pill tone="warn" className="whitespace-nowrap">DEMO · NOT CONNECTED</Pill>
                ) : (
                  <Pill tone="default">DISABLED</Pill>
                )}
              </div>
              {connected ? (
                <>
                  <div className="mono text-[10px] uppercase tracking-[0.12em] text-fg-2">
                    API KEY · SEED PLACEHOLDER
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="mono flex-1 rounded-md border border-obsidian-line bg-obsidian-1 px-2.5 py-1.5 text-[11px] text-fg-3">
                      no key issued (demo)
                    </div>
                    <button className="rounded-md border border-obsidian-line bg-obsidian-2 px-2 py-1 text-[10.5px] text-fg-1 hover:bg-obsidian-3">
                      Rotate
                    </button>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <button className="rounded-md px-2.5 py-1 text-[11px] text-down hover:bg-down/10">
                      Disconnect
                    </button>
                    <button className="rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1 text-[11px] text-fg-1 hover:bg-obsidian-3">
                      Permissions
                    </button>
                  </div>
                </>
              ) : (
                <button className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/20">
                  <Plus size={12} /> Connect
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
