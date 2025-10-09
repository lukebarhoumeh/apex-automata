import { useState } from "react";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { MetricsGrid } from "@/components/dashboard/MetricsGrid";
import { ChartSection } from "@/components/dashboard/ChartSection";
import { PositionsPanel } from "@/components/dashboard/PositionsPanel";
import { RiskControls } from "@/components/dashboard/RiskControls";
import { SignalsPanel } from "@/components/dashboard/SignalsPanel";
import { MarketConditions } from "@/components/dashboard/MarketConditions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const Index = () => {
  const [botState, setBotState] = useState<"paper" | "live" | "paused">("paper");

  return (
    <div className="min-h-screen bg-background">
      <div className="terminal-grid fixed inset-0 pointer-events-none" />
      
      <DashboardHeader botState={botState} onStateChange={setBotState} />
      
      <main className="container mx-auto p-4 lg:p-6 space-y-4 lg:space-y-6 relative z-10">
        <MetricsGrid />
        
        <MarketConditions />
        
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-6">
          <div className="xl:col-span-2 space-y-4 lg:space-y-6">
            <ChartSection />
            <PositionsPanel />
          </div>
          
          <div className="space-y-4 lg:space-y-6">
            <Tabs defaultValue="risk" className="w-full">
              <TabsList className="grid w-full grid-cols-2 bg-card">
                <TabsTrigger value="risk">Risk</TabsTrigger>
                <TabsTrigger value="signals">Signals</TabsTrigger>
              </TabsList>
              <TabsContent value="risk" className="mt-4">
                <RiskControls />
              </TabsContent>
              <TabsContent value="signals" className="mt-4">
                <SignalsPanel />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Index;
