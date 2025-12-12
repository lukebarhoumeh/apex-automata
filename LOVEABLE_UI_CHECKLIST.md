# Loveable UI/UX Implementation Checklist

## Quick Reference for Frontend Development

### 🔴 Critical (Must Have)

#### 1. Database Setup
- [ ] Create `users` table with fixed USER_ID: `b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f`
- [ ] Create `risk_metrics` table
- [ ] Create `daily_equity` table
- [ ] Create `exchange_credentials` table (if needed)
- [ ] Verify all foreign key constraints

#### 2. WebSocket Connection
- [ ] Connect to `ws://localhost:3001/events`
- [ ] Handle connection/disconnection states
- [ ] Auto-reconnect on disconnect
- [ ] Display connection status indicator

#### 3. Engine Status Display
- [ ] Show `engineRunning` status (green/red indicator)
- [ ] Display `mode` (Paper/Live badge)
- [ ] Show `paused` state
- [ ] Display `killSwitch.active` with reasons
- [ ] Show `activeSymbols` list

#### 4. Engine Controls
- [ ] "Start Engine" button → `POST /api/engine/start`
- [ ] "Stop Engine" button → `POST /api/engine/stop`
- [ ] "Kill Switch" button → `POST /api/engine/kill`
- [ ] Mode selector (Paper/Live) in start request
- [ ] Disable buttons when engine is running/stopped appropriately

#### 5. Warmup Status
- [ ] Display `warmupComplete` status
- [ ] Show `candlesBuffered` per symbol (e.g., "BTC-USD: 150/200")
- [ ] Progress bar per symbol
- [ ] Warning banner when warmup incomplete

### 🟡 Important (Should Have)

#### 6. Real-Time Metrics Panel
- [ ] `wsLatencyMs` - WebSocket latency (ms)
- [ ] `restLatencyMs` - REST API latency (ms)
- [ ] `spreadPctile` - Spread percentile (0-100)
- [ ] `regime` - Market regime ("trend" or "chop")

#### 7. Positions Table
- [ ] Real-time positions from WebSocket `PositionUpdate` events
- [ ] Columns: Symbol, Side, Size, Avg Price, Market Price, Unrealized P&L
- [ ] Color code P&L (green profit, red loss)
- [ ] Sort by symbol or P&L
- [ ] Empty state when no positions

#### 8. Orders Blotter
- [ ] Real-time orders from WebSocket `OrderUpdate` events
- [ ] Columns: ID, Symbol, Side, Type, Size, Price, Status, Filled Size
- [ ] Filter by status (pending, open, done, cancelled)
- [ ] Sort by time (newest first)
- [ ] Status badges (color coded)

#### 9. Fills Log
- [ ] Real-time fills from WebSocket `Fill` events
- [ ] Columns: Time, Symbol, Side, Price, Size, Fee, Order ID
- [ ] Chronological order (newest first)
- [ ] Format currency values properly

#### 10. Risk Dashboard
- [ ] Display `risk.dailyPnLUsd` (with +/- indicator)
- [ ] Display `risk.exposureUsd` (total exposure)
- [ ] Display `risk.maxDrawdownPct` (with warning thresholds)
- [ ] Display `risk.killSwitchActive` status
- [ ] Color code based on risk levels

### 🟢 Nice to Have (Enhancements)

#### 11. Signals Panel
- [ ] Display signals from WebSocket `Signal` events
- [ ] Show: Symbol, Strategy, Direction, Strength, Price, Stop Loss, Take Profit
- [ ] Color code by direction (green buy, red sell)
- [ ] Strength indicator (progress bar or badge)
- [ ] Filter by strategy

#### 12. Alerts Panel
- [ ] Display alerts from WebSocket `Alert` events
- [ ] Severity badges (info/warning/critical)
- [ ] Filter by severity
- [ ] Mark as read functionality
- [ ] Timestamp display
- [ ] Auto-dismiss info alerts after 5s

#### 13. Price Tickers
- [ ] Real-time price display per `activeSymbol`
- [ ] Price change indicators (up/down arrows)
- [ ] Last 24h change percentage
- [ ] Click to view detailed chart

#### 14. Data Gap Warning
- [ ] Banner when `warmupComplete` is false
- [ ] Warning when data gap detected (from `RiskEvent`)
- [ ] Auto-dismiss when resolved
- [ ] Icon indicator (⚠️)

#### 15. Price Charts
- [ ] Real-time 1-minute candle chart
- [ ] Volume bars
- [ ] Price line with bid/ask
- [ ] Time range selector (1h, 4h, 24h, 7d)
- [ ] Technical indicators overlay (optional)

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
- [ ] Display error toast on API failures
- [ ] Show specific error messages from API
- [ ] Retry failed requests (with backoff)
- [ ] Handle network errors gracefully

#### WebSocket Errors
- [ ] Show connection error banner
- [ ] Auto-reconnect with exponential backoff
- [ ] Display "Reconnecting..." indicator
- [ ] Handle message parsing errors

#### Empty States
- [ ] "No positions" message
- [ ] "No orders" message
- [ ] "No signals" message
- [ ] "No alerts" message
- [ ] "Engine not running" placeholder

### 📱 Responsive Design

- [ ] Mobile-friendly layout
- [ ] Tablet optimization
- [ ] Desktop full-width layout
- [ ] Collapsible panels on mobile
- [ ] Touch-friendly buttons (min 44x44px)

### ⚡ Performance

- [ ] Debounce rapid WebSocket updates
- [ ] Virtual scrolling for large lists (100+ items)
- [ ] Lazy load charts
- [ ] Memoize expensive calculations
- [ ] Optimize re-renders with React.memo

### 🔒 Security

- [ ] Never expose API keys in frontend
- [ ] Validate user input before API calls
- [ ] Sanitize displayed data
- [ ] Handle sensitive data (credentials) securely

### 📝 Testing Checklist

- [ ] Test engine start/stop/kill buttons
- [ ] Test WebSocket connection/disconnection
- [ ] Test all WebSocket event handlers
- [ ] Test error states
- [ ] Test empty states
- [ ] Test responsive layout
- [ ] Test with engine running/stopped
- [ ] Test with kill switch active

---

## Quick Start for Loveable

1. **Set up database** (see Critical section)
2. **Connect WebSocket** using existing `useRuntimeEvents` hook
3. **Build status panel** with engine controls
4. **Add positions/orders tables** with real-time updates
5. **Add risk dashboard** with metrics
6. **Polish and test**

Refer to `TECHNICAL_OVERVIEW.md` for detailed API documentation and data structures.

---

**Questions?** Check `TECHNICAL_OVERVIEW.md` or review the source code comments.
