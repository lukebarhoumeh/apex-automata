import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/components/ui/use-toast';
import { TrendingUp, Activity, BarChart3 } from 'lucide-react';
import { invokeFunction } from '@/services/supabaseFunctions';

interface Strategy {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  default_params: any;
}

export const StrategiesPanel = () => {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    fetchStrategies();
  }, []);

  const fetchStrategies = async () => {
    try {
      const { data, error } = await supabase
        .from('strategies')
        .select('*')
        .order('name');

      if (error) throw error;
      setStrategies(data || []);
    } catch (error) {
      console.error('Failed to fetch strategies:', error);
    } finally {
      setLoading(false);
    }
  };

  const toggleStrategy = async (id: string, enabled: boolean) => {
    try {
      await invokeFunction<{ id: string; enabled: boolean }, { ok: boolean; id: string }>(
        'strategy-toggle',
        { id, enabled }
      );
      
      setStrategies(prev => 
        prev.map(s => s.id === id ? { ...s, enabled } : s)
      );

      toast({
        title: enabled ? 'Strategy Enabled' : 'Strategy Disabled',
        description: `Strategy has been ${enabled ? 'activated' : 'deactivated'}`
      });
    } catch (error) {
      toast({
        title: 'Failed to Update Strategy',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      });
    }
  };

  const getStrategyIcon = (name: string) => {
    switch (name) {
      case 'breakout':
        return <TrendingUp className="h-5 w-5" />;
      case 'vwap_mr':
        return <Activity className="h-5 w-5" />;
      case 'obi_scalper':
        return <BarChart3 className="h-5 w-5" />;
      default:
        return <Activity className="h-5 w-5" />;
    }
  };

  const getStrategyName = (name: string) => {
    switch (name) {
      case 'breakout':
        return 'Breakout + Vol';
      case 'vwap_mr':
        return 'VWAP Mean Reversion';
      case 'obi_scalper':
        return 'OBI Scalper';
      default:
        return name;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active Strategies</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading strategies...</div>
        ) : strategies.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Activity className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p>No strategies configured</p>
            <p className="text-sm">Add strategies to start trading</p>
          </div>
        ) : (
          <div className="space-y-4">
            {strategies.map((strategy) => (
              <div
                key={strategy.id}
                className="flex items-center justify-between p-3 rounded-lg border bg-card"
              >
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${strategy.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                    {getStrategyIcon(strategy.name)}
                  </div>
                  <div>
                    <div className="font-medium">{getStrategyName(strategy.name)}</div>
                    <div className="text-sm text-muted-foreground">
                      v{strategy.version}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={strategy.enabled ? 'default' : 'secondary'}>
                    {strategy.enabled ? 'Active' : 'Inactive'}
                  </Badge>
                  <Switch
                    checked={strategy.enabled}
                    onCheckedChange={(enabled) => toggleStrategy(strategy.id, enabled)}
                    aria-label={`Toggle ${strategy.name}`}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
