import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { AuthProvider } from "@/contexts/AuthContext";
import { RuntimeWsProvider } from "@/runtime/ws";
import { UnifiedEventProvider } from "@/runtime/event-bus";
import { ActiveSessionProvider } from "@/runtime/session";
import { WsDebugPanel } from "@/components/debug/WsDebugPanel";
import { AppShell } from "@/components/apex/shell/AppShell";
import NotFound from "./pages/NotFound";

// Route-level code splitting: each page (and its component/dep subtree, e.g.
// recharts on Dashboard/Model) loads as its own chunk on first navigation.
// NotFound stays eager — it is 13 lines and must never flash a loader.
const Index = lazy(() => import("./pages/Index"));
const Orders = lazy(() => import("./pages/Orders"));
const Signals = lazy(() => import("./pages/Signals"));
const Risk = lazy(() => import("./pages/Risk"));
const Model = lazy(() => import("./pages/Model"));
const Backtest = lazy(() => import("./pages/Backtest"));
const Journal = lazy(() => import("./pages/Journal"));
const Alerts = lazy(() => import("./pages/Alerts"));
const Settings = lazy(() => import("./pages/Settings"));

// Minimal theme-consistent fallback. Pages themselves render null while data
// loads (see Index), so this only shows during the brief chunk fetch. The
// spinner matches the Loader2/animate-spin pattern used in EngineControls.
const RouteFallback = () => (
  <div className="flex h-64 items-center justify-center text-fg-2">
    <Loader2 size={16} className="animate-spin" aria-label="Loading" />
  </div>
);

// Suspense sits INSIDE each route element so the AppShell (sidebar, top bar,
// ticker) stays mounted while a lazy page chunk loads.
const lazyRoute = (node: ReactNode) => (
  <Suspense fallback={<RouteFallback />}>{node}</Suspense>
);

const App = () => {
  return (
    <BrowserRouter>
      <AuthProvider>
        <RuntimeWsProvider showNotifications={false}>
          <UnifiedEventProvider>
            <ActiveSessionProvider>
              <Routes>
                <Route element={<AppShell />}>
                  <Route path="/" element={lazyRoute(<Index />)} />
                  <Route path="/orders" element={lazyRoute(<Orders />)} />
                  <Route path="/signals" element={lazyRoute(<Signals />)} />
                  <Route path="/risk" element={lazyRoute(<Risk />)} />
                  <Route path="/model" element={lazyRoute(<Model />)} />
                  <Route path="/backtest" element={lazyRoute(<Backtest />)} />
                  <Route path="/journal" element={lazyRoute(<Journal />)} />
                  <Route path="/alerts" element={lazyRoute(<Alerts />)} />
                  <Route path="/settings" element={lazyRoute(<Settings />)} />
                  <Route path="*" element={<NotFound />} />
                </Route>
              </Routes>

              {/* Debug Panel — only visible when VITE_DEBUG_WS=1 */}
              <WsDebugPanel />
            </ActiveSessionProvider>
          </UnifiedEventProvider>
        </RuntimeWsProvider>
      </AuthProvider>
    </BrowserRouter>
  );
};

export default App;
