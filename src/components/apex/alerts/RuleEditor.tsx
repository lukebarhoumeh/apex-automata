import { Sliders, ArrowRight, Pause, Bell, Flag, Shield, Plus, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { cn } from "@/lib/utils";
import type { AlertRule, AlertActionKind } from "@/types/alerts";

interface Props {
  rule: AlertRule;
}

const ACTION_ICONS: Record<AlertActionKind, { Icon: LucideIcon; tone: string }> = {
  pause: { Icon: Pause, tone: "text-warn bg-warn/15" },
  notify: { Icon: Bell, tone: "text-accent bg-accent/15" },
  flag: { Icon: Flag, tone: "text-warn bg-warn/15" },
  block: { Icon: Shield, tone: "text-down bg-down/15" },
};

function FlowLabel({ label, tone }: { label: string; tone: "warn" | "down" }) {
  const cls =
    tone === "warn"
      ? "border-warn bg-warn/10 text-warn"
      : "border-down bg-down/10 text-down";
  return (
    <div
      className={cn(
        "mono grid place-items-center rounded-md border text-[11px] font-semibold uppercase tracking-[0.1em]",
        cls,
      )}
      style={{ width: 64 }}
    >
      {label}
    </div>
  );
}

function FlowBlock({
  tone,
  children,
  compact,
}: {
  tone: "warn" | "down" | "transparent";
  compact?: boolean;
  children: React.ReactNode;
}) {
  const border =
    tone === "warn"
      ? "border-warn/35"
      : tone === "down"
      ? "border-down/35"
      : "border-dashed border-obsidian-line-2";
  const bg = tone === "transparent" ? "bg-transparent" : "bg-obsidian-2";
  return (
    <div className={cn("rounded-md border", border, bg, compact ? "p-3" : "p-3.5")}>{children}</div>
  );
}

function FlowArrow() {
  return (
    <div className="grid place-items-center text-fg-3">
      <ArrowRight size={18} />
    </div>
  );
}

export function RuleEditor({ rule }: Props) {
  return (
    <Panel
      header
      pad={0}
      title="RULE BUILDER"
      right={
        <div className="flex items-center gap-2">
          <Sliders size={14} className="text-accent" strokeWidth={1.6} />
          <button className="rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1 text-[11px] text-fg-1 hover:bg-obsidian-3">
            Duplicate
          </button>
          <button className="rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1 text-[11px] text-fg-1 hover:bg-obsidian-3">
            Test fire
          </button>
          <button className="rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-accent/20">
            Save
          </button>
        </div>
      }
    >
      <div className="p-6">
        <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.12em] text-fg-2">RULE NAME</div>
        <div className="rounded-md border border-obsidian-line bg-obsidian-2 px-3 py-2 text-[14px] text-fg-0">
          {rule.name}
        </div>

        {/* WHEN */}
        <div
          className="mt-5 grid items-stretch gap-3"
          style={{ gridTemplateColumns: "auto 1fr auto 1fr" }}
        >
          <FlowLabel label="WHEN" tone="warn" />
          <FlowBlock tone="warn">
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <div className="flex-1 rounded-md border border-obsidian-line bg-obsidian-1 px-2.5 py-1.5 text-[11.5px]">
                  <span className="mono text-accent">{rule.when.source}</span>
                  <span className="text-fg-2">.</span>
                  <span className="mono text-fg-0">{rule.when.metric}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <div className="mono w-16 rounded-md border border-obsidian-line bg-obsidian-1 px-2.5 py-1.5 text-center text-[11.5px] text-fg-0">
                  {rule.when.op}
                </div>
                <div className="mono flex-1 rounded-md border border-obsidian-line bg-obsidian-1 px-2.5 py-1.5 text-[11.5px] text-fg-0">
                  {rule.when.value}
                </div>
                <span className="mono self-center text-[11px] text-fg-2">
                  {rule.when.unit || "—"}
                </span>
              </div>
              <div className="mt-1 flex gap-2">
                <button className="mono inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10.5px] text-fg-2 hover:text-fg-0">
                  <Plus size={10} /> Add AND
                </button>
                <button className="mono inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10.5px] text-fg-2 hover:text-fg-0">
                  <Plus size={10} /> Add OR
                </button>
              </div>
            </div>
          </FlowBlock>
          <FlowArrow />
          <FlowBlock tone="transparent" compact>
            <div className="mono text-[10px] uppercase text-fg-2">EVALUATION</div>
            <div className="mono mt-1 text-[11px] text-fg-0">every 1s · 7d window</div>
            <div className="mono mt-0.5 text-[11px] text-fg-2">cooldown: 5min</div>
          </FlowBlock>
        </div>

        {/* THEN */}
        <div
          className="mt-4 grid items-stretch gap-3"
          style={{ gridTemplateColumns: "auto 1fr auto 1fr" }}
        >
          <FlowLabel label="THEN" tone="down" />
          <FlowBlock tone="down">
            <div className="flex flex-col gap-2">
              {rule.then.map((a, i) => {
                const config = ACTION_ICONS[a.kind];
                const { Icon } = config;
                return (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-2"
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className={cn(
                          "grid h-6 w-6 place-items-center rounded",
                          config.tone,
                        )}
                      >
                        <Icon size={12} />
                      </div>
                      <span className="text-[12px] font-medium uppercase tracking-wider text-fg-0">
                        {a.kind}
                      </span>
                      <span className="mono text-[11px] text-fg-2">
                        → {a.target || a.channel}
                      </span>
                    </div>
                    <button className="rounded p-1 text-fg-3 hover:text-fg-0">
                      <X size={10} />
                    </button>
                  </div>
                );
              })}
              <button className="mono inline-flex self-start items-center gap-1 rounded px-2 py-0.5 text-[10.5px] text-fg-2 hover:text-fg-0">
                <Plus size={10} /> Add action
              </button>
            </div>
          </FlowBlock>
          <FlowArrow />
          <FlowBlock tone="transparent" compact>
            <div className="mono text-[10px] uppercase text-fg-2">EXECUTION</div>
            <div className="mono mt-1 text-[11px] text-fg-0">parallel · fire-and-forget</div>
            <div className="mono mt-0.5 text-[11px] text-fg-2">retry: 3× · backoff 2s</div>
          </FlowBlock>
        </div>

        {/* Compiled rule preview */}
        <div className="mono mt-6 rounded-md border border-obsidian-line bg-obsidian-2 p-3.5 text-[12px] leading-[1.6]">
          <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.12em] text-fg-2">
            COMPILED RULE
          </div>
          <div className="text-fg-1">
            <span className="text-warn">WHEN</span>{" "}
            <span className="text-accent">
              {rule.when.source}.{rule.when.metric}
            </span>{" "}
            <span className="text-fg-0">
              {rule.when.op} {rule.when.value}
              {rule.when.unit}
            </span>
          </div>
          <div className="mt-1 text-fg-1">
            <span className="text-down">THEN</span>{" "}
            {rule.then.map((a, i) => (
              <span key={i}>
                <span className="text-accent">{a.kind}</span>
                <span className="text-fg-0">({a.target || a.channel})</span>
                {i < rule.then.length - 1 && <span className="text-fg-2">, </span>}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}
