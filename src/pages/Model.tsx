import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Brain, CheckCircle2, AlertCircle, TrendingUp, Save } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

const Model = () => {
  const { toast } = useToast();
  const [threshold, setThreshold] = useState(0.65);
  const [hasChanges, setHasChanges] = useState(false);

  const { data: model } = useQuery({
    queryKey: ["model"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("models")
        .select("*")
        .eq("active", true)
        .single();

      if (error) throw error;
      return data;
    },
  });

  const { data: recentSignals } = useQuery({
    queryKey: ["recent_signals"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signals")
        .select("*")
        .order("decided_at", { ascending: false })
        .limit(100);

      if (error) throw error;
      return data;
    },
  });

  const handleSave = async () => {
    try {
      // TODO: Call runtime API to update model threshold
      toast({
        title: "Model Threshold Updated",
        description: `New threshold: ${threshold.toFixed(2)}`,
      });
      setHasChanges(false);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save threshold",
        variant: "destructive",
      });
    }
  };

  const acceptanceRate = recentSignals
    ? (recentSignals.filter((s) => s.allowed).length / recentSignals.length) * 100
    : 0;

  const avgProb = recentSignals
    ? recentSignals.reduce((sum, s) => sum + (s.meta_prob || 0), 0) / recentSignals.length
    : 0;

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight font-mono">ML Model</h1>
          <p className="text-muted-foreground mt-1">
            ONNX metalabel model status and threshold configuration
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
        {/* Model Status */}
        <Card className="lg:col-span-2 border-primary/20 bg-gradient-to-br from-card to-primary/5">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Brain className="h-6 w-6 text-primary" />
              <div>
                <CardTitle className="font-mono">Model Status</CardTitle>
                <CardDescription>Active ONNX model information</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {model ? (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Model Name</div>
                    <div className="font-mono font-semibold">{model.name}</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Version</div>
                    <div className="font-mono font-semibold">{model.version}</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Status</div>
                    <Badge variant="default" className="gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      Active
                    </Badge>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">SHA-256</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {model.sha256?.slice(0, 16) || "—"}...
                    </div>
                  </div>
                </div>

                {model.metrics && (
                  <>
                    <div className="border-t pt-4 mt-4">
                      <h4 className="text-sm font-semibold mb-3 font-mono">Model Metrics</h4>
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div>
                          <div className="text-muted-foreground mb-1">ROC AUC</div>
                          <div className="font-mono font-semibold text-success">
                            {(model.metrics as any).rocAuc?.toFixed(3) || "—"}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground mb-1">Precision@0.65</div>
                          <div className="font-mono font-semibold">
                            {(model.metrics as any).precisionAt65
                              ? `${((model.metrics as any).precisionAt65 * 100).toFixed(1)}%`
                              : "—"}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground mb-1">Recall@0.65</div>
                          <div className="font-mono font-semibold">
                            {(model.metrics as any).recallAt65
                              ? `${((model.metrics as any).recallAt65 * 100).toFixed(1)}%`
                              : "—"}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="border-t pt-4 mt-4">
                      <h4 className="text-sm font-semibold mb-3 font-mono">Calibration</h4>
                      <div className="h-32 flex items-end gap-1">
                        {Array.from({ length: 20 }, (_, i) => {
                          const height = Math.random() * 100; // Mock calibration data
                          return (
                            <div key={i} className="flex-1 bg-primary/20 rounded-t" style={{ height: `${height}%` }} />
                          );
                        })}
                      </div>
                      <div className="flex justify-between text-xs text-muted-foreground mt-2 font-mono">
                        <span>0.0</span>
                        <span>Predicted Probability</span>
                        <span>1.0</span>
                      </div>
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 space-y-3">
                <AlertCircle className="h-12 w-12 text-muted-foreground" />
                <div className="text-center">
                  <p className="font-semibold">No Active Model</p>
                  <p className="text-sm text-muted-foreground">Load a model to enable ML filtering</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Threshold Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="font-mono text-base">Threshold</CardTitle>
            <CardDescription>Probability cutoff for signal acceptance</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-mono">Threshold</Label>
                <Badge variant="outline" className="font-mono text-lg tabular-nums">
                  {threshold.toFixed(2)}
                </Badge>
              </div>
              <Slider
                value={[threshold * 100]}
                onValueChange={([val]) => {
                  setThreshold(val / 100);
                  setHasChanges(true);
                }}
                min={50}
                max={90}
                step={1}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground font-mono">
                <span>0.50</span>
                <span>0.90</span>
              </div>
            </div>

            <div className="border-t pt-4 space-y-3">
              <h4 className="text-sm font-semibold font-mono">Impact Preview</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Current</span>
                  <span className="font-mono font-semibold">~12 trades/day</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Projected</span>
                  <span className="font-mono font-semibold text-primary">
                    ~{Math.round(12 * (1 - threshold * 0.5))} trades/day
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Recent Performance */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <div className="flex items-center gap-3">
              <TrendingUp className="h-5 w-5 text-success" />
              <div>
                <CardTitle className="font-mono">Recent Performance (Last 7d)</CardTitle>
                <CardDescription>Signal acceptance and model effectiveness</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-6">
              <div>
                <div className="text-sm text-muted-foreground mb-2">Total Signals</div>
                <div className="font-mono text-2xl font-bold">{recentSignals?.length || 0}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-2">Accepted</div>
                <div className="font-mono text-2xl font-bold text-success">
                  {recentSignals?.filter((s) => s.allowed).length || 0}
                </div>
                <Progress value={acceptanceRate} className="h-1 mt-2" />
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-2">Acceptance Rate</div>
                <div className="font-mono text-2xl font-bold">{acceptanceRate.toFixed(1)}%</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-2">Avg Probability</div>
                <div className="font-mono text-2xl font-bold">{avgProb.toFixed(2)}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Model;
