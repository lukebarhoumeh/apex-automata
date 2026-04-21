import { User, Copy } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { SectionHeader } from "@/components/apex/settings/parts/SectionHeader";
import { FormRow } from "@/components/apex/settings/parts/FormRow";
import type { AccountInfo } from "@/types/settings";

interface Props {
  account: AccountInfo;
}

function TextField({ value, width = 320 }: { value: string; width?: number }) {
  return (
    <div
      className="rounded-md border border-obsidian-line bg-obsidian-2 px-3 py-2 text-[12.5px] text-fg-0"
      style={{ width }}
    >
      {value}
    </div>
  );
}

export function AccountSection({ account }: Props) {
  return (
    <Panel header={false} pad={0}>
      <SectionHeader
        icon={User}
        title="Account"
        subtitle="Your identity across Apex Automata"
        tone="accent"
      />
      <FormRow label="Display name">
        <TextField value={account.name} />
      </FormRow>
      <FormRow label="Email" hint="Used for account notifications and 2FA recovery.">
        <TextField value={account.email} />
      </FormRow>
      <FormRow label="Plan" hint="Billed annually. Renews 2027-01-04.">
        <div className="flex items-center gap-2">
          <span className="mono text-[13px]">{account.plan}</span>
          <Pill tone="accent">{account.seat}</Pill>
          <button className="ml-auto rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1 text-[11px] text-fg-1 hover:bg-obsidian-3">
            Manage billing →
          </button>
        </div>
      </FormRow>
      <FormRow label="Two-factor authentication" hint="TOTP via authenticator app.">
        <div className="flex items-center gap-2">
          <Pill tone="up">ENABLED</Pill>
          <button className="rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1 text-[11px] text-fg-1 hover:bg-obsidian-3">
            Regenerate recovery codes
          </button>
        </div>
      </FormRow>
      <FormRow
        label="API key · personal"
        hint="Automation against your workspace. Treat like a password."
      >
        <div className="flex items-center gap-2">
          <div
            className="mono rounded-md border border-obsidian-line bg-obsidian-2 px-3 py-2 text-[11.5px] text-fg-0"
            style={{ width: 320 }}
          >
            apex_live_sk_4aF3x•••••••••••••9zQp
          </div>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1 text-[11px] text-fg-1 hover:bg-obsidian-3">
            <Copy size={12} /> Copy
          </button>
          <button className="rounded-md px-2.5 py-1 text-[11px] text-down hover:bg-down/10">
            Revoke
          </button>
        </div>
      </FormRow>
      <div className="flex justify-end gap-2 px-5 py-3.5">
        <button className="rounded-md px-3 py-1.5 text-[12px] text-fg-1 hover:bg-obsidian-2">
          Cancel
        </button>
        <button className="rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/20">
          Save changes
        </button>
      </div>
    </Panel>
  );
}
