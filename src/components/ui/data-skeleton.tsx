import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface DataSkeletonProps {
  className?: string;
}

/** Skeleton for a single metric/KPI value */
export function MetricSkeleton({ className }: DataSkeletonProps) {
  return (
    <div className={cn("space-y-2", className)}>
      <Skeleton className="h-4 w-16" />
      <Skeleton className="h-8 w-24" />
    </div>
  );
}

/** Skeleton for a metric card */
export function MetricCardSkeleton({ className }: DataSkeletonProps) {
  return (
    <div className={cn("p-4 rounded-lg border bg-card", className)}>
      <Skeleton className="h-4 w-20 mb-2" />
      <Skeleton className="h-7 w-28 mb-1" />
      <Skeleton className="h-3 w-16" />
    </div>
  );
}

/** Skeleton for a table row */
export function TableRowSkeleton({ columns = 6, className }: DataSkeletonProps & { columns?: number }) {
  return (
    <div className={cn("flex items-center gap-3 py-2 px-2", className)}>
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton key={i} className="h-4 flex-1" />
      ))}
    </div>
  );
}

/** Skeleton for a table with multiple rows */
export function TableSkeleton({ rows = 5, columns = 6, className }: DataSkeletonProps & { rows?: number; columns?: number }) {
  return (
    <div className={cn("space-y-1", className)}>
      {/* Header */}
      <div className="flex items-center gap-3 py-2 px-2 border-b">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, i) => (
        <TableRowSkeleton key={i} columns={columns} />
      ))}
    </div>
  );
}

/** Skeleton for a chart */
export function ChartSkeleton({ className }: DataSkeletonProps) {
  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-20" />
      </div>
      <Skeleton className="h-[200px] w-full" />
    </div>
  );
}

/** Skeleton for the metrics grid (4 cards) */
export function MetricsGridSkeleton({ className }: DataSkeletonProps) {
  return (
    <div className={cn("grid grid-cols-2 md:grid-cols-4 gap-4", className)}>
      {Array.from({ length: 4 }).map((_, i) => (
        <MetricCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** Skeleton for a panel with header and content */
export function PanelSkeleton({ className }: DataSkeletonProps) {
  return (
    <div className={cn("rounded-lg border bg-card", className)}>
      <div className="p-4 border-b">
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="p-4">
        <TableSkeleton rows={4} columns={5} />
      </div>
    </div>
  );
}
