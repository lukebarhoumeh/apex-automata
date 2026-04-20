import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowUp, ArrowDown, Minus, Activity } from "lucide-react";
import { useLiveTicker } from "@/hooks/useLiveTicker";
import { useRuntimeStatus } from "@/hooks/useRuntimeStatus";

export const LiveTickersPanel = () => {
  const { data: status } = useRuntimeStatus();
  const symbols = status?.activeSymbols ?? status?.symbols ?? ["BTC-USD", "ETH-USD", "SOL-USD"];
  
  const { tickers, isConnected, getSpread } = useLiveTicker(symbols);

  const formatPrice = (price: number) =>
    `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const formatChange = (change: number | undefined) => {
    if (change === undefined) return null;
    const isPositive = change >= 0;
    return (
      <div className={`flex items-center gap-1 ${isPositive ? "text-success" : "text-destructive"}`}>
        {isPositive ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
        <span className="text-xs font-mono tabular-nums">
          {isPositive ? "+" : ""}{change.toFixed(2)}%
        </span>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-mono">
            <Activity className="h-4 w-4 text-primary" />
            Live Prices
            {isConnected && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
              </span>
            )}
          </CardTitle>
          <Badge variant="outline" className="font-mono text-xs">
            {symbols.length} pairs
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {symbols.map((symbol) => {
          const ticker = tickers[symbol];
          const spread = getSpread(symbol);

          return (
            <div
              key={symbol}
              className="flex items-center justify-between p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-xs font-bold text-primary">
                    {symbol.split("-")[0].slice(0, 3)}
                  </span>
                </div>
                <div>
                  <div className="font-semibold text-sm">{symbol}</div>
                  {spread !== null && spread > 0 && (
                    <div className="text-xs text-muted-foreground">
                      Spread: {spread.toFixed(4)}%
                    </div>
                  )}
                </div>
              </div>

              <div className="text-right">
                {ticker ? (
                  <>
                    <div className="text-lg font-bold font-mono tabular-nums">
                      {formatPrice(ticker.price)}
                    </div>
                    {formatChange(ticker.change24h)}
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Minus className="h-4 w-4" />
                    <span className="text-sm">Waiting...</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {!isConnected && (
          <div className="text-center py-4 text-xs text-muted-foreground">
            Connect to backend for real-time prices
          </div>
        )}
      </CardContent>
    </Card>
  );
};
