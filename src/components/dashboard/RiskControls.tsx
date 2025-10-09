import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Shield } from "lucide-react";
import { useState } from "react";

export const RiskControls = () => {
  const [perTradeRisk, setPerTradeRisk] = useState([0.7]);
  const [maxHeat, setMaxHeat] = useState([3.0]);
  const [dailyStopR, setDailyStopR] = useState([2.0]);
  const [killSwitchEnabled, setKillSwitchEnabled] = useState(true);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          Risk Management
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="per-trade-risk">Per-Trade Risk</Label>
            <span className="text-sm font-mono font-semibold text-primary">
              {perTradeRisk[0].toFixed(1)}%
            </span>
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
            Risk per position as % of equity
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="max-heat">Portfolio Heat Cap</Label>
            <span className="text-sm font-mono font-semibold text-warning">
              {maxHeat[0].toFixed(1)}%
            </span>
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
            <Label htmlFor="daily-stop">Daily Stop</Label>
            <span className="text-sm font-mono font-semibold text-destructive">
              -{dailyStopR[0].toFixed(1)}R
            </span>
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
            Halt new entries after losing this many R
          </p>
        </div>

        <div className="pt-4 border-t space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="kill-switch" className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                Kill-Switch
              </Label>
              <p className="text-xs text-muted-foreground">
                Auto-halt on extreme spread/ATR
              </p>
            </div>
            <Switch
              id="kill-switch"
              checked={killSwitchEnabled}
              onCheckedChange={setKillSwitchEnabled}
            />
          </div>

          {killSwitchEnabled && (
            <div className="space-y-3 pl-6 border-l-2 border-destructive/30">
              <div className="space-y-2">
                <Label htmlFor="spread-threshold" className="text-xs">
                  Spread Percentile Threshold
                </Label>
                <Input
                  id="spread-threshold"
                  type="number"
                  defaultValue={98}
                  min={90}
                  max={100}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="atr-burst" className="text-xs">
                  ATR Burst Multiplier
                </Label>
                <Input
                  id="atr-burst"
                  type="number"
                  defaultValue={3.0}
                  min={2.0}
                  max={5.0}
                  step={0.5}
                  className="h-8 text-xs"
                />
              </div>
            </div>
          )}
        </div>

        <Button className="w-full" size="sm">
          Apply Changes
        </Button>
      </CardContent>
    </Card>
  );
};
