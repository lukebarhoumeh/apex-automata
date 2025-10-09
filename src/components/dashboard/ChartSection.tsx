import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Activity } from "lucide-react";

export const ChartSection = () => {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            BTC-USD 5m
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              VWAP: $64,215
            </Badge>
            <Badge variant="outline" className="text-xs">
              ATR(14): $342
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[400px] w-full bg-muted/30 rounded-md flex items-center justify-center border border-border/50">
          <div className="text-center space-y-2">
            <TrendingUp className="h-16 w-16 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">
              Chart visualization will show 5m bars with VWAP, ATR bands, and Donchian levels
            </p>
            <p className="text-xs text-muted-foreground">
              Entry/exit signals overlaid with tooltips
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
