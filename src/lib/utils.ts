import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ============= Number Formatting =============

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactCurrencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const numberFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Format as USD: $1,234.56 */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return '--';
  return currencyFormatter.format(value);
}

/** Format as compact USD: $1.2K */
export function formatUsdCompact(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return '--';
  return compactCurrencyFormatter.format(value);
}

/** Format as R value: +1.5R or -0.5R */
export function formatR(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return '--';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${numberFormatter.format(value)}R`;
}

/** Format as percentage: 65.0% */
export function formatPercent(value: number | null | undefined, decimals = 1): string {
  if (value == null || isNaN(value)) return '--';
  // If value is already in decimal form (0.65), use percentFormatter
  // If value is in whole form (65), divide by 100 first
  const normalized = Math.abs(value) > 1 ? value / 100 : value;
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(normalized);
}

/** Format number with commas: 1,234.56 */
export function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value == null || isNaN(value)) return '--';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** Format basis points: 25bp */
export function formatBps(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return '--';
  return `${Math.round(value)}bp`;
}

/** Format latency: 150ms */
export function formatLatency(ms: number | null | undefined): string {
  if (ms == null || isNaN(ms)) return '--';
  return `${Math.round(ms)}ms`;
}

// ============= Color Utilities =============

/** Get profit/loss color class based on value */
export function getPnlColor(value: number | null | undefined): string {
  if (value == null || value === 0) return 'text-muted-foreground';
  return value > 0 ? 'text-success' : 'text-destructive';
}

/** Get profit/loss background class based on value */
export function getPnlBgColor(value: number | null | undefined): string {
  if (value == null || value === 0) return 'bg-muted';
  return value > 0 ? 'bg-success/10' : 'bg-destructive/10';
}

// ============= Time Utilities =============

/** Check if timestamp is stale (older than threshold in seconds) */
export function isStale(timestamp: string | Date | null | undefined, thresholdSeconds = 30): boolean {
  if (!timestamp) return true;
  const lastUpdate = new Date(timestamp).getTime();
  const now = Date.now();
  return (now - lastUpdate) > thresholdSeconds * 1000;
}

/** Format relative time: "5s ago", "2m ago" */
export function formatRelativeTime(timestamp: string | Date | null | undefined): string {
  if (!timestamp) return '--';
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
