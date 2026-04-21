import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRuntimeStatus } from "@/hooks/useRuntimeStatus";

interface ActiveSession {
  sessionId: string | null;
  sessionStartedAt: number | null;
  engineRunning: boolean;
  mode: "paper" | "live" | null;
}

const ActiveSessionContext = createContext<ActiveSession>({
  sessionId: null,
  sessionStartedAt: null,
  engineRunning: false,
  mode: null,
});

/**
 * Tracks the active trading session from /api/status and invalidates every
 * cached `["apex", ...]` React Query when the session_id changes — so a new
 * paper-trade run starts with a clean UI, not last run's state.
 */
export function ActiveSessionProvider({ children }: { children: React.ReactNode }) {
  const { data } = useRuntimeStatus();
  const queryClient = useQueryClient();
  const lastSessionId = useRef<string | null | undefined>(undefined);

  const value = useMemo<ActiveSession>(
    () => ({
      sessionId: data?.sessionId ?? null,
      sessionStartedAt: data?.sessionStartedAt ?? null,
      engineRunning: data?.engineRunning ?? false,
      mode: data?.mode ?? null,
    }),
    [data?.sessionId, data?.sessionStartedAt, data?.engineRunning, data?.mode],
  );

  useEffect(() => {
    const current = value.sessionId;
    const previous = lastSessionId.current;

    // First render after status loads — remember the baseline, don't wipe.
    if (previous === undefined) {
      lastSessionId.current = current;
      return;
    }

    if (current !== previous) {
      // Wipe every apex:* cache so stale session data doesn't leak across runs.
      queryClient.invalidateQueries({ queryKey: ["apex"] });
      lastSessionId.current = current;
    }
  }, [value.sessionId, queryClient]);

  return (
    <ActiveSessionContext.Provider value={value}>{children}</ActiveSessionContext.Provider>
  );
}

export function useActiveSession(): ActiveSession {
  return useContext(ActiveSessionContext);
}
