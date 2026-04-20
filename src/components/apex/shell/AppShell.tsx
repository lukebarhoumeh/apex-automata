import { useCallback, useMemo, useState } from "react";
import { Outlet } from "react-router-dom";
import { toast } from "sonner";
import { AppSidebar } from "./AppSidebar";
import { TopBar } from "./TopBar";
import { TickerTape, type TickerItem } from "./TickerTape";
import { Footer } from "./Footer";
import { CommandPalette } from "./CommandPalette";
import { useGlobalKeyboard } from "./useGlobalKeyboard";

/** Static ticker items — replaced with a live feed in Phase 3. */
const MOCK_TICKER: readonly TickerItem[] = [
  { symbol: "BTC-USD", price: 68_412.55, changePct: 1.24, spark: [100, 102, 101, 104, 106, 105, 108, 110] },
  { symbol: "ETH-USD", price: 3_456.82, changePct: 2.11, spark: [100, 99, 101, 103, 102, 104, 106, 108] },
  { symbol: "SOL-USD", price: 172.34, changePct: -0.62, spark: [110, 108, 109, 107, 106, 108, 105, 104] },
  { symbol: "BTC-PERP-INTX", price: 68_420.1, changePct: 1.3, spark: [100, 101, 103, 102, 105, 106, 107, 110] },
  { symbol: "ETH-PERP-INTX", price: 3_458.4, changePct: 2.22, spark: [100, 99, 102, 103, 104, 106, 108, 109] },
  { symbol: "AVAX-USD", price: 42.18, changePct: -1.14, spark: [120, 118, 119, 117, 116, 115, 114, 113] },
  { symbol: "MATIC-USD", price: 1.085, changePct: 0.42, spark: [100, 101, 102, 101, 103, 102, 104, 103] },
  { symbol: "LINK-USD", price: 16.22, changePct: 0.18, spark: [100, 101, 100, 102, 101, 103, 102, 101] },
];

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

  const tickerItems = useMemo(() => MOCK_TICKER, []);

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
