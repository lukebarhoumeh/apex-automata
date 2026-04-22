import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import App from "./App.tsx";
import "./index.css";

// Self-heal defaults (P5):
// - Exponential backoff with jitter so a 429 storm calms down instead of
//   thrashing the engine (was: instant retry → kept tripping the limiter).
// - Skip retry for non-429 4xx (genuine client errors).
// - refetchOnReconnect picks up state automatically when window regains
//   connectivity. Per-hook `retry` overrides win where hooks set them.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const status = (error as { status?: number } | null)?.status;
        if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
          return false;
        }
        return failureCount < 4;
      },
      retryDelay: (attemptIndex) => {
        const base = Math.min(500 * 2 ** attemptIndex, 8000);
        const jitter = Math.random() * 250;
        return base + jitter;
      },
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <App />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
);
