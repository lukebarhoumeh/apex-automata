import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { RuntimeWsProvider } from "@/runtime/ws";
import { UnifiedEventProvider } from "@/runtime/event-bus";
import { WsDebugPanel } from "@/components/debug/WsDebugPanel";
import { AppShell } from "@/components/apex/shell/AppShell";
import Index from "./pages/Index";
import Orders from "./pages/Orders";
import Signals from "./pages/Signals";
import Risk from "./pages/Risk";
import Model from "./pages/Model";
import Backtest from "./pages/Backtest";
import Journal from "./pages/Journal";
import Alerts from "./pages/Alerts";
import Settings from "./pages/Settings";
import NotFound from "./pages/NotFound";

const App = () => {
  return (
    <BrowserRouter>
      <AuthProvider>
        <RuntimeWsProvider showNotifications={false}>
          <UnifiedEventProvider>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="/" element={<Index />} />
                <Route path="/orders" element={<Orders />} />
                <Route path="/signals" element={<Signals />} />
                <Route path="/risk" element={<Risk />} />
                <Route path="/model" element={<Model />} />
                <Route path="/backtest" element={<Backtest />} />
                <Route path="/journal" element={<Journal />} />
                <Route path="/alerts" element={<Alerts />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>

            {/* Debug Panel — only visible when VITE_DEBUG_WS=1 */}
            <WsDebugPanel />
          </UnifiedEventProvider>
        </RuntimeWsProvider>
      </AuthProvider>
    </BrowserRouter>
  );
};

export default App;
