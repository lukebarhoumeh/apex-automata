/**
 * Equity Curve Chart (Sprint 1.4)
 * 
 * Displays equity curve from:
 * 1. Live pnl:snapshot stream (real-time intraday)
 * 2. Historical data from /api/analytics/equity-curve (backfill)
 * 
 * Chart latest point MUST match header equity (same pnl:snapshot source).
 */

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Activity, AlertCircle } from "lucide-react";
import { useCombinedEquityCurve } from "@/hooks/useEquityCurve";
import { usePnLSnapshot } from "@/hooks/usePnLSnapshot";

// Simple SVG-based line chart (no external deps)
const MiniLineChart = ({
  data,
  width = 400,
  height = 120,
  color = "#22c55e",
  showArea = true,
}: {
  data: Array<{ x: number; y: number }>;
  width?: number;
  height?: number;
  color?: string;
  showArea?: boolean;
}) => {
  if (data.length < 2) {
    return (
      <div 
        className="flex items-center justify-center text-muted-foreground text-sm"
        style={{ width, height }}
      >
        Waiting for data...
      </div>
    );
  }

  const padding = { top: 10, right: 10, bottom: 10, left: 10 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const minY = Math.min(...data.map(d => d.y));
  const maxY = Math.max(...data.map(d => d.y));
  const minX = Math.min(...data.map(d => d.x));
  const maxX = Math.max(...data.map(d => d.x));

  const yRange = maxY - minY || 1;
  const xRange = maxX - minX || 1;

  const scaleX = (x: number) => padding.left + ((x - minX) / xRange) * chartWidth;
  const scaleY = (y: number) => padding.top + chartHeight - ((y - minY) / yRange) * chartHeight;

  const linePath = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(d.x).toFixed(2)} ${scaleY(d.y).toFixed(2)}`)
    .join(' ');

  const areaPath = `${linePath} L ${scaleX(data[data.length - 1].x).toFixed(2)} ${height - padding.bottom} L ${scaleX(data[0].x).toFixed(2)} ${height - padding.bottom} Z`;

  // Zero line if it's in view
  const zeroY = scaleY(0);
  const showZeroLine = minY < 0 && maxY > 0;

  return (
    <svg width={width} height={height} className="overflow-visible">
      {showArea && (
        <path
          d={areaPath}
          fill={color}
          fillOpacity={0.1}
        />
      )}
      {showZeroLine && (
        <line
          x1={padding.left}
          y1={zeroY}
          x2={width - padding.right}
          y2={zeroY}
          stroke="currentColor"
          strokeOpacity={0.2}
          strokeDasharray="4,4"
        />
      )}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Latest point indicator */}
      <circle
        cx={scaleX(data[data.length - 1].x)}
        cy={scaleY(data[data.length - 1].y)}
        r={4}
        fill={color}
      />
    </svg>
  );
};

export const EquityCurveChart = () => {
  // Get combined equity curve (historical + live)
  const { equityCurve, highWaterMark, currentEquity, maxDrawdown, isLoading } = useCombinedEquityCurve();
  
  // Get canonical snapshot for consistency check
  const { snapshot, isStale, source } = usePnLSnapshot();

  // Transform to chart data - using P&L not equity for the curve
  const chartData = useMemo(() => {
    if (!equityCurve || equityCurve.length === 0) {
      return [];
    }
    return equityCurve.map(point => ({
      x: point.timestamp,
      y: point.pnl,
    }));
  }, [equityCurve]);

  // Use snapshot as current values (canonical source)
  const snapshotEquity = snapshot?.totalEquityUsd ?? 0;
  const snapshotPnl = (snapshot?.realizedPnlUsd ?? 0) + (snapshot?.unrealizedPnlUsd ?? 0);
  
  // Display values - prefer snapshot if available
  const displayEquity = snapshot ? snapshotEquity : currentEquity;
  const displayPnl = snapshot ? snapshotPnl : (equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].pnl : 0);
  
  const isProfitable = displayPnl >= 0;
  const color = isProfitable ? "#22c55e" : "#ef4444";
  
  // Check if chart and snapshot are in sync (within $0.10 tolerance)
  const chartLatestEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : 0;
  const isInSync = !snapshot || Math.abs(chartLatestEquity - snapshotEquity) < 0.10;

  const hasData = snapshot !== null || equityCurve.length > 0;

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat('en-US', { 
      style: 'currency', 
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(val);

  const formatPnl = (val: number) => {
    const formatted = formatCurrency(Math.abs(val));
    return val >= 0 ? `+${formatted}` : `-${formatted}`;
  };

  return (
    <Card className="col-span-full lg:col-span-2">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-mono">
            <Activity className="h-4 w-4" />
            Session Equity Curve
            {isStale && (
              <Badge variant="outline" className="text-xs text-warning border-warning/50">
                STALE
              </Badge>
            )}
          </CardTitle>
          {hasData && (
            <div className="flex items-center gap-2">
              <Badge 
                variant={isProfitable ? "default" : "destructive"}
                className={`font-mono ${isProfitable ? 'bg-success' : ''}`}
              >
                {isProfitable ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                {formatPnl(displayPnl)}
              </Badge>
              {!isInSync && (
                <Badge variant="outline" className="text-xs text-warning border-warning/50">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  Syncing
                </Badge>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-[120px] flex items-center justify-center text-muted-foreground">
            Loading...
          </div>
        ) : !hasData ? (
          <div className="h-[120px] flex items-center justify-center text-muted-foreground">
            Waiting for P&L data...
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="w-full overflow-hidden">
              <MiniLineChart 
                data={chartData} 
                width={600}
                height={120}
                color={color}
              />
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs font-mono">
              <div className="text-center">
                <div className="text-muted-foreground">Equity</div>
                <div className="font-semibold">{formatCurrency(displayEquity)}</div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">HWM</div>
                <div className="font-semibold">
                  {highWaterMark > 0 ? formatCurrency(highWaterMark) : '---'}
                </div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">Max DD</div>
                <div className={`font-semibold ${maxDrawdown > 0 ? 'text-destructive' : ''}`}>
                  {maxDrawdown > 0 ? formatCurrency(maxDrawdown) : '$0'}
                </div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">Points</div>
                <div className="font-semibold">{equityCurve.length}</div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
