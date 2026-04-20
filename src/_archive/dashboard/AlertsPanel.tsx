import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { AlertTriangle, Info, AlertCircle, Check } from 'lucide-react';
import { format } from 'date-fns';
import { invokeFunction } from '@/services/supabaseFunctions';

interface Alert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string | null;
  created_at: string;
  acked_at: string | null;
}

export const AlertsPanel = () => {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAlerts();

    // Subscribe to real-time updates
    const channel = supabase
      .channel('alerts-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'alerts'
        },
        () => {
          fetchAlerts();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const fetchAlerts = async () => {
    try {
      const { data, error } = await supabase
        .from('alerts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      setAlerts(data || []);
    } catch (error) {
      console.error('Failed to fetch alerts:', error);
    } finally {
      setLoading(false);
    }
  };

  const acknowledgeAlert = async (id: string) => {
    try {
      await invokeFunction<{ id: string }, { ok: boolean; id: string }>('alerts-ack', { id });
      fetchAlerts();
    } catch (error) {
      console.error('Failed to acknowledge alert:', error);
    }
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'critical':
        return <AlertTriangle className="h-4 w-4 text-destructive" />;
      case 'warning':
        return <AlertCircle className="h-4 w-4 text-warning" />;
      default:
        return <Info className="h-4 w-4 text-info" />;
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'destructive';
      case 'warning':
        return 'warning';
      default:
        return 'secondary';
    }
  };

  const unacknowledgedCount = alerts.filter(a => !a.acked_at).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            Alerts
            {unacknowledgedCount > 0 && (
              <Badge variant="destructive" className="animate-pulse">
                {unacknowledgedCount}
              </Badge>
            )}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[400px] pr-4">
          {loading ? (
            <div className="text-center py-8 text-muted-foreground">Loading alerts...</div>
          ) : alerts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <AlertCircle className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No alerts yet</p>
              <p className="text-sm">System notifications will appear here</p>
            </div>
          ) : (
            <div className="space-y-3">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`p-3 rounded-lg border transition-all ${
                    alert.acked_at
                      ? 'bg-muted/30 border-muted opacity-60'
                      : 'bg-card border-border shadow-sm'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5">{getSeverityIcon(alert.severity)}</div>
                    <div className="flex-1 space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{alert.title}</span>
                          <Badge variant={getSeverityColor(alert.severity) as any} className="text-xs">
                            {alert.severity}
                          </Badge>
                        </div>
                        {!alert.acked_at && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2"
                            onClick={() => acknowledgeAlert(alert.id)}
                          >
                            <Check className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                      {alert.message && (
                        <p className="text-sm text-muted-foreground">{alert.message}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(alert.created_at), 'MMM d, HH:mm:ss')}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
};
