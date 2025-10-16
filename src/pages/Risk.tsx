import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useRiskSettings } from "@/hooks/useRiskSettings";
import { Shield, AlertTriangle, TrendingDown, Save, Calculator } from "lucide-react";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";

const Risk = () => {
  const { toast } = useToast();
  const { data: settings, isLoading } = useRiskSettings();
  const [hasChanges, setHasChanges] = useState(false);

  // Local state for form
  const [perTradeRisk, setPerTradeRisk] = useState(0.7);
  const [maxHeat, setMaxHeat] = useState(3.0);
  const [dailyStopR, setDailyStopR] = useState(2.0);
  const [spreadThreshold, setSpreadThreshold] = useState(98);
  const [atrBurstMult, setAtrBurstMult] = useState(3.0);
  const [killSwitchEnabled, setKillSwitchEnabled] = useState(true);

  // Mock current price for size calculator
  const mockCurrentPrice = 42500;
  const mockATR = 850;

  useEffect(() => {
    if (settings) {
      setPerTradeRisk(settings.per_trade_risk);
      setMaxHeat(settings.max_heat);
      setDailyStopR(settings.daily_stop_r);
      setSpreadThreshold(settings.spread_threshold);
      setAtrBurstMult(settings.atr_burst_multiplier);
      setKillSwitchEnabled(settings.kill_switch_enabled);
    }
  }, [settings]);

  const handleSave = async () => {
    try {
      const { runtimeClient } = await import("@/services/runtimeClient");
      await runtimeClient.updateRiskConfig({
        perTradeBp: perTradeRisk * 100,
        heatBp: maxHeat * 100,
        dailyStopR: dailyStopR,
        spreadPctileMax: spreadThreshold,
        atrBurstMult: atrBurstMult,
      });
      
      toast({
        title: "Risk Configuration Updated",
        description: "New risk parameters have been applied to the runtime",
      });
      setHasChanges(false);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save configuration",
        variant: "destructive",
      });
    }
  };

  // Calculate position size
  const calculateSize = () => {
    const accountEquity = 100000; // Mock
    const riskAmount = accountEquity * (perTradeRisk / 100);
    const stopDistance = mockATR * 1.5; // Example stop at 1.5 ATR
    const qty = riskAmount / stopDistance;
    return qty;
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-muted-foreground">Loading risk settings...</div>
      </div>
    );
  }

  const calculatedQty = calculateSize();

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight font-mono">Risk Management</h1>
          <p className="text-muted-foreground mt-1">
            Configure position sizing, heat limits, and kill-switch parameters
          </p>
        </div>
        {hasChanges && (
          <Button onClick={handleSave} className="font-mono gap-2">
            <Save className="h-4 w-4" />
            Save Changes
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Position Sizing */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Shield className="h-5 w-5 text-primary" />
              <div>
                <CardTitle className="font-mono">Position Sizing</CardTitle>
                <CardDescription>Per-trade risk and portfolio heat limits</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-6">
              {/* Per Trade Risk */}
              <div className="space-y-2">
                <Label htmlFor="perTradeRisk" className="font-mono text-sm">
                  Per-Trade Risk (bp)
                </Label>
                <Input
                  id="perTradeRisk"
                  type="number"
                  step="0.1"
                  value={perTradeRisk}
                  onChange={(e) => {
                    setPerTradeRisk(parseFloat(e.target.value) || 0);
                    setHasChanges(true);
                  }}
                  className="font-mono tabular-nums"
                />
                <p className="text-xs text-muted-foreground">
                  Risk per position as % of equity (0.7 = 70 bps)
                </p>
              </div>

              {/* Heat Cap */}
              <div className="space-y-2">
                <Label htmlFor="maxHeat" className="font-mono text-sm">
                  Heat Cap (%)
                </Label>
                <Input
                  id="maxHeat"
                  type="number"
                  step="0.5"
                  value={maxHeat}
                  onChange={(e) => {
                    setMaxHeat(parseFloat(e.target.value) || 0);
                    setHasChanges(true);
                  }}
                  className="font-mono tabular-nums"
                />
                <p className="text-xs text-muted-foreground">
                  Maximum total portfolio risk at any time
                </p>
              </div>
            </div>

            <Separator />

            {/* Daily Stop */}
            <div className="space-y-2">
              <Label htmlFor="dailyStopR" className="font-mono text-sm">
                Daily Stop Loss (R)
              </Label>
              <Input
                id="dailyStopR"
                type="number"
                step="0.5"
                value={dailyStopR}
                onChange={(e) => {
                  setDailyStopR(parseFloat(e.target.value) || 0);
                  setHasChanges(true);
                }}
                className="font-mono tabular-nums"
              />
              <p className="text-xs text-muted-foreground">
                Blocks new entries if daily loss exceeds this (closes existing positions)
              </p>
            </div>

            <Separator />

            {/* Size Preview */}
            <div className="rounded-md border border-primary/20 bg-primary/5 p-4">
              <div className="flex items-center gap-2 mb-3">
                <Calculator className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold font-mono">Live Size Calculator</span>
              </div>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="text-muted-foreground mb-1">Current Price</div>
                  <div className="font-mono font-semibold tabular-nums">
                    ${mockCurrentPrice.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-1">ATR (1.5x stop)</div>
                  <div className="font-mono font-semibold tabular-nums">
                    ${(mockATR * 1.5).toFixed(0)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-1">Calculated Qty</div>
                  <div className="font-mono font-bold text-primary tabular-nums">
                    {calculatedQty.toFixed(4)}
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Kill-Switch */}
        <Card className="border-destructive/20 bg-gradient-to-br from-card to-destructive/5">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                <div>
                  <CardTitle className="font-mono text-base">Kill-Switch</CardTitle>
                  <CardDescription className="text-xs">
                    Emergency stop conditions
                  </CardDescription>
                </div>
              </div>
              <Switch
                checked={killSwitchEnabled}
                onCheckedChange={(checked) => {
                  setKillSwitchEnabled(checked);
                  setHasChanges(true);
                }}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Spread Threshold */}
            <div className="space-y-2">
              <Label htmlFor="spreadThreshold" className="font-mono text-xs">
                Spread Percentile Max
              </Label>
              <Input
                id="spreadThreshold"
                type="number"
                value={spreadThreshold}
                onChange={(e) => {
                  setSpreadThreshold(parseInt(e.target.value) || 0);
                  setHasChanges(true);
                }}
                className="font-mono tabular-nums text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Halt if spread exceeds this percentile (98 = 98th)
              </p>
            </div>

            {/* ATR Burst */}
            <div className="space-y-2">
              <Label htmlFor="atrBurst" className="font-mono text-xs">
                ATR Burst Multiplier
              </Label>
              <Input
                id="atrBurst"
                type="number"
                step="0.5"
                value={atrBurstMult}
                onChange={(e) => {
                  setAtrBurstMult(parseFloat(e.target.value) || 0);
                  setHasChanges(true);
                }}
                className="font-mono tabular-nums text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Halt if ATR spikes beyond this multiple (3.0 = 300%)
              </p>
            </div>

            <Separator />

            <div className="text-xs text-muted-foreground">
              <p className="mb-2 font-semibold text-foreground">Triggers:</p>
              <ul className="space-y-1 list-disc list-inside">
                <li>Spread exceeds {spreadThreshold}th percentile</li>
                <li>ATR spikes {atrBurstMult}x recent average</li>
                <li>API latency &gt;5s for 3 consecutive ticks</li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Active Risk Events */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <div className="flex items-center gap-3">
              <TrendingDown className="h-5 w-5 text-warning" />
              <div>
                <CardTitle className="font-mono">Active Risk Events</CardTitle>
                <CardDescription>Current risk alerts and triggered conditions</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Badge variant="outline" className="font-mono">
                No active risk events
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Risk;
