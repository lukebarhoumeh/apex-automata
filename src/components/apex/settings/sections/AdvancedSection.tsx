import { Terminal, Download } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { SectionHeader } from "@/components/apex/settings/parts/SectionHeader";
import { FormRow } from "@/components/apex/settings/parts/FormRow";
import { ToggleSwitch } from "@/components/apex/settings/parts/ToggleSwitch";

export function AdvancedSection() {
  return (
    <Panel header={false} pad={0}>
      <SectionHeader
        icon={Terminal}
        title="Advanced"
        subtitle="Power-user knobs. Proceed carefully."
        tone="fg-1"
      />
      <FormRow label="Log level" hint="DEBUG will fill disk quickly.">
        <div className="mono inline-flex rounded-md border border-obsidian-line bg-obsidian-2 px-3 py-2 text-[12px] text-fg-0" style={{ width: 200 }}>
          INFO
        </div>
      </FormRow>
      <FormRow label="Order timeout" hint="Cancel after no fill in N seconds.">
        <div className="mono inline-flex rounded-md border border-obsidian-line bg-obsidian-2 px-3 py-2 text-[12px] text-fg-0" style={{ width: 120 }}>
          30
        </div>
      </FormRow>
      <FormRow label="Paper-trade mode" hint="Route all orders to the simulator. No real capital at risk.">
        <ToggleSwitch on onChange={() => {}} />
      </FormRow>
      <FormRow label="Export workspace" hint="Download all rules, models, and journal entries.">
        <button className="inline-flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-2 px-3 py-1.5 text-[12px] text-fg-1 hover:bg-obsidian-3">
          <Download size={12} /> Export as .tar.gz
        </button>
      </FormRow>
      <FormRow label="Danger zone" hint="Irreversible. We cannot recover the data.">
        <div className="flex flex-col gap-2">
          <button
            className="rounded-md px-3 py-1.5 text-left text-[12px] text-down hover:bg-down/10"
            style={{ width: 260 }}
          >
            Reset all positions → paper
          </button>
          <button
            className="rounded-md px-3 py-1.5 text-left text-[12px] text-down hover:bg-down/10"
            style={{ width: 260 }}
          >
            Delete workspace
          </button>
        </div>
      </FormRow>
    </Panel>
  );
}
