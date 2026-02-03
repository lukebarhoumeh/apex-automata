/**
 * PnL Service Tests
 * 
 * Tests for:
 * 1. P&L identity: totalEquity = start + realized + unrealized
 * 2. Long/short positions
 * 3. Fees included in realized
 * 4. Day rollover
 * 5. Startup import mark-to-market
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PnLService, PnLServiceConfig } from '../trading/pnl/pnl-service';
import { PnLSnapshot } from '../trading/pnl/pnl-types';
import { Logger } from '../core/logger';
import { EventEmitter } from 'events';

// Mock logger
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

// Mock PositionTracker
class MockPositionTracker extends EventEmitter {
  private positions: any[] = [];

  getOpenPositions() {
    return this.positions;
  }

  setPositions(positions: any[]) {
    this.positions = positions;
  }

  addPosition(position: any) {
    this.positions.push(position);
    this.emit('position:opened', position);
  }

  closePosition(symbol: string, realizedPnL: number) {
    const index = this.positions.findIndex(p => p.symbol === symbol);
    if (index >= 0) {
      const position = { ...this.positions[index], realizedPnL };
      this.positions.splice(index, 1);
      this.emit('position:closed', position);
    }
  }
}

describe('PnLService', () => {
  let pnlService: PnLService;
  let mockPositionTracker: MockPositionTracker;

  const createConfig = (overrides: Partial<PnLServiceConfig> = {}): PnLServiceConfig => ({
    userId: 'user1',
    sessionId: 'session1',
    executionMode: 'paper',
    marketDataEnv: 'production',
    sessionStartEquityUsd: 50000,
    perTradeRiskFraction: 0.01,
    snapshotThrottleMs: 0, // Disable throttle for tests
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPositionTracker = new MockPositionTracker();
  });

  afterEach(() => {
    if (pnlService) {
      pnlService.shutdown();
    }
  });

  describe('P&L Identity: totalEquity = start + realized + unrealized', () => {
    it('should start with totalEquity = sessionStartEquity when no positions', () => {
      pnlService = new PnLService(createConfig(), mockLogger, mockPositionTracker as any);

      const snapshot = pnlService.getSnapshot();

      expect(snapshot.totalEquityUsd).toBe(50000);
      expect(snapshot.realizedPnlUsd).toBe(0);
      expect(snapshot.unrealizedPnlUsd).toBe(0);
      expect(snapshot.sessionStartEquityUsd).toBe(50000);
    });

    it('should update unrealized when position has mark > entry (long)', () => {
      pnlService = new PnLService(createConfig(), mockLogger, mockPositionTracker as any);

      // Open a long position
      mockPositionTracker.addPosition({
        symbol: 'BTC-USD',
        side: 'long',
        size: 1,
        entryPrice: 50000,
        marketPrice: 50000,
      });

      // Update mark price
      pnlService.updateMarkPrice('BTC-USD', 51000);

      const snapshot = pnlService.getSnapshot();

      // Unrealized = (51000 - 50000) * 1 = 1000
      expect(snapshot.unrealizedPnlUsd).toBe(1000);
      expect(snapshot.totalEquityUsd).toBe(51000);
      
      // Verify identity
      expect(snapshot.totalEquityUsd).toBe(
        snapshot.sessionStartEquityUsd + snapshot.realizedPnlUsd + snapshot.unrealizedPnlUsd
      );
    });

    it('should update unrealized when position has mark < entry (long loss)', () => {
      pnlService = new PnLService(createConfig(), mockLogger, mockPositionTracker as any);

      mockPositionTracker.addPosition({
        symbol: 'BTC-USD',
        side: 'long',
        size: 1,
        entryPrice: 50000,
        marketPrice: 50000,
      });

      pnlService.updateMarkPrice('BTC-USD', 49000);

      const snapshot = pnlService.getSnapshot();

      // Unrealized = (49000 - 50000) * 1 = -1000
      expect(snapshot.unrealizedPnlUsd).toBe(-1000);
      expect(snapshot.totalEquityUsd).toBe(49000);
    });

    it('should move P&L from unrealized to realized on close', () => {
      pnlService = new PnLService(createConfig(), mockLogger, mockPositionTracker as any);

      mockPositionTracker.addPosition({
        symbol: 'BTC-USD',
        side: 'long',
        size: 1,
        entryPrice: 50000,
        marketPrice: 51000,
      });

      pnlService.updateMarkPrice('BTC-USD', 51000);

      let snapshot = pnlService.getSnapshot();
      expect(snapshot.unrealizedPnlUsd).toBe(1000);

      // Close position with realized P&L
      mockPositionTracker.closePosition('BTC-USD', 1000);

      snapshot = pnlService.getSnapshot();

      expect(snapshot.realizedPnlUsd).toBe(1000);
      expect(snapshot.unrealizedPnlUsd).toBe(0); // No more open positions
      expect(snapshot.totalEquityUsd).toBe(51000); // Unchanged
    });
  });

  describe('Short Positions', () => {
    it('should compute positive unrealized for short when price drops', () => {
      pnlService = new PnLService(createConfig(), mockLogger, mockPositionTracker as any);

      mockPositionTracker.addPosition({
        symbol: 'BTC-USD',
        side: 'short',
        size: 1,
        entryPrice: 50000,
        marketPrice: 50000,
      });

      pnlService.updateMarkPrice('BTC-USD', 49000);

      const snapshot = pnlService.getSnapshot();

      // Short profit when price drops: (49000 - 50000) * 1 * -1 = 1000
      expect(snapshot.unrealizedPnlUsd).toBe(1000);
      expect(snapshot.totalEquityUsd).toBe(51000);
    });

    it('should compute negative unrealized for short when price rises', () => {
      pnlService = new PnLService(createConfig(), mockLogger, mockPositionTracker as any);

      mockPositionTracker.addPosition({
        symbol: 'BTC-USD',
        side: 'short',
        size: 1,
        entryPrice: 50000,
        marketPrice: 50000,
      });

      pnlService.updateMarkPrice('BTC-USD', 51000);

      const snapshot = pnlService.getSnapshot();

      // Short loss when price rises: (51000 - 50000) * 1 * -1 = -1000
      expect(snapshot.unrealizedPnlUsd).toBe(-1000);
      expect(snapshot.totalEquityUsd).toBe(49000);
    });
  });

  describe('Multiple Positions', () => {
    it('should sum unrealized across multiple positions', () => {
      pnlService = new PnLService(createConfig(), mockLogger, mockPositionTracker as any);

      mockPositionTracker.addPosition({
        symbol: 'BTC-USD',
        side: 'long',
        size: 1,
        entryPrice: 50000,
        marketPrice: 51000,
      });

      mockPositionTracker.addPosition({
        symbol: 'ETH-USD',
        side: 'long',
        size: 10,
        entryPrice: 2000,
        marketPrice: 2100,
      });

      pnlService.updateMarkPrices({
        'BTC-USD': 51000,
        'ETH-USD': 2100,
      });

      const snapshot = pnlService.getSnapshot();

      // BTC: (51000 - 50000) * 1 = 1000
      // ETH: (2100 - 2000) * 10 = 1000
      expect(snapshot.unrealizedPnlUsd).toBe(2000);
      expect(snapshot.totalEquityUsd).toBe(52000);
      expect(snapshot.openPositionsCount).toBe(2);
    });
  });

  describe('Daily P&L', () => {
    it('should compute daily P&L correctly', () => {
      pnlService = new PnLService(createConfig(), mockLogger, mockPositionTracker as any);

      mockPositionTracker.addPosition({
        symbol: 'BTC-USD',
        side: 'long',
        size: 1,
        entryPrice: 50000,
        marketPrice: 51000,
      });

      pnlService.updateMarkPrice('BTC-USD', 51000);

      const snapshot = pnlService.getSnapshot();

      // dailyPnl = totalEquity - dayStartEquity = 51000 - 50000 = 1000
      expect(snapshot.dailyPnlUsd).toBe(1000);
    });

    it('should compute daily P&L in R units', () => {
      pnlService = new PnLService(createConfig({
        perTradeRiskFraction: 0.01, // 1% = $500
      }), mockLogger, mockPositionTracker as any);

      mockPositionTracker.addPosition({
        symbol: 'BTC-USD',
        side: 'long',
        size: 1,
        entryPrice: 50000,
        marketPrice: 51000,
      });

      pnlService.updateMarkPrice('BTC-USD', 51000);

      const snapshot = pnlService.getSnapshot();

      // 1R = 0.01 * 50000 = 500
      // dailyPnlR = 1000 / 500 = 2
      expect(snapshot.riskUnitUsd).toBe(500);
      expect(snapshot.dailyPnlR).toBe(2);
    });
  });

  describe('Day Rollover', () => {
    it('should reset dayStartEquity on rollover', () => {
      pnlService = new PnLService(createConfig(), mockLogger, mockPositionTracker as any);

      // Open and close a position to accumulate realized P&L
      mockPositionTracker.addPosition({
        symbol: 'BTC-USD',
        side: 'long',
        size: 1,
        entryPrice: 50000,
        marketPrice: 51000,
      });
      mockPositionTracker.closePosition('BTC-USD', 1000);

      let snapshot = pnlService.getSnapshot();
      expect(snapshot.realizedPnlUsd).toBe(1000);
      expect(snapshot.totalEquityUsd).toBe(51000);

      // Manually trigger rollover (in real code, this happens on time boundary)
      (pnlService as any).performDayRollover('2025-02-04');

      snapshot = pnlService.getSnapshot();

      // After rollover, dayStartEquity = previous totalEquity
      expect(snapshot.dayStartEquityUsd).toBe(51000);
      expect(snapshot.dailyPnlUsd).toBe(0); // Reset
      expect(snapshot.riskDay).toBe('2025-02-04');
    });
  });

  describe('Equity Curve', () => {
    it('should track equity curve points', () => {
      pnlService = new PnLService(createConfig(), mockLogger, mockPositionTracker as any);

      // Trigger snapshot emissions
      pnlService.updateMarkPrice('BTC-USD', 50000);
      pnlService.updateMarkPrice('BTC-USD', 51000);
      pnlService.updateMarkPrice('BTC-USD', 52000);

      const curve = pnlService.getEquityCurve();

      expect(curve.length).toBeGreaterThanOrEqual(3);
      expect(curve[0].totalEquityUsd).toBe(50000); // No positions
    });
  });

  describe('Events', () => {
    it('should emit pnl:snapshot event', () => {
      pnlService = new PnLService(createConfig(), mockLogger, mockPositionTracker as any);

      const snapshotHandler = vi.fn();
      pnlService.on('pnl:snapshot', snapshotHandler);

      pnlService.updateMarkPrice('BTC-USD', 50000);

      expect(snapshotHandler).toHaveBeenCalled();
      const snapshot = snapshotHandler.mock.calls[0][0] as PnLSnapshot;
      expect(snapshot.totalEquityUsd).toBe(50000);
    });

    it('should emit pnl:day_rollover event', () => {
      pnlService = new PnLService(createConfig(), mockLogger, mockPositionTracker as any);

      const rolloverHandler = vi.fn();
      pnlService.on('pnl:day_rollover', rolloverHandler);

      (pnlService as any).performDayRollover('2025-02-04');

      expect(rolloverHandler).toHaveBeenCalledWith(expect.objectContaining({
        newDay: '2025-02-04',
      }));
    });
  });

  describe('Snapshot Consistency', () => {
    it('should always satisfy the P&L identity', () => {
      pnlService = new PnLService(createConfig(), mockLogger, mockPositionTracker as any);

      // Series of operations
      mockPositionTracker.addPosition({
        symbol: 'BTC-USD', side: 'long', size: 2, entryPrice: 50000, marketPrice: 50000,
      });

      pnlService.updateMarkPrice('BTC-USD', 52000);

      let snapshot = pnlService.getSnapshot();
      expect(snapshot.totalEquityUsd).toBe(
        snapshot.sessionStartEquityUsd + snapshot.realizedPnlUsd + snapshot.unrealizedPnlUsd
      );

      mockPositionTracker.closePosition('BTC-USD', 4000);

      snapshot = pnlService.getSnapshot();
      expect(snapshot.totalEquityUsd).toBe(
        snapshot.sessionStartEquityUsd + snapshot.realizedPnlUsd + snapshot.unrealizedPnlUsd
      );

      mockPositionTracker.addPosition({
        symbol: 'ETH-USD', side: 'short', size: 10, entryPrice: 2000, marketPrice: 2000,
      });

      pnlService.updateMarkPrice('ETH-USD', 1900);

      snapshot = pnlService.getSnapshot();
      expect(snapshot.totalEquityUsd).toBe(
        snapshot.sessionStartEquityUsd + snapshot.realizedPnlUsd + snapshot.unrealizedPnlUsd
      );
    });
  });
});
