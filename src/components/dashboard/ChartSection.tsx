import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, Activity, Maximize2, Settings } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTradingEngine } from "@/hooks/useTradingEngine";
import { useState, useEffect } from "react";
import { LivePriceChart } from "./LivePriceChart";

interface ChartSectionProps {
  symbol?: string;
}

export const ChartSection = ({ symbol = "BTC-USD" }: ChartSectionProps) => {
  const { lastTicker } = useTradingEngine();
  const [timeframe, setTimeframe] = useState<"1m" | "5m" | "15m" | "1h">("5m");
  
  // Extract live price data from ticker
  const livePrice = lastTicker?.price || lastTicker?.last;
  const vwap = lastTicker?.vwap;
  const atr = lastTicker?.atr;
  
  // Fallback to mock data if no live data
  const displayPrice = livePrice ? Number(livePrice).toFixed(2) : "64,215.50";
  const displayVwap = vwap ? Number(vwap).toFixed(2) : "64,180";
  const displayAtr = atr ? Number(atr).toFixed(0) : "342";
  return (
    <Card className="card-glow border-primary/20">
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">{symbol}</CardTitle>
            {lastTicker && (
              <Badge variant="outline" className="text-xs bg-success/10 border-success/40 animate-pulse-glow">
                LIVE
              </Badge>
            )}
            <div className="flex items-center gap-2">
              <Tabs value={timeframe} onValueChange={(v) => setTimeframe(v as any)} className="w-auto">
                <TabsList className="h-8 bg-muted/50">
                  <TabsTrigger value="1m" className="text-xs h-7">1m</TabsTrigger>
                  <TabsTrigger value="5m" className="text-xs h-7">5m</TabsTrigger>
                  <TabsTrigger value="15m" className="text-xs h-7">15m</TabsTrigger>
                  <TabsTrigger value="1h" className="text-xs h-7">1h</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>
          
          <div className="flex items-center gap-2 flex-wrap">
            <Badge 
              variant="outline" 
              className={`text-xs bg-primary/10 border-primary/40 ${lastTicker ? 'animate-fade-in' : ''}`}
            >
              <span className="text-muted-foreground">Last:</span>
              <span className="ml-1 font-mono font-semibold">${displayPrice}</span>
            </Badge>
            <Badge variant="outline" className="text-xs bg-card">
              <span className="text-muted-foreground">VWAP:</span>
              <span className="ml-1 font-mono">${displayVwap}</span>
            </Badge>
            <Badge variant="outline" className="text-xs bg-card">
              <span className="text-muted-foreground">ATR(14):</span>
              <span className="ml-1 font-mono">${displayAtr}</span>
            </Badge>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <Settings className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <Maximize2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative">
          {/* Live Price Chart */}
          <div className="h-[450px] w-full bg-gradient-to-b from-muted/20 to-muted/5 rounded-lg border border-border/50 relative overflow-hidden">
            <LivePriceChart symbol={symbol} height={450} />
          </div>
          
          {/* Legend */}
          <div className="flex items-center justify-between mt-4 px-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-success" />
                <span>Entry Signal</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-destructive" />
                <span>Stop Loss</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-primary" />
                <span>Take Profit</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-success">+1.8R today</span>
              <span>•</span>
              <span>Win rate: 75%</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
