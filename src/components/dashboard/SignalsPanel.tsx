import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Activity, Target } from "lucide-react";
import { Separator } from "@/components/ui/separator";

interface SignalConfig {
  name: string;
  enabled: boolean;
  icon: React.ReactNode;
  params: { label: string; value: string | number }[];
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
      ]
    },
    {
      name: "VWAP MR",
      enabled: true,
      icon: <Activity className="h-4 w-4" />,
      params: [
        { label: "Z-Score Min", value: 1.2 },
        { label: "ADX Max", value: 14 }
      ]
    },
    {
      name: "OBI Scalper",
      enabled: false,
      icon: <Target className="h-4 w-4" />,
      params: [
        { label: "OBI Threshold", value: "0.35" },
        { label: "Max Time (min)", value: 15 }
      ]
    }
  ];

  return (
    <Card>
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
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {signal.icon}
                  <Label htmlFor={`signal-${idx}`} className="font-semibold">
                    {signal.name}
                  </Label>
                  {signal.enabled && (
                    <Badge variant="outline" className="text-xs bg-success/10 text-success">
                      Active
                    </Badge>
                  )}
                </div>
                <Switch
                  id={`signal-${idx}`}
                  checked={signal.enabled}
                />
              </div>

              {signal.enabled && (
                <div className="space-y-3 pl-6 border-l-2 border-primary/30">
                  {signal.params.map((param) => (
                    <div key={param.label} className="grid grid-cols-2 gap-2 items-center">
                      <Label className="text-xs text-muted-foreground">
                        {param.label}
                      </Label>
                      <Input
                        type="text"
                        defaultValue={param.value}
                        className="h-7 text-xs font-mono"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
            {idx < signals.length - 1 && <Separator className="mt-6" />}
          </div>
        ))}

        <div className="pt-4 space-y-3 border-t">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-semibold">Meta-Label Filter</Label>
              <p className="text-xs text-muted-foreground">ML probability gate</p>
            </div>
            <Switch defaultChecked />
          </div>
          <div className="space-y-2 pl-6 border-l-2 border-accent/30">
            <Label className="text-xs">Threshold</Label>
            <Input
              type="number"
              defaultValue={0.62}
              min={0.5}
              max={0.9}
              step={0.01}
              className="h-7 text-xs font-mono"
            />
          </div>
        </div>

        <Button className="w-full" size="sm">
          Save Configuration
        </Button>
      </CardContent>
    </Card>
  );
};
