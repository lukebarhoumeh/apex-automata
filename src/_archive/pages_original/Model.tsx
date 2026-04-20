import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Brain, Activity, TrendingUp, CheckCircle, XCircle, Save } from "lucide-react";
import { useActiveModel, useSignalAcceptanceStats, useUpdateModelThreshold } from "@/hooks/useModelData";
import { CalibrationChart } from "@/components/model/CalibrationChart";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const Model = () => {
  const { data: model, isLoading: modelLoading } = useActiveModel();
  const { data: stats, isLoading: statsLoading } = useSignalAcceptanceStats();
  const updateThreshold = useUpdateModelThreshold();

  const [threshold, setThreshold] = useState(0.65);
  const [hasChanges, setHasChanges] = useState(false);

  // Get current threshold from strategy_signals
  const { data: currentConfig } = useQuery({
    queryKey: ["meta-config"],
    queryFn: async () => {
      const { data } = await supabase
        .from("strategy_signals")
        .select("params")
        .eq("name", "meta")
        .maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    if (currentConfig?.params) {
      const params = currentConfig.params as Record<string, any>;
      if (params.threshold) {
        setThreshold(params.threshold);
      }
    }
  }, [currentConfig]);

  const handleThresholdChange = (value: number[]) => {
    setThreshold(value[0]);
    setHasChanges(true);
  };

  const handleSave = () => {
    updateThreshold.mutate(threshold);
    setHasChanges(false);
  };

  if (modelLoading) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-muted-foreground">Loading model information...</div>
      </div>
    );
  }

  const metrics = model?.metrics || {};
  const rocAuc = metrics.roc_auc || 0;
  const precision = metrics.precision || 0;
  const recall = metrics.recall || 0;
  const f1 = metrics.f1 || 0;

  // Estimate trade volume impact based on threshold
  const estimateTradeImpact = (newThreshold: number) => {
    const baseVolume = 12; // trades/day at 0.65 threshold
    const factor = Math.exp(-(newThreshold - 0.65) * 5);
    return Math.round(baseVolume * factor);
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight font-mono">ML Model</h1>
          <p className="text-muted-foreground mt-1">
            ONNX model status, calibration, and threshold configuration
          </p>
        </div>
        {hasChanges && (
          <Button onClick={handleSave} disabled={updateThreshold.isPending} className="font-mono gap-2">
            <Save className="h-4 w-4" />
            Save Threshold
          </Button>
        )}
      </div>

      {!model ? (
        <Card>
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center space-y-3">
              <Brain className="h-16 w-16 text-muted-foreground" />
              <div>
                <p className="font-semibold">No Active Model</p>
                <p className="text-sm text-muted-foreground">Upload an ONNX model to enable ML filtering</p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Model Info */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Brain className="h-6 w-6 text-primary" />
                    <div>
                      <CardTitle className="font-mono">{model.name}</CardTitle>
                      <CardDescription>Version {model.version}</CardDescription>
                    </div>
                  </div>
                  <Badge variant="outline" className="bg-success/10 text-success border-success/20">
                    Active
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="text-muted-foreground mb-1">Model Path</div>
                    <div className="font-mono text-xs truncate">{model.path}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-1">SHA-256</div>
                    <div className="font-mono text-xs truncate">{model.sha256 || "N/A"}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-1">Created</div>
                    <div className="font-mono text-xs">
                      {new Date(model.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-1">Input Features</div>
                    <div className="font-mono text-xs">
                      {model.input_schema?.features?.length || 0} features
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Metrics */}
                <div className="grid grid-cols-4 gap-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums text-primary">
                      {(rocAuc * 100).toFixed(1)}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">ROC AUC</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums">
                      {(precision * 100).toFixed(1)}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Precision</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums">
                      {(recall * 100).toFixed(1)}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Recall</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums">
                      {(f1 * 100).toFixed(1)}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">F1 Score</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Calibration Chart */}
            <CalibrationChart data={metrics.calibration || null} />
          </div>

          {/* Threshold Configuration */}
          <Card className="border-primary/20 bg-gradient-to-br from-card to-primary/5">
            <CardHeader>
              <div className="flex items-center gap-3">
                <Activity className="h-5 w-5 text-primary" />
                <div>
                  <CardTitle className="font-mono">Probability Threshold</CardTitle>
                  <CardDescription>
                    Adjust minimum confidence for signal acceptance
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="font-mono">Threshold</Label>
                  <Badge variant="outline" className="font-mono tabular-nums text-lg px-3">
                    {(threshold * 100).toFixed(0)}%
                  </Badge>
                </div>
                <Slider
                  value={[threshold * 100]}
                  onValueChange={(val) => handleThresholdChange([val[0] / 100])}
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
                  <div className="font-mono font-semibold">
                    ~{estimateTradeImpact(threshold)} trades/day
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-1">Quality vs Volume</div>
                  <div className="font-mono font-semibold">
                    {threshold >= 0.7 ? "High quality" : threshold >= 0.6 ? "Balanced" : "High volume"}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Recent Signal Statistics */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <TrendingUp className="h-5 w-5 text-success" />
                <div>
                  <CardTitle className="font-mono">Recent Signal Statistics</CardTitle>
                  <CardDescription>Last 7 days performance</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {statsLoading ? (
                <div className="text-sm text-muted-foreground">Loading statistics...</div>
              ) : stats ? (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums">{stats.total}</div>
                    <div className="text-xs text-muted-foreground mt-1">Total Signals</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums text-success flex items-center justify-center gap-1">
                      <CheckCircle className="h-4 w-4" />
                      {stats.allowed}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Allowed</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums text-muted-foreground flex items-center justify-center gap-1">
                      <XCircle className="h-4 w-4" />
                      {stats.rejected}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Rejected</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums text-primary">
                      {stats.acceptanceRate.toFixed(1)}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Acceptance Rate</div>
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-mono tabular-nums">
                      <div className="text-success">✓ {(stats.avgAllowedProb * 100).toFixed(1)}%</div>
                      <div className="text-muted-foreground">✗ {(stats.avgRejectedProb * 100).toFixed(1)}%</div>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Avg Probability</div>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground text-center py-4">
                  No signal data available
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
};

export default Model;
