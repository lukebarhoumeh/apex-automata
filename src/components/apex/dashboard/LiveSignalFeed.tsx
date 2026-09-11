import { Filter, ArrowDown, ArrowUp, CircleCheck, CircleX, Info, Radio, ShieldAlert } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { FeedEvent, FeedEventKind } from "@/types/signals";

interface LiveSignalFeedProps {
  initialEvents: readonly FeedEvent[];
  /** True while a paper session is running — the feed is session-scoped and truly live. */
  live?: boolean;
  className?: string;
}

const KIND_META: Record<
  FeedEventKind,
  { icon: typeof Info; label: string; tone: "up" | "down" | "warn" | "accent" | "info" | "default" }
> = {
  FILL:    { icon: CircleCheck, label: "FILL",    tone: "up" },
  SIGNAL:  { icon: ArrowUp,     label: "SIGNAL",  tone: "accent" },
  REGIME:  { icon: Radio,       label: "REGIME",  tone: "info" },
  REJECT:  { icon: CircleX,     label: "REJECT",  tone: "down" },
  RISK:    { icon: ShieldAlert, label: "RISK",    tone: "warn" },
  SESSION: { icon: Info,        label: "SESSION", tone: "default" },
};

export function LiveSignalFeed({ initialEvents, live = false, className }: LiveSignalFeedProps) {
  // Render the real feed straight from the upstream prop — useSignalFeed() polls
  // /signals on a 15s cadence via React Query, scoped to the active session and
  // with guardrails-killed strategies excluded. The previous implementation injected
  // synthetic pulses every 6s with KILLED strategy tags ("breakout", "vwap_mr") which
  // showed as live signals to operators; that lied about engine state during paper runs.
  return (
    <Panel
      header
      pad={0}
      title={live ? "Live signal feed" : "Signal feed"}
      subtitle={live ? "this session" : "recent · engine stopped"}
      right={
        <>
          <span className="flex items-center gap-1.5" data-testid="signal-feed-state">
            {live ? (
              <span className="dot-live" />
            ) : (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-fg-3" />
            )}
            <span className={cn("mono text-[11px]", live ? "text-fg-1" : "text-fg-3")}>
              {live ? "LIVE" : "IDLE"}
            </span>
          </span>
          <button
            type="button"
            className="ml-2 flex h-6 w-6 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-obsidian-2 hover:text-fg-1"
            aria-label="Filter feed"
          >
            <Filter size={13} strokeWidth={1.6} />
          </button>
        </>
      }
      className={className}
    >
      <div className="max-h-[520px] overflow-y-auto">
        {initialEvents.length === 0 && (
          <div className="mono px-4 py-6 text-[11px] text-fg-3">
            {live ? "No signals yet this session." : "No signals to show."}
          </div>
        )}
        <ul className="divide-y divide-obsidian-line">
          {initialEvents.map((ev, i) => (
            <FeedRow key={ev.id} event={ev} isNew={live && i === 0} />
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function FeedRow({ event, isNew }: { event: FeedEvent; isNew: boolean }) {
  const meta = KIND_META[event.kind];
  const Icon = meta.icon;
  const riskTone =
    event.risk === "HIGH" ? "down" : event.risk === "MED" ? "warn" : event.risk === "LOW" ? "up" : "default";

  return (
    <li
      className={cn(
        "grid grid-cols-[48px_1fr] gap-3 px-4 py-3",
        isNew && "animate-row-flash",
      )}
    >
      <div className="flex flex-col items-start gap-1">
        <span className="mono text-[10px] font-medium text-fg-2">{event.ts}</span>
        <Pill tone={meta.tone} className="!text-[9px]">
          <Icon size={9} strokeWidth={1.8} className="-mr-0.5" />
          {meta.label}
        </Pill>
      </div>

      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-fg-0">{event.msg}</div>
        <div className="mt-1 flex items-center gap-3 text-[10.5px] text-fg-2">
          <span className="mono uppercase tracking-[0.09em] text-fg-1">{event.tag}</span>
          {typeof event.score === "number" && (
            <span className="mono">score: {event.score.toFixed(2)}</span>
          )}
          {event.risk && (
            <span className={cn("mono", riskTone === "up" ? "text-up" : riskTone === "warn" ? "text-warn" : riskTone === "down" ? "text-down" : "text-fg-2")}>
              risk: {event.risk}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
