import { useCallback, useState } from "react";
import { Outlet } from "react-router-dom";
import { toast } from "sonner";
import { AppSidebar } from "./AppSidebar";
import { TopBar } from "./TopBar";
import { TickerTape } from "./TickerTape";
import { Footer } from "./Footer";
import { CommandPalette } from "./CommandPalette";
import { useGlobalKeyboard } from "./useGlobalKeyboard";
import { useTickerFeed } from "@/hooks/apex/useTickerFeed";

export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  const handleKillSwitch = useCallback(() => {
    toast.warning("Kill-switch pressed (placeholder)", {
      description: "Wire to /runtime/kill in Phase 3.",
    });
  }, []);

  const handleSwitchMode = useCallback((mode: "paper" | "live" | "paused") => {
    toast.info(`Mode → ${mode.toUpperCase()} (placeholder)`);
  }, []);

  useGlobalKeyboard({
    onOpenPalette: openPalette,
    onClosePalette: closePalette,
  });

  const tickerItems = useTickerFeed();

  return (
    <div className="min-h-screen bg-obsidian-0 text-fg-0">
      <AppSidebar />
      <div className="ml-[224px] flex min-h-screen flex-col">
        <TopBar
          onOpenPalette={openPalette}
          onKillSwitch={handleKillSwitch}
        />
        <TickerTape items={tickerItems} />
        <main className="flex-1 overflow-x-hidden">
          <Outlet />
        </main>
        <Footer />
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onSwitchMode={handleSwitchMode}
        onKillSwitch={handleKillSwitch}
      />
    </div>
  );
}
