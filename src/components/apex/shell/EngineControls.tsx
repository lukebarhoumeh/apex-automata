import { Play, Square, Power, Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { runtimeClient } from "@/services/runtimeClient";
import { useActiveSession } from "@/runtime/session";
import { useConnectivity } from "@/runtime/connectivity";
import { useRuntimeStatus } from "@/hooks/useRuntimeStatus";
import { deriveEnginePill, type EnginePillTone } from "@/runtime/state/deriveEnginePill";
import { cn } from "@/lib/utils";

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || "http://localhost:3001";

async function killEngine(): Promise<{ success: boolean; message?: string }> {
  const res = await fetch(`${API_URL}/api/engine/kill`, { method: "POST" });
  if (!res.ok) throw new Error(`Kill failed: ${res.status}`);
  return res.json();
}

const PILL_CLASSES: Record<EnginePillTone, { box: string; dot: string }> = {
  up:    { box: "border-up/30 bg-up/10 text-up",                dot: "bg-up shadow-[0_0_0_2px_hsl(var(--up)/0.25)]" },
  live:  { box: "border-down/50 bg-down/15 text-down",          dot: "bg-down shadow-[0_0_0_2px_hsl(var(--down)/0.3)] animate-pulse" },
  warn:  { box: "border-warn/40 bg-warn/10 text-warn",          dot: "bg-warn shadow-[0_0_0_2px_hsl(var(--warn)/0.25)]" },
  down:  { box: "border-down/40 bg-down/10 text-down",          dot: "bg-down shadow-[0_0_0_2px_hsl(var(--down)/0.25)]" },
  muted: { box: "border-obsidian-line bg-obsidian-2 text-fg-2", dot: "bg-fg-3" },
};

export function EngineControls() {
  const { engineRunning } = useActiveSession();
  const { data: status } = useRuntimeStatus();
  const connectivity = useConnectivity();
  const pill = deriveEnginePill(status, connectivity);
  const pillClasses = PILL_CLASSES[pill.tone];
  const queryClient = useQueryClient();

  const bumpStatus = () => {
    queryClient.invalidateQueries({ queryKey: ["runtime-status"] });
  };

  const start = useMutation({
    mutationFn: () => runtimeClient.startEngine("paper"),
    onSuccess: () => {
      toast.success("Paper session started", { description: "Fresh run — old state cleared." });
      bumpStatus();
    },
    onError: (err: Error) => toast.error("Start failed", { description: err.message }),
  });

  const stop = useMutation({
    mutationFn: () => runtimeClient.stopEngine(),
    onSuccess: () => {
      toast.success("Engine stopped");
      bumpStatus();
    },
    onError: (err: Error) => toast.error("Stop failed", { description: err.message }),
  });

  const kill = useMutation({
    mutationFn: killEngine,
    onSuccess: () => {
      toast.warning("Kill switch activated");
      bumpStatus();
    },
    onError: (err: Error) => toast.error("Kill failed", { description: err.message }),
  });

  const busy = start.isPending || stop.isPending || kill.isPending;

  return (
    <div className="flex items-center gap-2">
      {/* Status pill — derived from /api/status + connectivity, never defaults to "paper" */}
      <div
        data-testid="engine-pill"
        className={cn(
          "mono flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] uppercase tracking-[0.12em]",
          pillClasses.box,
        )}
        title={pill.title}
      >
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", pillClasses.dot)} />
        {pill.label}
      </div>

      {/* Start / Stop */}
      {engineRunning ? (
        <button
          type="button"
          onClick={() => stop.mutate()}
          disabled={busy}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1.5 text-[11px] font-medium text-fg-1 transition-colors",
            "hover:bg-obsidian-3 disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {stop.isPending ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
          <span className="mono uppercase tracking-wider">Stop</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => start.mutate()}
          disabled={busy}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-up/40 bg-up/10 px-2.5 py-1.5 text-[11px] font-medium text-up transition-colors",
            "hover:bg-up/20 hover:border-up/60 disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {start.isPending ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          <span className="mono uppercase tracking-wider">Start paper</span>
        </button>
      )}

      {/* Kill */}
      <button
        type="button"
        onClick={() => kill.mutate()}
        disabled={busy || !engineRunning}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-down/40 bg-down/10 px-2.5 py-1.5 text-[11px] font-medium text-down transition-colors",
          "hover:bg-down/20 hover:border-down/60 disabled:opacity-40 disabled:cursor-not-allowed",
        )}
        title="Activate kill switch (halts trading, keeps runtime)"
      >
        {kill.isPending ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} strokeWidth={1.8} />}
        <span className="mono uppercase tracking-wider">Kill</span>
      </button>
    </div>
  );
}
