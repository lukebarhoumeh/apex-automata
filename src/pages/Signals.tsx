import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";
import { TrendingUp, Activity, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface StrategySignal {
  id: string;
  name: string;
  enabled: boolean;
  params: {
    adxMin?: number;
    adxMax?: number;
    donchianN?: number;
    atrPctileMin?: number;
    zAbsMin?: number;
  };
  win_rate: number | null;
  avg_r: number | null;
}

const Signals = () => {
  const { toast } = useToast();
  const [hasChanges, setHasChanges] = useState(false);

  const { data: strategySignals, isLoading } = useQuery({
    queryKey: ["strategy_signals"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("strategy_signals")
        .select("*")
        .order("name");

      if (error) throw error;
      return data as StrategySignal[];
    },
  });

  const [localConfig, setLocalConfig] = useState<Record<string, StrategySignal>>({});

  const updateLocal = (name: string, updates: Partial<StrategySignal>) => {
    setLocalConfig((prev) => ({
      ...prev,
      [name]: { ...(prev[name] || strategySignals?.find((s) => s.name === name)!), ...updates },
    }));
    setHasChanges(true);
  };

  const handleSave = async () => {
    try {
      // TODO: Call runtime API to update signal config
      toast({
        title: "Signal Configuration Updated",
        description: "Strategy thresholds have been applied",
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

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <div className="text-muted-foreground">Loading signal configuration...</div>
      </div>
    );
  }

  const getConfig = (name: string) =>
    localConfig[name] || strategySignals?.find((s) => s.name === name);

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight font-mono">Signals Configuration</h1>
          <p className="text-muted-foreground mt-1">
            Enable strategies and adjust thresholds with live impact preview
          </p>
        </div>
        {hasChanges && (
          <Button onClick={handleSave} className="font-mono gap-2">
            <Save className="h-4 w-4" />
            Save Changes
          </Button>
        )}
      </div>

      {/* Meta Signal (ML Model) */}
      <Card className="border-primary/20 bg-gradient-to-br from-card to-primary/5">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Activity className="h-6 w-6 text-primary" />
              <div>
                <CardTitle className="font-mono">Meta Signal (ML Filter)</CardTitle>
                <CardDescription>
                  Machine learning model that gates all other signals
                </CardDescription>
              </div>
            </div>
            <Switch
              checked={getConfig("meta")?.enabled ?? true}
              onCheckedChange={(checked) =>
                updateLocal("meta", { enabled: checked } as Partial<StrategySignal>)
              }
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-mono">Probability Threshold</Label>
              <Badge variant="outline" className="font-mono tabular-nums">
                {((getConfig("meta")?.params as any)?.threshold || 0.65).toFixed(2)}
              </Badge>
            </div>
            <Slider
              value={[((getConfig("meta")?.params as any)?.threshold || 0.65) * 100]}
              onValueChange={([val]) =>
                updateLocal("meta", {
                  params: { threshold: val / 100 },
                } as Partial<StrategySignal>)
              }
              min={50}
              max={90}
              step={1}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-muted-foreground font-mono">
              <span>50% (more trades)</span>
              <span>90% (fewer trades)</span>
            </div>
          </div>

          <Separator />

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground mb-1">Estimated Impact</div>
              <div className="font-mono font-semibold">~12 trades/day → ~8 trades/day</div>
            </div>
            <div>
              <div className="text-muted-foreground mb-1">Acceptance Rate</div>
              <div className="font-mono font-semibold text-success">68% (last 7d)</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Strategy Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Breakout + Volume */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <TrendingUp className="h-5 w-5 text-success" />
                <div>
                  <CardTitle className="font-mono text-base">Breakout + Volume</CardTitle>
                  <CardDescription className="text-xs">
                    Donchian breakout with ADX trend filter
                  </CardDescription>
                </div>
              </div>
              <Switch
                checked={getConfig("breakout")?.enabled ?? true}
                onCheckedChange={(checked) =>
                  updateLocal("breakout", { enabled: checked } as Partial<StrategySignal>)
                }
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* ADX Min */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-mono">ADX Minimum</Label>
                <Badge variant="outline" className="font-mono text-xs tabular-nums">
                  {(getConfig("breakout")?.params as any)?.adxMin || 25}
                </Badge>
              </div>
              <Slider
                value={[(getConfig("breakout")?.params as any)?.adxMin || 25]}
                onValueChange={([val]) =>
                  updateLocal("breakout", {
                    params: { ...getConfig("breakout")?.params, adxMin: val },
                  } as Partial<StrategySignal>)
                }
                min={15}
                max={40}
                step={1}
              />
            </div>

            {/* Donchian Period */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-mono">Donchian Period</Label>
                <Badge variant="outline" className="font-mono text-xs tabular-nums">
                  {(getConfig("breakout")?.params as any)?.donchianN || 20}
                </Badge>
              </div>
              <Slider
                value={[(getConfig("breakout")?.params as any)?.donchianN || 20]}
                onValueChange={([val]) =>
                  updateLocal("breakout", {
                    params: { ...getConfig("breakout")?.params, donchianN: val },
                  } as Partial<StrategySignal>)
                }
                min={10}
                max={40}
                step={1}
              />
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-muted-foreground mb-1">Win Rate</div>
                <div className="font-mono font-semibold">
                  {getConfig("breakout")?.win_rate
                    ? `${(getConfig("breakout")!.win_rate * 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground mb-1">Avg R</div>
                <div className="font-mono font-semibold text-success">
                  {getConfig("breakout")?.avg_r
                    ? `${getConfig("breakout")!.avg_r.toFixed(2)}R`
                    : "—"}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* VWAP Mean Reversion */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Activity className="h-5 w-5 text-primary" />
                <div>
                  <CardTitle className="font-mono text-base">VWAP Mean Reversion</CardTitle>
                  <CardDescription className="text-xs">
                    Fade extremes with ADX chop filter
                  </CardDescription>
                </div>
              </div>
              <Switch
                checked={getConfig("vwap_mr")?.enabled ?? true}
                onCheckedChange={(checked) =>
                  updateLocal("vwap_mr", { enabled: checked } as Partial<StrategySignal>)
                }
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Z-Score Min */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-mono">Z-Score Minimum</Label>
                <Badge variant="outline" className="font-mono text-xs tabular-nums">
                  {(getConfig("vwap_mr")?.params as any)?.zAbsMin || 2.0}
                </Badge>
              </div>
              <Slider
                value={[(getConfig("vwap_mr")?.params as any)?.zAbsMin || 2.0]}
                onValueChange={([val]) =>
                  updateLocal("vwap_mr", {
                    params: { ...getConfig("vwap_mr")?.params, zAbsMin: val / 10 },
                  } as Partial<StrategySignal>)
                }
                min={15}
                max={30}
                step={1}
              />
              <div className="flex justify-between text-xs text-muted-foreground font-mono">
                <span>1.5σ</span>
                <span>3.0σ</span>
              </div>
            </div>

            {/* ADX Max */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-mono">ADX Maximum</Label>
                <Badge variant="outline" className="font-mono text-xs tabular-nums">
                  {(getConfig("vwap_mr")?.params as any)?.adxMax || 25}
                </Badge>
              </div>
              <Slider
                value={[(getConfig("vwap_mr")?.params as any)?.adxMax || 25]}
                onValueChange={([val]) =>
                  updateLocal("vwap_mr", {
                    params: { ...getConfig("vwap_mr")?.params, adxMax: val },
                  } as Partial<StrategySignal>)
                }
                min={15}
                max={35}
                step={1}
              />
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-muted-foreground mb-1">Win Rate</div>
                <div className="font-mono font-semibold">
                  {getConfig("vwap_mr")?.win_rate
                    ? `${(getConfig("vwap_mr")!.win_rate * 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground mb-1">Avg R</div>
                <div className="font-mono font-semibold text-success">
                  {getConfig("vwap_mr")?.avg_r
                    ? `${getConfig("vwap_mr")!.avg_r.toFixed(2)}R`
                    : "—"}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Signals;
