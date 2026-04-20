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
  path: string;
  icon: LucideIcon;
  kbd: string;
}

export const NAV: readonly NavEntry[] = [
  { id: "dashboard", label: "Dashboard", path: "/", icon: LayoutGrid, kbd: "D" },
  { id: "orders", label: "Orders", path: "/orders", icon: ListOrdered, kbd: "O" },
  { id: "signals", label: "Signals", path: "/signals", icon: TrendingUp, kbd: "S" },
  { id: "risk", label: "Risk", path: "/risk", icon: Shield, kbd: "R" },
  { id: "model", label: "Model", path: "/model", icon: Brain, kbd: "M" },
  { id: "backtest", label: "Backtest", path: "/backtest", icon: FlaskConical, kbd: "B" },
  { id: "journal", label: "Journal", path: "/journal", icon: BookOpen, kbd: "J" },
  { id: "alerts", label: "Alerts", path: "/alerts", icon: Bell, kbd: "A" },
  { id: "settings", label: "Settings", path: "/settings", icon: SettingsIcon, kbd: "," },
];

export const TITLE_BY_PATH: Record<string, string> = Object.fromEntries(
  NAV.map((n) => [n.path, n.label]),
);
