import { BrowserRouter, Routes, Route } from "react-router-dom";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { AuthProvider } from "@/contexts/AuthContext";
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
        <SidebarProvider>
        <div className="flex min-h-screen w-full">
          <AppSidebar />
          <div className="flex-1 flex flex-col">
            {/* Global Sidebar Trigger in Header */}
            <header className="sticky top-0 z-40 h-14 flex items-center border-b border-border bg-card/95 backdrop-blur px-4">
              <SidebarTrigger />
            </header>
            
            {/* Main Content */}
            <main className="flex-1">
              <Routes>
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
              </Routes>
            </main>
          </div>
        </div>
      </SidebarProvider>
      </AuthProvider>
    </BrowserRouter>
  );
};

export default App;
