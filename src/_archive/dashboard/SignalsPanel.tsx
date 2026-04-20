import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Activity, Target, Brain } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";

interface SignalConfig {
  name: string;
  enabled: boolean;
  icon: React.ReactNode;
  params: { label: string; value: string | number }[];
  performance?: { winRate: number; avgR: number };
}

export const SignalsPanel = () => {
  const signals: SignalConfig[] = [
    {
      name: "Breakout",
      enabled: true,
      icon: <TrendingUp className="h-4 w-4" />,
      params: [
        { label: "ADX Min", value: 18 },
        { label: "Donchian Period", value: 20 },
        { label: "ATR %ile Min", value: "60%" }
      ],
      performance: { winRate: 68, avgR: 1.45 }
    },
    {
      name: "VWAP MR",
      enabled: true,
      icon: <Activity className="h-4 w-4" />,
      params: [
        { label: "Z-Score Min", value: 1.2 },
        { label: "ADX Max", value: 14 }
      ],
      performance: { winRate: 72, avgR: 0.95 }
    },
    {
      name: "OBI Scalper",
      enabled: false,
      icon: <Target className="h-4 w-4" />,
      params: [
        { label: "OBI Threshold", value: "0.35" },
        { label: "Max Time (min)", value: 15 }
      ],
      performance: { winRate: 61, avgR: 0.78 }
    }
  ];

  return (
    <Card className="card-glow border-primary/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          Strategy Signals
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {signals.map((signal, idx) => (
          <div key={signal.name}>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-md ${signal.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                    {signal.icon}
                  </div>
                  <div>
                    <Label htmlFor={`signal-${idx}`} className="font-semibold text-base cursor-pointer">
                      {signal.name}
                    </Label>
                    {signal.performance && (
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span>Win: {signal.performance.winRate}%</span>
                        <span>•</span>
                        <span>Avg: {signal.performance.avgR}R</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {signal.enabled && (
                    <Badge className="bg-success/10 text-success border-success/40 text-xs">
                      ACTIVE
                    </Badge>
                  )}
                  <Switch
                    id={`signal-${idx}`}
                    checked={signal.enabled}
                  />
                </div>
              </div>

              {signal.enabled && signal.performance && (
                <div className="pl-6 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Win Rate</span>
                    <span className="font-medium">{signal.performance.winRate}%</span>
                  </div>
                  <Progress value={signal.performance.winRate} className="h-1.5" />
                </div>
              )}

              {signal.enabled && (
                <div className="space-y-3 pl-6 border-l-2 border-primary/30 animate-slide-up">
                  {signal.params.map((param) => (
                    <div key={param.label} className="grid grid-cols-2 gap-3 items-center">
                      <Label className="text-xs text-muted-foreground">
                        {param.label}
                      </Label>
                      <Input
                        type="text"
                        defaultValue={param.value}
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
            {idx < signals.length - 1 && <Separator className="mt-6" />}
          </div>
        ))}

        <div className="pt-4 space-y-4 border-t">
          <div className="p-4 rounded-lg bg-gradient-to-r from-accent/10 to-primary/10 border border-accent/20">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Brain className="h-4 w-4 text-accent" />
                <Label className="text-sm font-semibold">Meta-Label ML Filter</Label>
              </div>
              <Switch defaultChecked />
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              AI probability gate using LightGBM model
            </p>
            <div className="space-y-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Confidence Threshold</Label>
                  <Badge variant="outline" className="font-mono text-xs bg-card">
                    62%
                  </Badge>
                </div>
                <Input
                  type="number"
                  defaultValue={0.62}
                  min={0.5}
                  max={0.9}
                  step={0.01}
                  className="h-8 text-xs font-mono"
                />
              </div>
              <div className="flex items-center justify-between text-xs p-2 rounded bg-card/50">
                <span className="text-muted-foreground">Model AUC</span>
                <span className="font-medium text-success">0.68</span>
              </div>
            </div>
          </div>
        </div>

        <Button className="w-full shadow-lg" size="lg">
          Save Configuration
        </Button>
      </CardContent>
    </Card>
  );
};
