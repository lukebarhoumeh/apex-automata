import { NavLink } from "react-router-dom";
import { Logo } from "@/components/apex/Logo";
import { NAV } from "./nav-config";
import { cn } from "@/lib/utils";
import { useSessionUptime } from "./useSessionUptime";

export function AppSidebar() {
  const uptime = useSessionUptime();

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

      {/* Session card */}
      <div className="mb-3 rounded-md border border-obsidian-line bg-obsidian-2 p-2.5">
        <div className="flex items-center justify-between">
          <span className="label">Session</span>
          <span className="dot-live" />
        </div>
        <div className="mono mt-1.5 text-[16px] font-medium text-fg-0">
          {uptime}
        </div>
        <div className="mt-0.5 text-[11px] text-fg-2">opened 14:02 UTC</div>
      </div>

      {/* Version footer */}
      <div className="flex items-center justify-between px-1">
        <span className="mono text-[10px] tracking-wider text-fg-2">
          v2.4.1 · main
        </span>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-up shadow-[0_0_0_2px_rgba(57,217,138,0.2)]" />
          <span className="mono text-[10px] uppercase tracking-wider text-fg-2">
            all systems
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
