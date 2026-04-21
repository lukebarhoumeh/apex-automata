// Runtime Client - Direct connection to Atlas Node.js backend
// API Reference: https://github.com/atlasbot/core-node

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';

// ============= Types =============

export interface RuntimeStatus {
  engineRunning: boolean;
  mode: 'paper' | 'live' | null;
  sessionId?: string | null;
  sessionStartedAt?: number | null;
  paused: boolean;
  dailyStopHit: boolean;
  killSwitch: {
    active: boolean;
    reasons: string[];
    since?: number | null;
  };
  tradingState?: 'RUNNING' | 'PAUSED' | 'HALTED';
  haltReasonCode?: string;
  wsLatencyMs: number;
  restLatencyMs: number;
  spreadPctile: number;
  regime: 'trend' | 'chop';
  risk?: {
    exposureUsd: number;
    dailyPnLUsd: number;
    maxDrawdownPct: number;
    killSwitchActive: boolean;
  };
  activeSymbols?: string[];
  warmupComplete?: boolean;
  candlesBuffered?: Record<string, number>;
  requiredWarmup?: number;
  symbols?: string[];
}

export interface RiskStatus {
  killSwitchActive: boolean;
  killSwitchReasons: string[];
  dailyPnL: number;
  dailyPnLR: number;
  maxDailyLoss: number;
  exposureUsd: number;
  heatPct: number;
  maxHeat: number;
}

export interface SessionStats {
  totalTrades: number;
  winRate: number;
  pnlUsd: number;
  pnlR: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  expectancy: number;
  profitFactor: number;
}

export interface EquityPoint {
  timestamp: string;
  equity: number;
  pnl: number;
}

export interface RegimeStatus {
  symbol: string;
  regime: 'trend' | 'chop' | 'unknown';
  confidence: number;
  indicators: {
    adx: number;
    atr: number;
    volatility: number;
  };
}

export interface MetaFilterStats {
  enabled: boolean;
  threshold: number;
  totalSignals: number;
  allowedSignals: number;
  rejectedSignals: number;
  avgProbability: number;
}

export interface Strategy {
  id: string;
  name: string;
  enabled: boolean;
  params: Record<string, unknown>;
  stats?: {
    trades: number;
    winRate: number;
    avgR: number;
  };
}

export interface RiskConfig {
  perTradeBp: number;
  heatBp: number;
  dailyStopR: number;
  clampPct?: number;
  timeStops?: Record<string, number>;
  spreadPctileMax?: number;
  atrBurstMult?: number;
}

export interface SignalsConfig {
  breakout?: {
    enabled: boolean;
    adxMin?: number;
    donchianN?: number;
    atrPctileMin?: number;
  };
  vwap_mr?: {
    enabled: boolean;
    zAbsMin?: number;
    adxMax?: number;
  };
  meta?: {
    enabled: boolean;
    threshold: number;
  };
}

// ============= Client =============

class RuntimeClient {
  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || error.message || response.statusText);
    }
    return response.json();
  }

  // ============= Health =============
  
  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${API_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ============= Status =============
  
  async getStatus(): Promise<RuntimeStatus> {
    return this.request<RuntimeStatus>('/api/status');
  }

  // ============= Risk =============
  
  async getRiskStatus(): Promise<RiskStatus> {
    return this.request<RiskStatus>('/api/risk/status');
  }

  async toggleKillSwitch(): Promise<{ ok: boolean; active: boolean }> {
    return this.request('/api/risk/killswitch', { method: 'POST' });
  }

  async resetDailyPnL(): Promise<{ ok: boolean }> {
    return this.request('/api/risk/reset/daily', { method: 'POST' });
  }

  async updateRiskConfig(config: RiskConfig): Promise<{ ok: boolean }> {
    return this.request('/api/config/risk', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  // ============= Analytics =============
  
  async getSessionStats(): Promise<SessionStats> {
    return this.request<SessionStats>('/api/analytics/session');
  }

  async getEquityCurve(): Promise<EquityPoint[]> {
    return this.request<EquityPoint[]>('/api/analytics/equity-curve');
  }

  // ============= Regime =============
  
  async getRegimeStatus(): Promise<RegimeStatus[]> {
    return this.request<RegimeStatus[]>('/api/regime/status');
  }

  // ============= Meta Filter =============
  
  async getMetaFilterStats(): Promise<MetaFilterStats> {
    return this.request<MetaFilterStats>('/api/metafilter/stats');
  }

  async toggleMetaFilter(): Promise<{ ok: boolean; enabled: boolean }> {
    return this.request('/api/metafilter/toggle', { method: 'POST' });
  }

  // ============= Strategies =============
  
  async getStrategies(): Promise<Strategy[]> {
    return this.request<Strategy[]>('/api/strategies');
  }

  async toggleStrategy(id: string): Promise<{ ok: boolean; enabled: boolean }> {
    return this.request(`/api/strategies/${id}/toggle`, { method: 'POST' });
  }

  async updateSignalsConfig(config: SignalsConfig): Promise<{ ok: boolean }> {
    return this.request('/api/config/signals', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  // ============= Engine Control =============
  
  async startEngine(
    mode: 'paper' | 'live' = 'paper',
    opts?: { confirm?: string; marketDataEnv?: 'sandbox' | 'production' }
  ): Promise<{ ok: boolean }> {
    return this.request('/api/engine/start', {
      method: 'POST',
      body: JSON.stringify({ mode, ...opts }),
    });
  }

  async stopEngine(): Promise<{ ok: boolean }> {
    return this.request('/api/engine/stop', { method: 'POST' });
  }

  async killEngine(): Promise<{ ok: boolean }> {
    // Activates kill switch and stops engine immediately
    return this.request('/api/risk/killswitch', { method: 'POST' });
  }

  // ============= Position Control =============
  
  async pause(): Promise<{ ok: boolean }> {
    return this.request('/api/control/pause', { method: 'POST' });
  }

  async resume(): Promise<{ ok: boolean }> {
    return this.request('/api/control/resume', { method: 'POST' });
  }

  async closeAll(reason: string, confirm: string): Promise<{ ok: boolean; submitted: number }> {
    return this.request('/api/control/close-all', {
      method: 'POST',
      body: JSON.stringify({ reason, confirm }),
    });
  }
}

export const runtimeClient = new RuntimeClient();
