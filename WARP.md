# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

**AtlasBot** is an automated trading dashboard/terminal built with modern React technologies. It provides a comprehensive interface for monitoring and controlling automated trading operations, featuring real-time metrics, position management, risk controls, and market analysis.

## Development Commands

### Core Development
```bash
# Install dependencies
npm i

# Start development server with hot reload
npm run dev

# Build for production
npm run build

# Build in development mode (with sourcemaps)
npm run build:dev

# Preview production build locally
npm run preview

# Run linting
npm lint
```

### Alternative Package Manager
The project includes `bun.lockb`, indicating Bun compatibility:
```bash
# Using Bun (faster alternative)
bun install
bun run dev
bun run build
```

## Architecture Overview

### Technology Stack
- **Frontend**: React 18 + TypeScript
- **Build Tool**: Vite with SWC
- **UI Framework**: shadcn/ui (Radix UI + Tailwind CSS)
- **Routing**: React Router DOM
- **State Management**: React Query (TanStack Query)
- **Styling**: Tailwind CSS with custom trading-specific design system
- **Forms**: React Hook Form + Zod validation
- **Charts**: Recharts library
- **Theme**: Dark-mode trading terminal aesthetic

### Project Structure
```
src/
├── components/
│   ├── dashboard/          # Trading-specific dashboard components
│   │   ├── ChartSection.tsx
│   │   ├── DashboardHeader.tsx
│   │   ├── MarketConditions.tsx
│   │   ├── MetricsGrid.tsx
│   │   ├── PositionsPanel.tsx
│   │   ├── RiskControls.tsx
│   │   └── SignalsPanel.tsx
│   └── ui/                 # shadcn/ui components (50+ components)
├── hooks/                  # Custom React hooks
├── lib/                    # Utilities (cn function, etc.)
├── pages/                  # Route components
└── main.tsx               # App entry point with providers
```

### Key Application Patterns

#### Dashboard-Centric Architecture
The application is built around a single comprehensive dashboard (`src/pages/Index.tsx`) that orchestrates multiple specialized panels:

- **MetricsGrid**: Real-time trading metrics with animated success/error states
- **ChartSection**: Market data visualization and analysis
- **PositionsPanel**: Active trading positions management
- **RiskControls**: Risk management parameters and safety controls
- **SignalsPanel**: Trading signals and alerts
- **MarketConditions**: Current market status and conditions

#### Component Design System
- **Metric Cards**: Consistent design with success/destructive/warning variants
- **Animated States**: Profit/loss glow effects, pulse animations for live data
- **Trading-Specific UI**: Kill switches, bot state management, risk indicators
- **Responsive Grid Layouts**: Adaptive for desktop trading terminals

#### State Management Pattern
- Bot states: `"paper" | "live" | "paused"`
- React Query for server state and data fetching
- Local component state for UI interactions
- Context providers for theming and notifications

### Theme and Styling
- **Design System**: Custom CSS variables for trading colors (profit-glow, loss-glow)
- **Trading Terminal Aesthetic**: Dark theme optimized for trading environments
- **Responsive Design**: Optimized for both desktop terminals and mobile monitoring
- **Custom Animations**: Terminal-style grid background, hover effects, state transitions

## Development Guidelines

### Component Development
- Use shadcn/ui components as the foundation
- Implement trading-specific variants (success=profit, destructive=loss)
- Include proper hover states and animations for real-time data
- Follow the established metric card pattern for consistency

### Adding New Features
- Dashboard components go in `src/components/dashboard/`
- Use the established pattern of metrics with variants and animations
- Integrate with the tabbed layout system in the main dashboard
- Consider both paper trading and live trading contexts

### Trading-Specific Considerations
- Always handle bot state transitions properly
- Include safety confirmations for destructive actions (kill switches)
- Use appropriate color coding (green=profit, red=loss, yellow=warning)
- Consider real-time data update patterns

### Path Aliases
The project uses TypeScript path aliases defined in `components.json`:
- `@/components` → `src/components`
- `@/lib` → `src/lib`
- `@/hooks` → `src/hooks`
- `@/ui` → `src/components/ui`

## Lovable Integration

This project is integrated with **Lovable** (lovable.dev), a platform for AI-powered development:
- Changes made via Lovable are automatically committed to this repository
- Project URL: https://lovable.dev/projects/971d867c-7d69-48f3-86e9-d4dfd83b161f
- Deployment happens through Lovable's interface (Share → Publish)

## Testing Individual Components

Since this is a dashboard application, test individual components by:
```bash
# Start dev server and navigate to components
npm run dev
# Visit http://localhost:5173 to see the full dashboard

# For isolated component testing, you may want to create temporary test pages
# in src/pages/ and add routes to App.tsx
```

## Common Development Tasks

### Adding New Metrics
1. Add to `MetricsGrid.tsx` following the existing `MetricCard` pattern
2. Use appropriate icons from `lucide-react`
3. Set correct variant (`success`/`destructive`/`warning`)
4. Include trend indicators and change percentages

### Creating New Dashboard Panels
1. Create component in `src/components/dashboard/`
2. Import and integrate in `src/pages/Index.tsx`
3. Follow the established grid layout patterns
4. Use shadcn/ui components for consistency

### Modifying Bot States
Bot state logic is centralized in `Index.tsx` and `DashboardHeader.tsx`. The three states are:
- `paper`: Paper trading mode
- `live`: Live trading mode  
- `paused`: Trading paused

### Working with Real-time Data
- Use React Query for data fetching
- Implement proper loading and error states
- Consider WebSocket connections for live data
- Use the established animation patterns for data updates