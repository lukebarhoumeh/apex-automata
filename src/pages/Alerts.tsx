import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Bell, AlertCircle, Info, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";

interface Alert {
  id: string;
  severity: "info" | "warn" | "error";
  title: string;
  message: string | null;
  data: any;
  created_at: string;
  acked_at: string | null;
}

const Alerts = () => {
  const { toast } = useToast();
  const [alerts, setAlerts] = useState<Alert[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ["alerts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("alerts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) throw error;
      return data as Alert[];
    },
    refetchInterval: 3000,
  });

  // Setup realtime subscription
  useEffect(() => {
    if (data) setAlerts(data);

    const channel = supabase
      .channel("alerts-realtime")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "alerts",
        },
        (payload) => {
          const newAlert = payload.new as Alert;
          setAlerts((prev) => [newAlert, ...prev]);

          // Show toast for critical alerts
          if (newAlert.severity === "error") {
            toast({
              title: newAlert.title,
              description: newAlert.message || undefined,
              variant: "destructive",
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [data, toast]);

  const handleAcknowledge = async (alertId: string) => {
    try {
      await supabase
        .from("alerts")
        .update({ acked_at: new Date().toISOString() })
        .eq("id", alertId);

      setAlerts((prev) =>
        prev.map((a) =>
          a.id === alertId ? { ...a, acked_at: new Date().toISOString() } : a
        )
      );
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to acknowledge alert",
        variant: "destructive",
      });
    }
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case "error":
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      case "warn":
        return <AlertTriangle className="h-4 w-4 text-warning" />;
      case "info":
      default:
        return <Info className="h-4 w-4 text-primary" />;
    }
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case "error":
        return <Badge variant="destructive">ERROR</Badge>;
      case "warn":
        return <Badge variant="outline" className="border-warning text-warning">WARN</Badge>;
      case "info":
      default:
        return <Badge variant="outline">INFO</Badge>;
    }
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (seconds < 60) return `${seconds}s ago`;
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-muted-foreground">Loading alerts...</div>
      </div>
    );
  }

  const unackedCount = alerts.filter((a) => !a.acked_at).length;

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight font-mono">Alerts Stream</h1>
          <p className="text-muted-foreground mt-1">
            Real-time risk, execution, and system alerts
          </p>
        </div>
        {unackedCount > 0 && (
          <Badge variant="destructive" className="animate-pulse font-mono">
            {unackedCount} unacknowledged
          </Badge>
        )}
      </div>

      {/* Alerts Table */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Bell className="h-5 w-5 text-primary" />
            <CardTitle className="font-mono">Alert History</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="font-mono text-xs">
                  <TableHead className="w-24">Time</TableHead>
                  <TableHead className="w-20">Severity</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead className="w-28 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-xs">
                {alerts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-12">
                      No alerts yet
                    </TableCell>
                  </TableRow>
                ) : (
                  alerts.map((alert) => (
                    <TableRow
                      key={alert.id}
                      className={alert.acked_at ? "opacity-50" : ""}
                    >
                      <TableCell className="tabular-nums text-muted-foreground">
                        {formatTime(alert.created_at)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {getSeverityIcon(alert.severity)}
                          {getSeverityBadge(alert.severity)}
                        </div>
                      </TableCell>
                      <TableCell className="font-semibold">{alert.title}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {alert.message || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {alert.acked_at ? (
                          <Badge variant="outline" className="text-xs gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            Acked
                          </Badge>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleAcknowledge(alert.id)}
                            className="h-7 text-xs"
                          >
                            Acknowledge
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Alerts;
