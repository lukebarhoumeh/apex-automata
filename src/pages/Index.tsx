import { useState } from "react";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { MetricsGridConnected } from "@/components/dashboard/MetricsGridConnected";
import { ChartSection } from "@/components/dashboard/ChartSection";
import { PositionsPanelConnected } from "@/components/dashboard/PositionsPanelConnected";
import { OrdersBlotter } from "@/components/dashboard/OrdersBlotter";
import { RiskControls } from "@/components/dashboard/RiskControls";
import { RiskDashboard } from "@/components/dashboard/RiskDashboard";
import { SignalsPanel } from "@/components/dashboard/SignalsPanel";
import { LiveSignalsTable } from "@/components/dashboard/LiveSignalsTable";
import { LiveTickersPanel } from "@/components/dashboard/LiveTickersPanel";
import { MarketConditions } from "@/components/dashboard/MarketConditions";
import { AlertsPanel } from "@/components/dashboard/AlertsPanel";
import { StrategiesPanel } from "@/components/dashboard/StrategiesPanel";
import { StrategiesPluginPanel } from "@/components/dashboard/StrategiesPluginPanel";
import { RiskControlsPanel } from "@/components/dashboard/RiskControlsPanel";
import { SystemHealthPanel } from "@/components/dashboard/SystemHealthPanel";
import { EquityCurveChart } from "@/components/dashboard/EquityCurveChart";
import { SessionStatsPanel } from "@/components/dashboard/SessionStatsPanel";
import { TradeLogPanel } from "@/components/dashboard/TradeLogPanel";
import { SystemMetricsPanel } from "@/components/dashboard/SystemMetricsPanel";
import { RegimePanel } from "@/components/dashboard/RegimePanel";
import { MetaFilterPanel } from "@/components/dashboard/MetaFilterPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTradingEngine } from "@/hooks/useTradingEngine";
import { useTradingState } from "@/hooks/useTradingState";
import { Badge } from "@/components/ui/badge";
import { StaleDataWarning } from "@/components/dashboard/StaleDataWarning";
import { ConnectionStatusBanner } from "@/components/dashboard/ConnectionStatusBanner";
import { TradingStatePill, KillSwitchBanner, AlertModal } from "@/components/status";
import { 
  LayoutDashboard, 
  LineChart, 
  Shield, 
  Settings, 
  Activity,
  TrendingUp,
  BarChart3
} from "lucide-react";

const Index = () => {
  const [botState, setBotState] = useState<"paper" | "live" | "paused">("paper");
  const [activeView, setActiveView] = useState<"overview" | "trading" | "risk" | "settings">("overview");
  const tradingEngine = useTradingEngine();
  
  // Sprint 1.6: Unified trading state with alert handling
  const { tradingState, pendingAlert, dismissAlert } = useTradingState();

  const handleViewDetails = (id: string) => {
    console.log("View details for:", id);
  };

  return (
    <div className="relative min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Subtle grid overlay */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.02]" 
           style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)', backgroundSize: '20px 20px' }} 
      />
      
      {/* Alert Modal for critical events */}
      <AlertModal alert={pendingAlert} onClose={dismissAlert} />
      
      <DashboardHeader botState={botState} onStateChange={setBotState} />
      
      {/* Kill Switch Banner - persistent when active */}
      <KillSwitchBanner state={tradingState} />
      
      <main className="container mx-auto px-4 lg:px-6 py-4 lg:py-6 space-y-4 relative z-10">
        {/* Connection & Status Banners */}
        <ConnectionStatusBanner />
        
        <StaleDataWarning 
          lastUpdate={tradingEngine.lastUpdate}
          onRefresh={() => window.location.reload()}
        />
        
        {/* Navigation Tabs */}
        <Tabs value={activeView} onValueChange={(v) => setActiveView(v as any)} className="w-full">
          <div className="flex items-center justify-between mb-4">
            <TabsList className="bg-slate-800/50 border border-slate-700/50 p-1">
              <TabsTrigger value="overview" className="flex items-center gap-2 data-[state=active]:bg-emerald-600 data-[state=active]:text-white">
                <LayoutDashboard className="h-4 w-4" />
                <span className="hidden sm:inline">Overview</span>
              </TabsTrigger>
              <TabsTrigger value="trading" className="flex items-center gap-2 data-[state=active]:bg-emerald-600 data-[state=active]:text-white">
                <TrendingUp className="h-4 w-4" />
                <span className="hidden sm:inline">Trading</span>
              </TabsTrigger>
              <TabsTrigger value="risk" className="flex items-center gap-2 data-[state=active]:bg-emerald-600 data-[state=active]:text-white">
                <Shield className="h-4 w-4" />
                <span className="hidden sm:inline">Risk</span>
              </TabsTrigger>
              <TabsTrigger value="settings" className="flex items-center gap-2 data-[state=active]:bg-emerald-600 data-[state=active]:text-white">
                <Settings className="h-4 w-4" />
                <span className="hidden sm:inline">Config</span>
              </TabsTrigger>
            </TabsList>
            
            {/* Trading State Pill - Sprint 1.6 */}
            <div className="flex items-center gap-3">
              <TradingStatePill state={tradingState} />
              
              <Badge 
                variant={tradingEngine.backendAvailable ? "default" : "secondary"}
                className={tradingEngine.backendAvailable 
                  ? "bg-emerald-600/20 text-emerald-400 border border-emerald-600/30" 
                  : "bg-slate-700/50 text-slate-400"
                }
              >
                <Activity className="h-3 w-3 mr-1" />
                {tradingEngine.backendAvailable ? "Engine Connected" : "Offline"}
              </Badge>
            </div>
          </div>

          {/* Overview Tab - Key Metrics at a Glance */}
          <TabsContent value="overview" className="mt-0 space-y-4">
            {/* Top Metrics Row */}
            <MetricsGridConnected />
            
            {/* Performance + Session Stats */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2">
                <EquityCurveChart />
              </div>
              <SessionStatsPanel />
            </div>
            
            {/* Market Regime + System Health */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <RegimePanel />
              <SystemHealthPanel />
            </div>
            
            {/* Live Tickers */}
            <LiveTickersPanel />
          </TabsContent>

          {/* Trading Tab - Positions, Orders, Signals */}
          <TabsContent value="trading" className="mt-0 space-y-4">
            {/* Quick Metrics */}
            <MetricsGridConnected />
            
            {/* Charts */}
            <ChartSection />
            
            {/* Signals + Market Conditions */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <LiveSignalsTable />
              <MarketConditions />
            </div>
            
            {/* Positions and Orders */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <PositionsPanelConnected />
              <OrdersBlotter onViewDetails={handleViewDetails} />
            </div>
            
            {/* Trade Log */}
            <TradeLogPanel />
          </TabsContent>

          {/* Risk Tab - All Risk Controls and Analytics */}
          <TabsContent value="risk" className="mt-0 space-y-4">
            {/* Risk Summary Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <RiskControlsPanel />
              <MetaFilterPanel />
              <SystemMetricsPanel />
            </div>
            
            {/* Risk Dashboard */}
            <RiskDashboard />
            
            {/* Alerts */}
            <AlertsPanel />
          </TabsContent>

          {/* Settings Tab - Strategy and Risk Configuration */}
          <TabsContent value="settings" className="mt-0 space-y-4">
            {/* Strategy Configuration */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <StrategiesPluginPanel />
              <StrategiesPanel />
            </div>
            
            {/* Risk Configuration */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <RiskControls />
              <SignalsPanel />
            </div>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default Index;
