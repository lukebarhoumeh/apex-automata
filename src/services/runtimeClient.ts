// Runtime Client - Direct connection to Atlas Node.js backend

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';

export interface RuntimeStatus {
  mode: 'paper' | 'live';
  paused: boolean;
  dailyStopHit: boolean;
  killSwitch: {
    active: boolean;
    reasons: string[];
    since?: number;
  };
  wsLatencyMs: number;
  restLatencyMs: number;
  spreadPctile: number;
  regime: 'trend' | 'chop';
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

class RuntimeClient {
  async getStatus(): Promise<RuntimeStatus> {
    const response = await fetch(`${API_URL}/api/status`);
    if (!response.ok) {
      throw new Error(`Status request failed: ${response.statusText}`);
    }
    return response.json();
  }

  async pause(): Promise<{ ok: boolean }> {
    const response = await fetch(`${API_URL}/api/control/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Pause request failed: ${response.statusText}`);
    }
    return response.json();
  }

  async resume(): Promise<{ ok: boolean }> {
    const response = await fetch(`${API_URL}/api/control/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Resume request failed: ${response.statusText}`);
    }
    return response.json();
  }

  async closeAll(reason: string, confirm: string): Promise<{ ok: boolean; submitted: number }> {
    const response = await fetch(`${API_URL}/api/control/close-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, confirm }),
    });
    if (!response.ok) {
      throw new Error(`Close all request failed: ${response.statusText}`);
    }
    return response.json();
  }

  async updateRiskConfig(config: RiskConfig): Promise<{ ok: boolean }> {
    const response = await fetch(`${API_URL}/api/config/risk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!response.ok) {
      throw new Error(`Risk config update failed: ${response.statusText}`);
    }
    return response.json();
  }

  async updateSignalsConfig(config: SignalsConfig): Promise<{ ok: boolean }> {
    const response = await fetch(`${API_URL}/api/config/signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!response.ok) {
      throw new Error(`Signals config update failed: ${response.statusText}`);
    }
    return response.json();
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${API_URL}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const runtimeClient = new RuntimeClient();
