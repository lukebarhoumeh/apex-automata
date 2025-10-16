import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  ListOrdered,
  TrendingUp,
  Shield,
  Brain,
  FlaskConical,
  BookOpen,
  Bell,
  Settings,
  Activity,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

const navItems = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Orders", url: "/orders", icon: ListOrdered },
  { title: "Signals", url: "/signals", icon: TrendingUp },
  { title: "Risk", url: "/risk", icon: Shield },
  { title: "Model", url: "/model", icon: Brain },
  { title: "Backtest", url: "/backtest", icon: FlaskConical },
  { title: "Journal", url: "/journal", icon: BookOpen },
  { title: "Alerts", url: "/alerts", icon: Bell },
  { title: "Settings", url: "/settings", icon: Settings },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();
  const currentPath = location.pathname;

  const isActive = (path: string) => {
    if (path === "/") return currentPath === "/";
    return currentPath.startsWith(path);
  };

  return (
    <Sidebar collapsible="icon" className="border-r border-border">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="font-mono text-xs">
            {!collapsed && "NAVIGATION"}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const active = isActive(item.url);
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      tooltip={collapsed ? item.title : undefined}
                      className={
                        active
                          ? "bg-primary/10 text-primary font-semibold border-l-2 border-primary"
                          : "hover:bg-muted/50"
                      }
                    >
                      <NavLink to={item.url} end={item.url === "/"}>
                        <item.icon className="h-4 w-4" />
                        {!collapsed && <span className="font-mono">{item.title}</span>}
                        {active && !collapsed && (
                          <Activity className="ml-auto h-3 w-3 animate-pulse text-primary" />
                        )}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
