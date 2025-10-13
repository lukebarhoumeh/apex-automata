import { cn } from "@/lib/utils";

interface LoadingPulseProps {
  className?: string;
  size?: "sm" | "md" | "lg";
}

export const LoadingPulse = ({ className, size = "md" }: LoadingPulseProps) => {
  const sizeClasses = {
    sm: "h-2 w-2",
    md: "h-3 w-3",
    lg: "h-4 w-4",
  };

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <div className={cn(sizeClasses[size], "rounded-full bg-primary animate-pulse")} style={{ animationDelay: "0ms" }} />
      <div className={cn(sizeClasses[size], "rounded-full bg-primary animate-pulse")} style={{ animationDelay: "150ms" }} />
      <div className={cn(sizeClasses[size], "rounded-full bg-primary animate-pulse")} style={{ animationDelay: "300ms" }} />
    </div>
  );
};
