import { useState } from "react";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { MetricsGridConnected } from "@/components/dashboard/MetricsGridConnected";
import { ChartSection } from "@/components/dashboard/ChartSection";
import { PositionsPanelConnected } from "@/components/dashboard/PositionsPanelConnected";
import { OrdersBlotter } from "@/components/dashboard/OrdersBlotter";
import { RiskControls } from "@/components/dashboard/RiskControls";
import { SignalsPanel } from "@/components/dashboard/SignalsPanel";
import { MarketConditions } from "@/components/dashboard/MarketConditions";
import { AlertsPanel } from "@/components/dashboard/AlertsPanel";
import { StrategiesPanel } from "@/components/dashboard/StrategiesPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTradingEngine } from "@/hooks/useTradingEngine";
import { Badge } from "@/components/ui/badge";

const Index = () => {
  const [botState, setBotState] = useState<"paper" | "live" | "paused">("paper");
  const tradingEngine = useTradingEngine();

  const handleViewDetails = (id: string) => {
    console.log("View details for:", id);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="terminal-grid fixed inset-0 pointer-events-none" />
      
      <DashboardHeader botState={botState} onStateChange={setBotState} />
      
      <main className="container mx-auto p-4 lg:p-6 space-y-4 lg:space-y-6 relative z-10">
        {/* Status Bar */}
        <div className="flex justify-end items-center">
          <Badge variant={tradingEngine.backendAvailable ? "default" : "secondary"}>
            {tradingEngine.backendAvailable ? "Backend Connected" : "DB Only Mode"}
          </Badge>
        </div>
        
        <MetricsGridConnected />
        
        <MarketConditions />
        
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-6">
          <div className="xl:col-span-2 space-y-4 lg:space-y-6">
            <ChartSection />
            <OrdersBlotter onViewDetails={handleViewDetails} />
            <PositionsPanelConnected />
          </div>
          
          <div className="space-y-4 lg:space-y-6">
            <Tabs defaultValue="strategies" className="w-full">
              <TabsList className="grid w-full grid-cols-4 bg-card text-xs">
                <TabsTrigger value="strategies">Strategies</TabsTrigger>
                <TabsTrigger value="risk">Risk</TabsTrigger>
                <TabsTrigger value="signals">Signals</TabsTrigger>
                <TabsTrigger value="alerts">Alerts</TabsTrigger>
              </TabsList>
              <TabsContent value="strategies" className="mt-4">
                <StrategiesPanel />
              </TabsContent>
              <TabsContent value="risk" className="mt-4">
                <RiskControls />
              </TabsContent>
              <TabsContent value="signals" className="mt-4">
                <SignalsPanel />
              </TabsContent>
              <TabsContent value="alerts" className="mt-4">
                <AlertsPanel />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Index;
