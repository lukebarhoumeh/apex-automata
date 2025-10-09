import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, TrendingUp, TrendingDown, Zap, BarChart3 } from "lucide-react";
import { Progress } from "@/components/ui/progress";

export const MarketConditions = () => {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Card className="card-glow border-primary/20 bg-gradient-to-br from-card to-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Market Regime
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Badge className="bg-primary/20 text-primary border-primary/40">
                TRENDING
              </Badge>
              <span className="text-sm text-muted-foreground">ADX: 24.5</span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Volatility</span>
                <span className="text-warning font-medium">Elevated</span>
              </div>
              <Progress value={72} className="h-1.5" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="card-glow border-success/20 bg-gradient-to-br from-card to-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-success" />
            Volume Profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-2xl font-bold text-success">$1.42B</span>
              <Badge variant="outline" className="text-xs bg-success/10 border-success/40">
                +18.3%
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-muted-foreground">Buy Vol</div>
                <div className="font-medium text-success">58.2%</div>
              </div>
              <div>
                <div className="text-muted-foreground">Sell Vol</div>
                <div className="font-medium text-destructive">41.8%</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="card-glow border-accent/20 bg-gradient-to-br from-card to-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Zap className="h-4 w-4 text-accent" />
            Funding Rate
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-2xl font-bold text-accent">+0.0085%</span>
              <Badge variant="outline" className="text-xs">
                8h
              </Badge>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Long/Short</span>
                <span className="text-success font-medium">52/48</span>
              </div>
              <Progress value={52} className="h-1.5" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="card-glow border-warning/20 bg-gradient-to-br from-card to-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-warning" />
            Orderbook Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Badge className="bg-success/20 text-success border-success/40">
                HEALTHY
              </Badge>
              <span className="text-sm text-muted-foreground">Depth: $12M</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-muted-foreground">Spread</div>
                <div className="font-medium">0.02%</div>
              </div>
              <div>
                <div className="text-muted-foreground">OBI</div>
                <div className="font-medium text-success">+0.24</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
