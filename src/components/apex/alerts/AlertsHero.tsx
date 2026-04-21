import { Bell } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import type { AlertRule, AlertFiredEvent } from "@/types/alerts";

interface Props {
  rules: readonly AlertRule[];
  fired: readonly AlertFiredEvent[];
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between text-[11.5px]">
      <span className="mono text-[10px] uppercase text-fg-2">{k}</span>
      <span className="mono text-fg-0">{v}</span>
    </div>
  );
}

export function AlertsHero({ rules, fired }: Props) {
  const enabled = rules.filter((r) => r.enabled).length;
  const totalFired = rules.reduce((s, r) => s + r.fired, 0);
  const warn = fired.filter((a) => a.level === "warn").length;
  const danger = fired.filter((a) => a.level === "danger").length;

  return (
    <Panel header={false} pad={0} className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          background:
            "linear-gradient(135deg, hsl(var(--obsidian-1)) 0%, #13100d 60%, hsl(var(--obsidian-1)) 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute"
        style={{
          top: -120,
          right: -80,
          width: 340,
          height: 340,
          borderRadius: "50%",
          background: "radial-gradient(circle, hsl(var(--down) / 0.28) 0%, transparent 70%)",
          opacity: 0.45,
        }}
      />
      <div className="relative grid gap-7 p-7" style={{ gridTemplateColumns: "1.2fr 1fr 1fr" }}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Pill tone="down">
              <Bell size={10} strokeWidth={2} /> RULES ENGINE
            </Pill>
            <Pill tone="default">
              {rules.length} RULES · {enabled} ACTIVE
            </Pill>
          </div>
          <div
            className="serif-ital text-fg-0"
            style={{ fontSize: 38, lineHeight: 1.05, fontWeight: 500, letterSpacing: "-0.02em" }}
          >
            <span className="text-down">When</span> X,
            <br />
            then do Y.
          </div>
          <p className="max-w-[380px] text-[12.5px] leading-[1.55] text-fg-1">
            Conditional rules run continuously against your portfolio, risk, system, and model
            streams. Configure actions; trust the kill switch.
          </p>
        </div>

        <div className="flex flex-col gap-3 border-l border-obsidian-line px-6">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            LAST 24H
          </span>
          <div>
            <div
              className="mono text-[48px] font-medium text-warn leading-none"
              style={{ textShadow: "0 0 20px rgba(255,196,87,0.3)" }}
            >
              {totalFired}
            </div>
            <div className="mono mt-1 text-[10px] uppercase text-fg-2">TRIGGERS</div>
          </div>
          <div className="mt-1 flex gap-5">
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">WARN</div>
              <div className="mono text-[17px] text-warn">{warn}</div>
            </div>
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">CRIT</div>
              <div className="mono text-[17px] text-down">{danger}</div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-l border-obsidian-line px-6">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            CHANNELS
          </span>
          <Row k="SLACK" v="#trading-alerts" />
          <Row k="EMAIL" v="jordan@..." />
          <Row k="PAGERDUTY" v="Primary" />
          <Row k="SMS" v="disabled" />
          <Row k="WEBHOOK" v="disabled" />
        </div>
      </div>
    </Panel>
  );
}
