import { useState } from "react";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { MetricsGridConnected } from "@/components/dashboard/MetricsGridConnected";
import { ChartSection } from "@/components/dashboard/ChartSection";
import { PositionsPanelConnected } from "@/components/dashboard/PositionsPanelConnected";
import { RiskControls } from "@/components/dashboard/RiskControls";
import { SignalsPanel } from "@/components/dashboard/SignalsPanel";
import { MarketConditions } from "@/components/dashboard/MarketConditions";
import { AlertsPanel } from "@/components/dashboard/AlertsPanel";
import { StrategiesPanel } from "@/components/dashboard/StrategiesPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTradingEngine } from "@/hooks/useTradingEngine";
import { useAuth } from "@/components/auth/AuthProvider";
import { AuthModal } from "@/components/auth/AuthModal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const Index = () => {
  const [botState, setBotState] = useState<"paper" | "live" | "paused">("paper");
  const [showAuthModal, setShowAuthModal] = useState(false);
  const tradingEngine = useTradingEngine();
  const { user, loading } = useAuth();

  // Show auth modal if not authenticated
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="h-16 w-16 rounded-lg bg-gradient-to-br from-primary to-accent animate-pulse mx-auto" />
          <p className="text-muted-foreground">Loading AtlasBot...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="terminal-grid fixed inset-0 pointer-events-none" />
        <div className="text-center space-y-6 max-w-md relative z-10">
          <div className="h-20 w-20 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-xl mx-auto">
            <span className="text-3xl font-bold text-white">A</span>
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              AtlasBot
            </h1>
            <p className="text-muted-foreground">
              Professional Automated Trading Platform
            </p>
          </div>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Sign in to access your trading dashboard, manage positions, and monitor your strategies.
            </p>
            <Button size="lg" onClick={() => setShowAuthModal(true)} className="w-full">
              Get Started
            </Button>
          </div>
        </div>
        <AuthModal open={showAuthModal} onOpenChange={setShowAuthModal} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="terminal-grid fixed inset-0 pointer-events-none" />
      
      <DashboardHeader botState={botState} onStateChange={setBotState} />
      
      <main className="container mx-auto p-4 lg:p-6 space-y-4 lg:space-y-6 relative z-10">
        {/* Status Bar */}
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Badge variant={user ? "default" : "secondary"}>
              {user.email}
            </Badge>
          </div>
          <Badge variant={tradingEngine.backendAvailable ? "default" : "secondary"}>
            {tradingEngine.backendAvailable ? "Backend Connected" : "DB Only Mode"}
          </Badge>
        </div>
        
        <MetricsGridConnected />
        
        <MarketConditions />
        
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-6">
          <div className="xl:col-span-2 space-y-4 lg:space-y-6">
            <ChartSection />
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
