import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, Maximize2, Settings } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useTradingEngine } from "@/hooks/useTradingEngine";
import { useState } from "react";
import { CandleChart } from "./CandleChart";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface ChartSectionProps {
  symbol?: string;
}

export const ChartSection = ({ symbol = "BTC-USD" }: ChartSectionProps) => {
  const { lastTicker } = useTradingEngine();
  const [timeframe, setTimeframe] = useState<"1m" | "5m" | "15m">("1m");
  const [showVwap, setShowVwap] = useState(true);
  const [showDonchian, setShowDonchian] = useState(true);
  
  // Extract live price data from ticker
  const livePrice = lastTicker?.price || lastTicker?.last;
  const vwap = lastTicker?.vwap;
  const atr = lastTicker?.atr;
  
  // Fallback to mock data if no live data
  const displayPrice = livePrice ? Number(livePrice).toFixed(2) : "—";
  const displayVwap = vwap ? Number(vwap).toFixed(2) : "—";
  const displayAtr = atr ? Number(atr).toFixed(0) : "—";

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
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <Settings className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-56" align="end">
                  <div className="space-y-4">
                    <h4 className="font-medium text-sm">Chart Overlays</h4>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="vwap" className="text-sm">VWAP Line</Label>
                      <Switch 
                        id="vwap" 
                        checked={showVwap} 
                        onCheckedChange={setShowVwap} 
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="donchian" className="text-sm">Donchian (20)</Label>
                      <Switch 
                        id="donchian" 
                        checked={showDonchian} 
                        onCheckedChange={setShowDonchian} 
                      />
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <Maximize2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative">
          {/* Candle Chart with Overlays */}
          <div className="h-[450px] w-full bg-gradient-to-b from-muted/20 to-muted/5 rounded-lg border border-border/50 relative overflow-hidden">
            <CandleChart 
              symbol={symbol} 
              height={450} 
              timeframe={timeframe}
              showVwap={showVwap}
              showDonchian={showDonchian}
            />
          </div>
          
          {/* Legend */}
          <div className="flex items-center justify-between mt-4 px-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="h-0 w-4 border-t-2 border-dashed border-blue-500" />
                <span>Donchian</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-0 w-4 border-t-2 border-primary" />
                <span>VWAP</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-b-[6px] border-transparent border-b-success" />
                <span>Long Signal</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-transparent border-t-destructive" />
                <span>Short Signal</span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
