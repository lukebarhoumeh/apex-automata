import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Shield, Check } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";

export const RiskControls = () => {
  const [perTradeRisk, setPerTradeRisk] = useState([0.7]);
  const [maxHeat, setMaxHeat] = useState([3.0]);
  const [dailyStopR, setDailyStopR] = useState([2.0]);
  const [killSwitchEnabled, setKillSwitchEnabled] = useState(true);

  return (
    <Card className="card-glow border-primary/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          Risk Management
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="per-trade-risk" className="text-sm font-medium">
              Per-Trade Risk
            </Label>
            <Badge variant="outline" className="font-mono text-sm font-bold bg-primary/10 border-primary/40">
              {perTradeRisk[0].toFixed(1)}%
            </Badge>
          </div>
          <Slider
            id="per-trade-risk"
            min={0.3}
            max={1.5}
            step={0.1}
            value={perTradeRisk}
            onValueChange={setPerTradeRisk}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Risk per position as % of total equity
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="max-heat" className="text-sm font-medium">
              Portfolio Heat Cap
            </Label>
            <Badge variant="outline" className="font-mono text-sm font-bold bg-warning/10 border-warning/40">
              {maxHeat[0].toFixed(1)}%
            </Badge>
          </div>
          <Slider
            id="max-heat"
            min={1.0}
            max={5.0}
            step={0.5}
            value={maxHeat}
            onValueChange={setMaxHeat}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Maximum total open risk across all positions
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="daily-stop" className="text-sm font-medium">
              Daily Stop Loss
            </Label>
            <Badge variant="outline" className="font-mono text-sm font-bold bg-destructive/10 border-destructive/40 text-destructive">
              -{dailyStopR[0].toFixed(1)}R
            </Badge>
          </div>
          <Slider
            id="daily-stop"
            min={1.0}
            max={5.0}
            step={0.5}
            value={dailyStopR}
            onValueChange={setDailyStopR}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Halt new entries after losing this many R units
          </p>
        </div>

        <div className="pt-4 border-t space-y-4">
          <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
            <div className="space-y-0.5">
              <Label htmlFor="kill-switch" className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                Kill-Switch Protection
              </Label>
              <p className="text-xs text-muted-foreground">
                Auto-halt on extreme market conditions
              </p>
            </div>
            <Switch
              id="kill-switch"
              checked={killSwitchEnabled}
              onCheckedChange={setKillSwitchEnabled}
            />
          </div>

          {killSwitchEnabled && (
            <div className="space-y-3 p-4 rounded-lg border-2 border-destructive/20 bg-destructive/5 animate-slide-up">
              <div className="space-y-2">
                <Label htmlFor="spread-threshold" className="text-xs font-medium flex items-center gap-2">
                  Spread Percentile Threshold
                  <Badge variant="outline" className="text-xs bg-card">98%</Badge>
                </Label>
                <Input
                  id="spread-threshold"
                  type="number"
                  defaultValue={98}
                  min={90}
                  max={100}
                  className="h-9 font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Trigger when spread exceeds this percentile
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="atr-burst" className="text-xs font-medium flex items-center gap-2">
                  ATR Burst Multiplier
                  <Badge variant="outline" className="text-xs bg-card">3.0x</Badge>
                </Label>
                <Input
                  id="atr-burst"
                  type="number"
                  defaultValue={3.0}
                  min={2.0}
                  max={5.0}
                  step={0.5}
                  className="h-9 font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Trigger when volatility spikes beyond normal ATR
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="pt-2 space-y-3">
          <div className="p-3 rounded-lg bg-success/5 border border-success/20">
            <div className="flex items-center gap-2 text-xs text-success">
              <Check className="h-4 w-4" />
              <span className="font-medium">All risk controls active and healthy</span>
            </div>
          </div>
          
          <Button className="w-full shadow-lg" size="lg">
            Apply Changes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
