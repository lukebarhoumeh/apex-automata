import { cn, formatUsd, formatR, formatPercent, formatNumber, getPnlColor } from "@/lib/utils";

type ValueType = 'usd' | 'r' | 'percent' | 'number';

interface ValueDisplayProps {
  value: number | null | undefined;
  type?: ValueType;
  decimals?: number;
  showSign?: boolean;
  colorize?: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function ValueDisplay({
  value,
  type = 'number',
  decimals = 2,
  showSign = false,
  colorize = false,
  className,
  size = 'md',
}: ValueDisplayProps) {
  const formatValue = () => {
    switch (type) {
      case 'usd':
        return formatUsd(value);
      case 'r':
        return formatR(value);
      case 'percent':
        return formatPercent(value, decimals);
      case 'number':
      default:
        if (value == null || isNaN(value)) return '--';
        const formatted = formatNumber(value, decimals);
        return showSign && value > 0 ? `+${formatted}` : formatted;
    }
  };

  const sizeClasses = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg font-semibold',
  };

  return (
    <span
      className={cn(
        'font-mono tabular-nums',
        sizeClasses[size],
        colorize && getPnlColor(value),
        className
      )}
    >
      {formatValue()}
    </span>
  );
}

interface DualValueDisplayProps {
  usdValue: number | null | undefined;
  rValue: number | null | undefined;
  colorize?: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

/** Display both USD and R values together */
export function DualValueDisplay({
  usdValue,
  rValue,
  colorize = true,
  className,
  size = 'md',
}: DualValueDisplayProps) {
  return (
    <div className={cn('flex items-baseline gap-2', className)}>
      <ValueDisplay value={usdValue} type="usd" colorize={colorize} size={size} />
      <span className="text-muted-foreground text-sm">
        (<ValueDisplay value={rValue} type="r" colorize={colorize} size="sm" />)
      </span>
    </div>
  );
}
