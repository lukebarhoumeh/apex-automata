# Loveable UI/UX Implementation Checklist

## Quick Reference for Frontend Development

### 🔴 Critical (Must Have)

#### 1. Database Setup
- [x] Create `users` table with fixed USER_ID: `b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f` ✅
- [x] Create `risk_metrics` table ✅
- [x] Create `daily_equity` table ✅
- [ ] Create `exchange_credentials` table (if needed) - Not required for MVP
- [x] Verify all foreign key constraints ✅

#### 2. WebSocket Connection
- [x] Connect to `ws://localhost:3001/events` ✅ (tradingApi.ts)
- [x] Handle connection/disconnection states ✅ (useTradingEngine)
- [x] Auto-reconnect on disconnect ✅
- [x] Display connection status indicator ✅ (ConnectionStatusBanner)

#### 3. Engine Status Display
- [x] Show `engineRunning` status (green/red indicator) ✅ (EngineStateIndicator)
- [x] Display `mode` (Paper/Live badge) ✅ (DashboardHeader)
- [x] Show `paused` state ✅
- [x] Display `killSwitch.active` with reasons ✅
- [x] Show `activeSymbols` list ✅ (SystemHealthPanel, LiveTickersPanel)

#### 4. Engine Controls
- [x] "Start Engine" button → `POST /api/engine/start` ✅
- [x] "Stop Engine" button → `POST /api/engine/stop` ✅
- [x] "Kill Switch" button → `POST /api/engine/kill` ✅
- [x] Mode selector (Paper/Live) in start request ✅
- [x] Disable buttons when engine is running/stopped appropriately ✅

#### 5. Warmup Status
- [x] Display `warmupComplete` status ✅ (WarmupIndicator)
- [x] Show `candlesBuffered` per symbol (e.g., "BTC-USD: 150/200") ✅
- [x] Progress bar per symbol ✅
- [x] Warning banner when warmup incomplete ✅ (StaleDataWarning)

### 🟡 Important (Should Have)

#### 6. Real-Time Metrics Panel
- [x] `wsLatencyMs` - WebSocket latency (ms) ✅ (SystemHealthPanel)
- [x] `restLatencyMs` - REST API latency (ms) ✅
- [x] `spreadPctile` - Spread percentile (0-100) ✅ (DashboardHeader)
- [x] `regime` - Market regime ("trend" or "chop") ✅

#### 7. Positions Table
- [x] Real-time positions from Supabase Realtime ✅ (PositionsPanelConnected)
- [x] Columns: Symbol, Side, Size, Avg Price, Market Price, Unrealized P&L ✅
- [x] Color code P&L (green profit, red loss) ✅
- [x] Sort by symbol or P&L ✅
- [x] Empty state when no positions ✅

#### 8. Orders Blotter
- [x] Real-time orders from Supabase Realtime ✅ (OrdersBlotter)
- [x] Columns: ID, Symbol, Side, Type, Size, Price, Status, Filled Size ✅
- [x] Filter by status (pending, open, done, cancelled) ✅
- [x] Sort by time (newest first) ✅
- [x] Status badges (color coded) ✅

#### 9. Fills Log
- [x] Real-time fills from Supabase Realtime ✅ (FillsTable)
- [x] Columns: Time, Symbol, Side, Price, Size, Fee, Order ID ✅
- [x] Chronological order (newest first) ✅
- [x] Format currency values properly ✅

#### 10. Risk Dashboard
- [x] Display `risk.dailyPnLUsd` (with +/- indicator) ✅ (RiskDashboard)
- [x] Display `risk.exposureUsd` (total exposure) ✅
- [x] Display `risk.maxDrawdownPct` (with warning thresholds) ✅
- [x] Display `risk.killSwitchActive` status ✅
- [x] Color code based on risk levels ✅

### 🟢 Nice to Have (Enhancements)

#### 11. Signals Panel
- [x] Display signals from WebSocket `Signal` events ✅ (LiveSignalsTable)
- [x] Show: Symbol, Strategy, Direction, Strength, Price, Stop Loss, Take Profit ✅
- [x] Color code by direction (green buy, red sell) ✅
- [x] Strength indicator (progress bar or badge) ✅
- [x] Filter by strategy ✅

#### 12. Alerts Panel
- [x] Display alerts from Supabase Realtime ✅ (AlertsPanel)
- [x] Severity badges (info/warning/critical) ✅
- [x] Filter by severity ✅
- [x] Mark as read functionality ✅
- [x] Timestamp display ✅
- [ ] Auto-dismiss info alerts after 5s

#### 13. Price Tickers
- [x] Real-time price display per `activeSymbol` ✅ (LiveTickersPanel)
- [x] Price change indicators (up/down arrows) ✅
- [x] Last 24h change percentage ✅
- [ ] Click to view detailed chart

#### 14. Data Gap Warning
- [x] Banner when `warmupComplete` is false ✅ (StaleDataWarning)
- [x] Warning when data gap detected (from `RiskEvent`) ✅
- [x] Auto-dismiss when resolved ✅
- [x] Icon indicator (⚠️) ✅

#### 15. Price Charts
- [x] Real-time 1-minute candle chart ✅ (CandleChart)
- [x] Volume bars ✅
- [ ] Price line with bid/ask
- [x] Time range selector (1h, 4h, 24h, 7d) ✅
- [x] Technical indicators overlay (Donchian, VWAP) ✅

### 📊 Data Fetching

#### REST API Calls
```typescript
// Get initial status
GET /api/status
// Response: Full status object (see TECHNICAL_OVERVIEW.md)

// Start engine
POST /api/engine/start
Body: { mode: "paper" | "live" }

// Stop engine
POST /api/engine/stop

// Kill switch
POST /api/engine/kill
```

#### WebSocket Event Handlers
```typescript
// Use existing hook: useRuntimeEvents
import { useRuntimeEvents } from './hooks/useRuntimeEvents';

const { 
  isConnected,
  onStatusUpdate,
  onTickerUpdate,
  onPositionUpdate,
  onOrderUpdate,
  onFill,
  onSignal,
  onRiskEvent,
  onAlert
} = useRuntimeEvents({
  onStatusUpdate: (status) => {
    // Update engine status, warmup, metrics
  },
  onTickerUpdate: (ticker) => {
    // Update price data
  },
  onPositionUpdate: (position) => {
    // Update positions table
  },
  onOrderUpdate: (order) => {
    // Update orders blotter
  },
  onFill: (fill) => {
    // Add to fills log
  },
  onSignal: (signal) => {
    // Add to signals panel
  },
  onRiskEvent: (event) => {
    // Show risk alert, update kill switch status
  },
  onAlert: (alert) => {
    // Add to alerts panel
  }
});
```

### 🎨 UI/UX Guidelines

#### Color Scheme
- **Success/Profit**: Green (#10b981)
- **Error/Loss**: Red (#ef4444)
- **Warning**: Yellow (#f59e0b)
- **Info**: Blue (#3b82f6)
- **Neutral**: Gray (#6b7280)

#### Status Indicators
- **Engine Running**: Green dot + "RUNNING" text
- **Engine Stopped**: Gray dot + "STOPPED" text
- **Kill Switch Active**: Red dot + "KILL SWITCH ACTIVE" + reasons
- **Paused**: Yellow dot + "PAUSED" text
- **Warmup In Progress**: Yellow spinner + progress

#### Typography
- **Headers**: Bold, 18-24px
- **Body**: Regular, 14-16px
- **Labels**: Medium, 12-14px
- **Values**: Monospace for numbers (prices, sizes)

#### Layout Suggestions
```
┌─────────────────────────────────────────┐
│  Header: AtlasBot | Status | Controls   │
├─────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐           │
│  │  Status  │  │  Metrics  │           │
│  │  Panel   │  │  Panel   │           │
│  └──────────┘  └──────────┘           │
├─────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐           │
│  │ Positions│  │  Orders  │           │
│  │  Table   │  │ Blotter  │           │
│  └──────────┘  └──────────┘           │
├─────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐           │
│  │ Signals  │  │  Alerts  │           │
│  │  Panel   │  │  Panel   │           │
│  └──────────┘  └──────────┘           │
└─────────────────────────────────────────┘
```

### 🐛 Error Handling

#### API Errors
- [x] Display error toast on API failures ✅
- [x] Show specific error messages from API ✅
- [ ] Retry failed requests (with backoff)
- [x] Handle network errors gracefully ✅

#### WebSocket Errors
- [x] Show connection error banner ✅ (ConnectionStatusBanner)
- [x] Auto-reconnect with exponential backoff ✅
- [x] Display "Reconnecting..." indicator ✅
- [x] Handle message parsing errors ✅

#### Empty States
- [x] "No positions" message ✅
- [x] "No orders" message ✅
- [x] "No signals" message ✅
- [x] "No alerts" message ✅
- [x] "Engine not running" placeholder ✅

### 📱 Responsive Design

- [x] Mobile-friendly layout ✅
- [x] Tablet optimization ✅
- [x] Desktop full-width layout ✅
- [x] Collapsible panels on mobile ✅
- [x] Touch-friendly buttons (min 44x44px) ✅

### ⚡ Performance

- [x] Debounce rapid WebSocket updates ✅ (useTradingEngine 150ms)
- [ ] Virtual scrolling for large lists (100+ items)
- [x] Lazy load charts ✅
- [x] Memoize expensive calculations ✅
- [x] Optimize re-renders with React.memo ✅

### 🔒 Security

- [x] Never expose API keys in frontend ✅
- [x] Validate user input before API calls ✅
- [x] Sanitize displayed data ✅
- [x] Handle sensitive data (credentials) securely ✅

### 📝 Testing Checklist

- [x] Test engine start/stop/kill buttons ✅
- [x] Test WebSocket connection/disconnection ✅
- [x] Test all WebSocket event handlers ✅
- [x] Test error states ✅
- [x] Test empty states ✅
- [x] Test responsive layout ✅
- [x] Test with engine running/stopped ✅
- [x] Test with kill switch active ✅

---

## Implementation Status: ✅ COMPLETE

All critical and important items from the checklist have been implemented. The UI is production-ready for the trading bot.

**Remaining nice-to-have items:**
- Auto-dismiss info alerts after 5s
- Click ticker to view chart
- Bid/ask price line on charts
- Virtual scrolling for very large lists
- Retry with backoff for failed requests

---

**Last Updated**: December 12, 2025
**Status**: UI Implementation Complete
