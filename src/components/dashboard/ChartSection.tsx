import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, Activity, Maximize2, Settings } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const ChartSection = () => {
  return (
    <Card className="card-glow border-primary/20">
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">BTC-USD</CardTitle>
            <div className="flex items-center gap-2">
              <Tabs defaultValue="5m" className="w-auto">
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
            <Badge variant="outline" className="text-xs bg-primary/10 border-primary/40">
              <span className="text-muted-foreground">Last:</span>
              <span className="ml-1 font-mono font-semibold">$64,215.50</span>
            </Badge>
            <Badge variant="outline" className="text-xs bg-card">
              <span className="text-muted-foreground">VWAP:</span>
              <span className="ml-1 font-mono">$64,180</span>
            </Badge>
            <Badge variant="outline" className="text-xs bg-card">
              <span className="text-muted-foreground">ATR(14):</span>
              <span className="ml-1 font-mono">$342</span>
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
          {/* Chart Placeholder with Grid */}
          <div className="h-[450px] w-full bg-gradient-to-b from-muted/20 to-muted/5 rounded-lg border border-border/50 relative overflow-hidden">
            {/* Grid Background */}
            <div className="absolute inset-0 opacity-20">
              <div className="h-full w-full" 
                style={{
                  backgroundImage: `
                    linear-gradient(to right, hsl(var(--border)) 1px, transparent 1px),
                    linear-gradient(to bottom, hsl(var(--border)) 1px, transparent 1px)
                  `,
                  backgroundSize: '60px 60px'
                }}
              />
            </div>
            
            {/* Mock Price Line */}
            <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
            
            {/* Content */}
            <div className="relative h-full flex flex-col items-center justify-center p-8 text-center space-y-4">
              <div className="p-4 rounded-full bg-primary/10 border border-primary/20">
                <TrendingUp className="h-12 w-12 text-primary" />
              </div>
              <div className="space-y-2 max-w-md">
                <p className="text-sm text-muted-foreground">
                  Real-time candlestick chart with technical indicators
                </p>
                <div className="flex flex-wrap justify-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline" className="bg-card/50">VWAP</Badge>
                  <Badge variant="outline" className="bg-card/50">ATR Bands</Badge>
                  <Badge variant="outline" className="bg-card/50">Donchian</Badge>
                  <Badge variant="outline" className="bg-card/50">Entry/Exit Signals</Badge>
                </div>
              </div>
              
              {/* Mock Signal Markers */}
              <div className="absolute top-1/3 left-1/4 group">
                <div className="h-3 w-3 rounded-full bg-success animate-pulse-glow" />
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Badge className="text-xs bg-success/90">BUY +0.8R</Badge>
                </div>
              </div>
              
              <div className="absolute top-1/2 right-1/3 group">
                <div className="h-3 w-3 rounded-full bg-primary animate-pulse-glow" />
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Badge className="text-xs bg-primary/90">EXIT +1.2R</Badge>
                </div>
              </div>
            </div>
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
