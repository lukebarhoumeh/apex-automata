import {
  LayoutGrid,
  ListOrdered,
  TrendingUp,
  Shield,
  Brain,
  FlaskConical,
  BookOpen,
  Bell,
  Settings as SettingsIcon,
  type LucideIcon,
} from "lucide-react";

export interface NavEntry {
  id: string;
  label: string;
  /** Overrides `label` when shown in the top-bar breadcrumb. */
  breadcrumb?: string;
  path: string;
  icon: LucideIcon;
  kbd: string;
  /**
   * Page is still fed by `src/hooks/apex/mock/seed-data.ts` and is NOT a
   * paper-session source of truth. Rendered with a DEMO badge in the sidebar,
   * top bar and command palette; the page itself carries a DemoBanner.
   */
  demo?: boolean;
}

export const NAV: readonly NavEntry[] = [
  { id: "dashboard", label: "Dashboard", breadcrumb: "Overview", path: "/", icon: LayoutGrid, kbd: "D" },
  { id: "orders", label: "Orders", breadcrumb: "Orders & Positions", path: "/orders", icon: ListOrdered, kbd: "O" },
  { id: "signals", label: "Signals", path: "/signals", icon: TrendingUp, kbd: "S" },
  { id: "risk", label: "Risk", path: "/risk", icon: Shield, kbd: "R" },
  { id: "model", label: "Model", path: "/model", icon: Brain, kbd: "M", demo: true },
  { id: "backtest", label: "Backtest", path: "/backtest", icon: FlaskConical, kbd: "B", demo: true },
  { id: "journal", label: "Journal", path: "/journal", icon: BookOpen, kbd: "J", demo: true },
  { id: "alerts", label: "Alerts", path: "/alerts", icon: Bell, kbd: "A", demo: true },
  { id: "settings", label: "Settings", path: "/settings", icon: SettingsIcon, kbd: ",", demo: true },
];

export const TITLE_BY_PATH: Record<string, string> = Object.fromEntries(
  NAV.map((n) => [n.path, n.breadcrumb ?? n.label]),
);

/** Paths whose page is seeded demo data (see NavEntry.demo). */
export const DEMO_PATHS: ReadonlySet<string> = new Set(NAV.filter((n) => n.demo).map((n) => n.path));
