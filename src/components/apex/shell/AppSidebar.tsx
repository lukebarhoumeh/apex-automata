import { NavLink } from "react-router-dom";
import { Logo } from "@/components/apex/Logo";
import { NAV } from "./nav-config";
import { cn } from "@/lib/utils";
import { useActiveSession } from "@/runtime/session";
import { useConnectivity } from "@/runtime/connectivity";
import type { RuntimeConnectivity } from "@/runtime/connectivity/types";
import { useSessionUptime } from "./useSessionUptime";

const API_HOST = (() => {
  const raw = import.meta.env.VITE_RUNTIME_API_URL as string | undefined;
  if (!raw) return "localhost:3001";
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
})();

/** Bottom-left runtime chip — replaces the always-green "all systems" literal. */
function describeRuntimeLink(c: RuntimeConnectivity): { label: string; dotClass: string } {
  switch (c.state) {
    case "CONNECTED":
      return { label: "runtime live", dotClass: "bg-up shadow-[0_0_0_2px_rgba(57,217,138,0.2)]" };
    case "ENGINE_STOPPED":
      return { label: "engine stopped", dotClass: "bg-fg-3" };
    case "ENGINE_HALTED":
      return { label: "engine halted", dotClass: "bg-down shadow-[0_0_0_2px_rgba(255,90,106,0.2)]" };
    case "STALE":
      return { label: `stale ${Math.round(c.ageMs / 1000)}s`, dotClass: "bg-warn shadow-[0_0_0_2px_rgba(255,176,32,0.2)]" };
    case "BACKEND_DOWN":
      return { label: "backend down", dotClass: "bg-down shadow-[0_0_0_2px_rgba(255,90,106,0.2)]" };
    case "DISCONNECTED":
    default:
      return { label: "disconnected", dotClass: "bg-down shadow-[0_0_0_2px_rgba(255,90,106,0.2)]" };
  }
}

function openedLabel(startedAt: number | null): string {
  if (!startedAt) return "no active session";
  const d = new Date(startedAt);
  if (Number.isNaN(d.getTime())) return "no active session";
  return `opened ${d.toISOString().slice(11, 16)} UTC`;
}

export function AppSidebar() {
  const { sessionId, sessionStartedAt, mode } = useActiveSession();
  const connectivity = useConnectivity();
  const uptime = useSessionUptime(sessionId ? sessionStartedAt : null);
  const link = describeRuntimeLink(connectivity);

  return (
    <aside
      className="fixed left-0 top-0 z-40 flex h-screen w-[224px] flex-col border-r border-obsidian-line bg-obsidian-1 px-3.5 py-3.5"
      aria-label="Primary navigation"
    >
      {/* Logo + wordmark */}
      <div className="flex items-center gap-2.5 px-1 pt-1">
        <Logo />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] font-semibold leading-tight tracking-[-0.01em] text-fg-0">
            Apex Automata
          </span>
          <span className="mono text-[9px] uppercase tracking-[0.12em] text-fg-2">
            Execution Terminal
          </span>
        </div>
      </div>

      {/* Section label */}
      <div className="label mt-5 px-1">Terminal</div>

      {/* Nav */}
      <nav className="mt-2 flex flex-col gap-0.5">
        {NAV.map((item) => (
          <NavItem key={item.id} {...item} />
        ))}
      </nav>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Session card — real session from /api/status, never a mount-time clock */}
      <div
        className="mb-3 rounded-md border border-obsidian-line bg-obsidian-2 p-2.5"
        title={sessionId ? `Session ${sessionId}` : "No active session"}
        data-testid="sidebar-session"
      >
        <div className="flex items-center justify-between">
          <span className="label">{sessionId ? `${mode ?? "unknown"} session` : "Session"}</span>
          {sessionId ? (
            <span className="dot-live" />
          ) : (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-fg-3" />
          )}
        </div>
        <div className={cn("mono mt-1.5 text-[16px] font-medium", sessionId ? "text-fg-0" : "text-fg-3")}>
          {uptime}
        </div>
        <div className="mt-0.5 text-[11px] text-fg-2">{openedLabel(sessionId ? sessionStartedAt : null)}</div>
      </div>

      {/* Runtime footer */}
      <div className="flex items-center justify-between px-1">
        <span className="mono text-[10px] tracking-wider text-fg-2" title={`Runtime API ${API_HOST}`}>
          api · {API_HOST}
        </span>
        <div className="flex items-center gap-1.5" data-testid="sidebar-runtime-link">
          <span className={cn("inline-block h-1.5 w-1.5 rounded-full", link.dotClass)} />
          <span className="mono text-[10px] uppercase tracking-wider text-fg-2">
            {link.label}
          </span>
        </div>
      </div>
    </aside>
  );
}

function NavItem({ label, path, icon: Icon, kbd }: (typeof NAV)[number]) {
  return (
    <NavLink
      to={path}
      end={path === "/"}
      className={({ isActive }) =>
        cn(
          "group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors",
          isActive
            ? "bg-obsidian-2 text-fg-0"
            : "text-fg-1 hover:bg-obsidian-2 hover:text-fg-0",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              className="absolute -left-[14px] top-1 bottom-1 w-[2px] rounded-full bg-accent"
              style={{ boxShadow: "0 0 8px -1px hsl(var(--accent-glow))" }}
              aria-hidden
            />
          )}
          <Icon size={15} strokeWidth={1.5} />
          <span className="flex-1 text-[13px]">{label}</span>
          <kbd className="kbd">{kbd}</kbd>
        </>
      )}
    </NavLink>
  );
}
