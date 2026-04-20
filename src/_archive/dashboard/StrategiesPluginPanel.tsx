/**
 * StrategiesPluginPanel - Strategy Plugin Management UI
 */

import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { 
  useStrategies, 
  useStrategyDetail,
  useEnableStrategy,
  useDisableStrategy,
  getCategoryColor,
  getCompatibilityColor,
  StrategyInfo,
} from '@/hooks/useStrategies';

interface StrategyCardProps {
  strategy: StrategyInfo;
  onSelect: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
}

function StrategyCard({ strategy, onSelect, onToggle }: StrategyCardProps) {
  const categoryColor = getCategoryColor(strategy.category);
  
  return (
    <div 
      className="rounded-lg border bg-card p-3 space-y-2 cursor-pointer hover:border-primary/50 transition-colors"
      onClick={() => onSelect(strategy.id)}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{strategy.name}</span>
          <Badge 
            variant="outline" 
            className="text-xs"
            style={{ borderColor: categoryColor, color: categoryColor }}
          >
            {strategy.category}
          </Badge>
        </div>
        <Switch
          checked={strategy.enabled}
          onCheckedChange={(checked) => {
            onToggle(strategy.id, checked);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      <p className="text-xs text-muted-foreground line-clamp-2">
        {strategy.description}
      </p>

      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">v{strategy.version}</span>
        {strategy.stats && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="font-mono">
                  📊 {strategy.stats.signalsGenerated ?? 0}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>Signals generated this session</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
}

function StrategyDetailDialog({ 
  strategyId, 
  open, 
  onOpenChange 
}: { 
  strategyId: string | null; 
  open: boolean; 
  onOpenChange: (open: boolean) => void;
}) {
  const { data: detail, isLoading } = useStrategyDetail(strategyId);

  if (!strategyId) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        {isLoading ? (
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-muted rounded w-1/2" />
            <div className="h-4 bg-muted rounded w-3/4" />
          </div>
        ) : detail ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {detail.name}
                <Badge 
                  variant={detail.enabled ? 'default' : 'secondary'}
                >
                  {detail.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
              </DialogTitle>
              <DialogDescription>
                {detail.description}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {/* Metadata */}
              <div className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Version:</span>{' '}
                  <span className="font-mono">{detail.version}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Author:</span>{' '}
                  {detail.author}
                </div>
                <div>
                  <span className="text-muted-foreground">Category:</span>{' '}
                  <span style={{ color: getCategoryColor(detail.category) }}>
                    {detail.category}
                  </span>
                </div>
              </div>

              {/* Tags */}
              <div className="flex flex-wrap gap-1">
                {detail.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>

              {/* Regime Compatibility */}
              <div>
                <h4 className="text-sm font-medium mb-2">Regime Compatibility</h4>
                <div className="grid grid-cols-2 gap-2">
                  {detail.regimeCompatibility.map((rc) => (
                    <div 
                      key={rc.regime} 
                      className="flex items-center justify-between text-xs border rounded p-2"
                    >
                      <span className="capitalize">{rc.regime.replace('_', ' ')}</span>
                      <div className="flex items-center gap-1">
                        <span 
                          className="font-medium"
                          style={{ color: getCompatibilityColor(rc.compatibility) }}
                        >
                          {rc.compatibility}
                        </span>
                        <span className="text-muted-foreground">
                          ({(rc.positionMultiplier * 100).toFixed(0)}%)
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Configuration */}
              <div>
                <h4 className="text-sm font-medium mb-2">Configuration</h4>
                <div className="space-y-2">
                  {detail.configSchema.parameters.map((param) => (
                    <div 
                      key={param.key}
                      className="flex items-center justify-between text-xs border rounded p-2"
                    >
                      <div>
                        <span className="font-medium">{param.name}</span>
                        <p className="text-muted-foreground">{param.description}</p>
                      </div>
                      <span className="font-mono">
                        {String(detail.config[param.key] ?? param.default)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Stats */}
              {detail.stats && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Session Statistics</h4>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="border rounded p-2">
                      <span className="text-muted-foreground">Signals:</span>{' '}
                      <span className="font-mono">{detail.stats.signalsGenerated}</span>
                    </div>
                    {detail.stats.avgSignalStrength !== undefined && (
                      <div className="border rounded p-2">
                        <span className="text-muted-foreground">Avg Strength:</span>{' '}
                        <span className="font-mono">{(detail.stats.avgSignalStrength * 100).toFixed(0)}%</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Required Indicators */}
              <div>
                <h4 className="text-sm font-medium mb-2">Required Indicators</h4>
                <div className="flex flex-wrap gap-1">
                  {detail.requiredIndicators
                    .filter(i => i.required)
                    .map((ind) => (
                      <Badge key={ind.name} variant="outline" className="text-xs">
                        {ind.name}
                      </Badge>
                    ))
                  }
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="text-center py-4">Strategy not found</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function StrategiesPluginPanel() {
  const { data, isLoading, error } = useStrategies();
  const enableStrategy = useEnableStrategy();
  const disableStrategy = useDisableStrategy();
  const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const handleToggle = (strategyId: string, enabled: boolean) => {
    if (enabled) {
      enableStrategy.mutate(strategyId);
    } else {
      disableStrategy.mutate(strategyId);
    }
  };

  const handleSelect = (strategyId: string) => {
    setSelectedStrategy(strategyId);
    setDetailOpen(true);
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Strategy Plugins</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-2">
            <div className="h-20 bg-muted rounded" />
            <div className="h-20 bg-muted rounded" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Strategy Plugins</CardTitle>
          <CardDescription className="text-xs">
            Start the engine to manage strategies
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4 text-muted-foreground">
            <span className="text-2xl">🔌</span>
            <p className="mt-1 text-xs">Engine not running</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">Strategy Plugins</CardTitle>
              <CardDescription className="text-xs">
                {data.enabled} of {data.total} active
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-xs">
              v1.0.0
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.strategies.length === 0 ? (
            <div className="text-center py-4 text-muted-foreground">
              <p className="text-xs">No strategies registered</p>
            </div>
          ) : (
            data.strategies.map((strategy) => (
              <StrategyCard
                key={strategy.id}
                strategy={strategy}
                onSelect={handleSelect}
                onToggle={handleToggle}
              />
            ))
          )}
        </CardContent>
      </Card>

      <StrategyDetailDialog
        strategyId={selectedStrategy}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </>
  );
}

