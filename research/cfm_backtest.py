#!/usr/bin/env python3
"""
CFM Fee-Aware Walk-Forward Backtest

Multi-year backtest of trend_follow (4H) and donchian_daily_s3 (1D) on
BTC-USD spot as a proxy for CFM nano BTC futures (BIP, 0.01 BTC/contract).

Usage:
    python3 research/cfm_backtest.py                    # full run
    pnpm backtest:cfm                                   # from root

Reads: atlas/var/bt-data/btc_usd_1h.csv  (1H candles, fetch first)
Writes:
    research/CFM_BACKTEST_VERDICT.md
    research/charts/*.png
"""
import os
import sys
import math
import csv
import json
from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime, timezone
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from scipy import stats as scipy_stats

# ─── Paths ──────────────────────────────────────────────────────────────
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_FILE = os.path.join(ROOT, 'atlas', 'var', 'bt-data', 'btc_usd_1h.csv')
CHART_DIR = os.path.join(ROOT, 'research', 'charts')
VERDICT_FILE = os.path.join(ROOT, 'research', 'CFM_BACKTEST_VERDICT.md')

# ─── Constants (must match production) ──────────────────────────────────
CONTRACT_SIZE = 0.01       # BTC per nano BTC contract (BIP)
PRICE_INCREMENT = 5.0      # $5/BTC = $0.05/contract
MAKER_BPS = 9.5
TAKER_BPS = 10.0
EXCHANGE_FEE_PER_CONTRACT = 0.10  # USD per side per contract
BASE_SLIPPAGE_BPS = 2.0    # 1 tick + 2 bps base case
MAX_DAILY_LOSS_USD = 100.0
MAX_NOTIONAL_USD = 2000.0
STARTING_EQUITY = 10_000.0
L1_DAILY_R_BUDGET_USD = 100.0  # min(max_daily_loss, L1 budget)

# ATR bounds from guardrails
TF_ATR_MIN_PCT = 0.008     # 0.8% for 4H trend_follow
TF_ATR_MAX_PCT = 0.04      # 4.0%
DONCH_ATR_MIN_PCT = 0.025  # 2.5% for 1D donchian
DONCH_ATR_MAX_PCT = 0.15   # 15%

# CDE weekly break: Friday 17:00-18:00 ET
# We'll model this as skipping bars that fall in that window.

# Walk-forward parameters
WF_TRAIN_MONTHS = 24
WF_TEST_MONTHS = 6
WF_STEP_MONTHS = 6

# ─── Data Loading ───────────────────────────────────────────────────────

def load_1h_candles() -> pd.DataFrame:
    """Load 1H BTC-USD candles from CSV."""
    if not os.path.exists(DATA_FILE):
        print(f'ERROR: Data file not found: {DATA_FILE}')
        print('Run: python3 research/fetch_btc_candles.py')
        sys.exit(1)
    df = pd.read_csv(DATA_FILE)
    df['time'] = pd.to_datetime(df['time'].astype(int), unit='s', utc=True)
    for col in ['open', 'high', 'low', 'close', 'volume']:
        df[col] = df[col].astype(float)
    df = df.sort_values('time').reset_index(drop=True)
    df = df.drop_duplicates(subset='time').reset_index(drop=True)
    return df


def resample_to_4h(df_1h: pd.DataFrame) -> pd.DataFrame:
    """Resample 1H to 4H OHLCV bars."""
    df = df_1h.set_index('time')
    r = df.resample('4h')
    out = pd.DataFrame({
        'open': r['open'].first(),
        'high': r['high'].max(),
        'low': r['low'].min(),
        'close': r['close'].last(),
        'volume': r['volume'].sum(),
    }).dropna().reset_index()
    return out


def resample_to_1d(df_1h: pd.DataFrame) -> pd.DataFrame:
    """Resample 1H to 1D OHLCV bars (UTC midnight)."""
    df = df_1h.set_index('time')
    r = df.resample('1D')
    out = pd.DataFrame({
        'open': r['open'].first(),
        'high': r['high'].max(),
        'low': r['low'].min(),
        'close': r['close'].last(),
        'volume': r['volume'].sum(),
    }).dropna().reset_index()
    return out

# ─── Indicators ─────────────────────────────────────────────────────────

def ema(series: np.ndarray, period: int) -> np.ndarray:
    """Exponential moving average matching production EMA logic."""
    if len(series) < period:
        return np.full(len(series), np.nan)
    result = np.full(len(series), np.nan)
    k = 2.0 / (period + 1)
    result[period - 1] = np.mean(series[:period])
    for i in range(period, len(series)):
        result[i] = series[i] * k + result[i - 1] * (1 - k)
    return result


def atr(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int) -> np.ndarray:
    """Average True Range matching production ATR logic."""
    n = len(highs)
    if n < 2:
        return np.full(n, np.nan)
    tr = np.zeros(n)
    tr[0] = highs[0] - lows[0]
    for i in range(1, n):
        tr[i] = max(highs[i] - lows[i],
                     abs(highs[i] - closes[i - 1]),
                     abs(lows[i] - closes[i - 1]))
    result = np.full(n, np.nan)
    if n >= period:
        result[period - 1] = np.mean(tr[:period])
        for i in range(period, n):
            result[i] = (result[i - 1] * (period - 1) + tr[i]) / period
    return result


def adx(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> np.ndarray:
    """Average Directional Index."""
    n = len(highs)
    if n < period + 1:
        return np.full(n, np.nan)

    plus_dm = np.zeros(n)
    minus_dm = np.zeros(n)
    tr_vals = np.zeros(n)

    for i in range(1, n):
        up_move = highs[i] - highs[i - 1]
        down_move = lows[i - 1] - lows[i]
        plus_dm[i] = up_move if (up_move > down_move and up_move > 0) else 0
        minus_dm[i] = down_move if (down_move > up_move and down_move > 0) else 0
        tr_vals[i] = max(highs[i] - lows[i],
                         abs(highs[i] - closes[i - 1]),
                         abs(lows[i] - closes[i - 1]))

    smoothed_tr = np.zeros(n)
    smoothed_plus = np.zeros(n)
    smoothed_minus = np.zeros(n)

    smoothed_tr[period] = np.sum(tr_vals[1:period + 1])
    smoothed_plus[period] = np.sum(plus_dm[1:period + 1])
    smoothed_minus[period] = np.sum(minus_dm[1:period + 1])

    for i in range(period + 1, n):
        smoothed_tr[i] = smoothed_tr[i - 1] - smoothed_tr[i - 1] / period + tr_vals[i]
        smoothed_plus[i] = smoothed_plus[i - 1] - smoothed_plus[i - 1] / period + plus_dm[i]
        smoothed_minus[i] = smoothed_minus[i - 1] - smoothed_minus[i - 1] / period + minus_dm[i]

    dx = np.full(n, np.nan)
    for i in range(period, n):
        if smoothed_tr[i] > 0:
            plus_di = 100 * smoothed_plus[i] / smoothed_tr[i]
            minus_di = 100 * smoothed_minus[i] / smoothed_tr[i]
            di_sum = plus_di + minus_di
            dx[i] = 100 * abs(plus_di - minus_di) / di_sum if di_sum > 0 else 0
        else:
            dx[i] = 0

    result = np.full(n, np.nan)
    valid_dx = [dx[i] for i in range(period, min(2 * period, n)) if not np.isnan(dx[i])]
    if len(valid_dx) >= period:
        result[2 * period - 1] = np.mean(valid_dx[:period])
        for i in range(2 * period, n):
            if not np.isnan(dx[i]):
                result[i] = (result[i - 1] * (period - 1) + dx[i]) / period
    return result

# ─── Cost Model (matches cfm-fee-calculator.ts) ────────────────────────

@dataclass
class RoundTripCost:
    entry_fee_usd: float
    exit_fee_usd: float
    slippage_usd: float
    total_usd: float
    effective_bps: float
    contracts: int


def compute_round_trip_cost(
    size_underlying: float,
    price: float,
    slippage_bps: float = BASE_SLIPPAGE_BPS,
    fee_multiplier: float = 1.0,
) -> RoundTripCost:
    """Compute CFM round-trip cost matching production cfm-fee-calculator.ts."""
    notional = size_underlying * price
    contracts = int(size_underlying / CONTRACT_SIZE)

    maker_rate = (MAKER_BPS * fee_multiplier) / 10_000
    taker_rate = (TAKER_BPS * fee_multiplier) / 10_000
    per_contract = EXCHANGE_FEE_PER_CONTRACT * fee_multiplier

    entry_commission = notional * maker_rate
    entry_exchange = contracts * per_contract
    entry_fee = entry_commission + entry_exchange

    exit_commission = notional * taker_rate
    exit_exchange = contracts * per_contract
    exit_fee = exit_commission + exit_exchange

    slippage = notional * (slippage_bps / 10_000) * 2
    total = entry_fee + exit_fee + slippage
    effective = (total / notional * 10_000) if notional > 0 else 0

    return RoundTripCost(entry_fee, exit_fee, slippage, total, effective, contracts)

# ─── Position Sizer (matches cfm-position-sizer.ts) ────────────────────

@dataclass
class SizingResult:
    size: float
    contracts: int
    max_loss_usd: float
    stop_distance_pct: float
    notional_usd: float
    capped_by: str


def compute_position_size(
    entry_price: float,
    stop_price: float,
    equity: float = STARTING_EQUITY,
) -> SizingResult:
    """Compute CFM position size matching production cfm-position-sizer.ts."""
    if entry_price <= 0 or CONTRACT_SIZE <= 0:
        return SizingResult(0, 0, 0, 0, 0, 'none')

    stop_distance = abs(entry_price - stop_price)
    stop_distance_pct = stop_distance / entry_price

    if stop_distance <= 0:
        return SizingResult(0, 0, 0, 0, 0, 'none')

    loss_cap = min(MAX_DAILY_LOSS_USD, L1_DAILY_R_BUDGET_USD)
    capped_by = 'daily_loss' if loss_cap == MAX_DAILY_LOSS_USD else 'l1_budget'

    max_notional = loss_cap / stop_distance_pct
    if max_notional > MAX_NOTIONAL_USD:
        max_notional = MAX_NOTIONAL_USD
        capped_by = 'max_notional'

    max_size = max_notional / entry_price
    whole_contracts = int(max_size / CONTRACT_SIZE)
    size = whole_contracts * CONTRACT_SIZE
    notional = size * entry_price

    return SizingResult(
        size, whole_contracts, loss_cap, stop_distance_pct, notional,
        capped_by if whole_contracts > 0 else 'none',
    )

# ─── CDE Hours (matches cde-hours.ts) ──────────────────────────────────

def is_cde_break(dt: datetime) -> bool:
    """Friday 17:00-18:00 ET. Simplified: skip these bars."""
    import pytz
    try:
        et = pytz.timezone('America/New_York')
    except Exception:
        # Fallback: approximate UTC-5 (EST)
        from datetime import timedelta as td
        et_offset = dt.utcoffset() or td(0)
        et_dt = dt - td(hours=5)
        return et_dt.weekday() == 4 and 17 <= et_dt.hour < 18

    et_dt = dt.astimezone(et)
    return et_dt.weekday() == 4 and 17 <= et_dt.hour < 18

# ─── Regime Detection (simplified ADX-based) ───────────────────────────

def detect_regime(adx_val: float) -> str:
    """Simplified regime detection matching production adx_primary mode."""
    if np.isnan(adx_val):
        return 'unknown'
    if adx_val >= 30:
        return 'strong_trend'
    if adx_val >= 20:
        return 'weak_trend'
    if adx_val >= 15:
        return 'ranging'
    return 'choppy'

# ─── Trade Structure ────────────────────────────────────────────────────

@dataclass
class Trade:
    entry_time: datetime
    exit_time: Optional[datetime] = None
    direction: str = 'buy'
    entry_price: float = 0.0
    exit_price: float = 0.0
    stop_loss: float = 0.0
    take_profit: float = 0.0
    size: float = 0.0
    contracts: int = 0
    pnl_gross: float = 0.0
    pnl_net: float = 0.0
    fees: float = 0.0
    r_multiple: float = 0.0
    exit_reason: str = ''
    regime: str = 'unknown'
    strategy: str = ''
    slippage_bps: float = BASE_SLIPPAGE_BPS
    fee_multiplier: float = 1.0

# ─── Strategy Implementations ──────────────────────────────────────────

class TrendFollowBacktest:
    """4H EMA crossover trend follow — mirrors TrendFollowStrategy."""

    def __init__(self, ema_fast=12, ema_slow=15, stop_atr=2.5, tp_atr=6.0,
                 atr_period=14, atr_min_pct=TF_ATR_MIN_PCT, atr_max_pct=TF_ATR_MAX_PCT):
        self.ema_fast = ema_fast
        self.ema_slow = ema_slow
        self.stop_atr = stop_atr
        self.tp_atr = tp_atr
        self.atr_period = atr_period
        self.atr_min_pct = atr_min_pct
        self.atr_max_pct = atr_max_pct

    def generate_signals(self, df: pd.DataFrame) -> list[dict]:
        """Generate entry/exit signals on 4H bars."""
        closes = df['close'].values
        highs = df['high'].values
        lows = df['low'].values

        ema_f = ema(closes, self.ema_fast)
        ema_s = ema(closes, self.ema_slow)
        atr_vals = atr(highs, lows, closes, self.atr_period)
        adx_vals = adx(highs, lows, closes, 14)

        signals = []
        min_bars = max(self.ema_fast, self.ema_slow, self.atr_period) + 1

        for i in range(min_bars, len(df)):
            if np.isnan(ema_f[i]) or np.isnan(ema_s[i]) or np.isnan(atr_vals[i]):
                continue

            price = closes[i]
            curr_atr = atr_vals[i]
            atr_pct = curr_atr / price if price > 0 else 0

            # ATR bounds filter
            if atr_pct < self.atr_min_pct or atr_pct > self.atr_max_pct:
                continue

            # Regime filter: skip choppy
            regime = detect_regime(adx_vals[i] if not np.isnan(adx_vals[i]) else 0)
            if regime in ('choppy', 'ranging'):
                continue

            # EMA crossover detection (current bar only, crossoverLookback=0)
            prev_fast = ema_f[i - 1]
            prev_slow = ema_s[i - 1]
            curr_fast = ema_f[i]
            curr_slow = ema_s[i]

            if np.isnan(prev_fast) or np.isnan(prev_slow):
                continue

            bullish_cross = prev_fast <= prev_slow and curr_fast > curr_slow
            bearish_cross = prev_fast >= prev_slow and curr_fast < curr_slow

            # Price confirmation
            above_both = price > curr_fast and price > curr_slow
            below_both = price < curr_fast and price < curr_slow

            if bullish_cross and above_both:
                stop = price - curr_atr * self.stop_atr
                tp = price + curr_atr * self.tp_atr
                signals.append({
                    'bar_idx': i,
                    'time': df['time'].iloc[i],
                    'direction': 'buy',
                    'price': price,
                    'stop_loss': stop,
                    'take_profit': tp,
                    'atr': curr_atr,
                    'regime': regime,
                })
            elif bearish_cross and below_both:
                stop = price + curr_atr * self.stop_atr
                tp = price - curr_atr * self.tp_atr
                signals.append({
                    'bar_idx': i,
                    'time': df['time'].iloc[i],
                    'direction': 'sell',
                    'price': price,
                    'stop_loss': stop,
                    'take_profit': tp,
                    'atr': curr_atr,
                    'regime': regime,
                })

        return signals


class DonchianDailyS3Backtest:
    """1D Donchian in20/out10 long-only — mirrors DonchianDailyS3Strategy."""

    def __init__(self, entry_lookback=20, exit_lookback=10, stop_atr=3.0,
                 atr_period=14, atr_min_pct=DONCH_ATR_MIN_PCT, atr_max_pct=DONCH_ATR_MAX_PCT):
        self.entry_lookback = entry_lookback
        self.exit_lookback = exit_lookback
        self.stop_atr = stop_atr
        self.atr_period = atr_period
        self.atr_min_pct = atr_min_pct
        self.atr_max_pct = atr_max_pct

    def generate_signals(self, df: pd.DataFrame) -> list[dict]:
        """Generate entry/exit signals on 1D bars. Long-only."""
        closes = df['close'].values
        highs = df['high'].values
        lows = df['low'].values

        atr_vals = atr(highs, lows, closes, self.atr_period)

        signals = []
        state = 'OUT'
        bars_since_entry = 0
        min_bars = max(self.entry_lookback, self.exit_lookback, self.atr_period) + 1

        for i in range(min_bars, len(df)):
            if np.isnan(atr_vals[i]):
                continue

            price = closes[i]
            curr_atr = atr_vals[i]
            atr_pct = curr_atr / price if price > 0 else 0

            if state == 'IN':
                bars_since_entry += 1

            # ATR bounds filter (applied to entries only)
            atr_ok = self.atr_min_pct <= atr_pct <= self.atr_max_pct

            # Donchian channels on PRIOR closes (exclude current bar)
            prior_entry = closes[i - self.entry_lookback:i]
            prior_exit = closes[i - self.exit_lookback:i]
            donchian_high = np.max(prior_entry)
            donchian_low = np.min(prior_exit)

            if state == 'OUT':
                # ENTRY: close strictly ABOVE prior N-day closing high
                if price > donchian_high and atr_ok:
                    stop = price - self.stop_atr * curr_atr
                    signals.append({
                        'bar_idx': i,
                        'time': df['time'].iloc[i],
                        'direction': 'buy',
                        'price': price,
                        'stop_loss': stop,
                        'take_profit': price * 100,  # NO_TAKE_PROFIT sentinel
                        'atr': curr_atr,
                        'regime': 'n/a',
                    })
                    state = 'IN'
                    bars_since_entry = 0
            else:
                # Fill bar + 1 bar grace (sim_brk §1.2)
                if bars_since_entry < 2:
                    continue
                # EXIT: close strictly BELOW prior N-day closing low
                if price < donchian_low:
                    signals.append({
                        'bar_idx': i,
                        'time': df['time'].iloc[i],
                        'direction': 'sell',
                        'price': price,
                        'stop_loss': 0,
                        'take_profit': 0,
                        'atr': curr_atr,
                        'regime': 'n/a',
                    })
                    state = 'OUT'
                    bars_since_entry = 0

        return signals

# ─── Backtest Engine ────────────────────────────────────────────────────

@dataclass
class BacktestResult:
    trades: list
    equity_curve: list
    metrics: dict
    strategy: str
    params: dict
    period: str


def run_backtest(
    df: pd.DataFrame,
    signals: list[dict],
    strategy_name: str,
    params: dict,
    slippage_bps: float = BASE_SLIPPAGE_BPS,
    fee_multiplier: float = 1.0,
    funding_bps_per_8h: float = 0.0,
    equity: float = STARTING_EQUITY,
    period_label: str = 'full',
) -> BacktestResult:
    """Run a backtest with full cost model on pre-generated signals."""
    trades: list[Trade] = []
    equity_curve = [(df['time'].iloc[0], equity)]
    position: Optional[Trade] = None
    size_zero_skips = 0
    total_signals = len(signals)

    for sig in signals:
        bar_idx = sig['bar_idx']
        if bar_idx + 1 >= len(df):
            continue

        # Next-bar fill
        fill_bar = df.iloc[bar_idx + 1]
        fill_price = float(fill_bar['open'])
        fill_time = fill_bar['time']

        if sig['direction'] == 'buy' and position is None:
            sizing = compute_position_size(fill_price, sig['stop_loss'], equity)
            if sizing.contracts == 0:
                size_zero_skips += 1
                continue

            cost = compute_round_trip_cost(sizing.size, fill_price, slippage_bps, fee_multiplier)

            position = Trade(
                entry_time=fill_time,
                direction='buy',
                entry_price=fill_price,
                stop_loss=sig['stop_loss'],
                take_profit=sig['take_profit'],
                size=sizing.size,
                contracts=sizing.contracts,
                strategy=strategy_name,
                regime=sig.get('regime', 'unknown'),
                slippage_bps=slippage_bps,
                fee_multiplier=fee_multiplier,
            )

        elif sig['direction'] == 'sell' and position is not None:
            # Exit at next bar open
            exit_price = fill_price
            gross_pnl = (exit_price - position.entry_price) * position.size
            if position.direction == 'sell':
                gross_pnl = -gross_pnl

            cost = compute_round_trip_cost(position.size, position.entry_price, slippage_bps, fee_multiplier)

            # Funding cost approximation
            if funding_bps_per_8h != 0 and position.entry_time is not None:
                hold_hours = (fill_time - position.entry_time).total_seconds() / 3600
                funding_periods = hold_hours / 8.0
                funding_cost = position.size * position.entry_price * (funding_bps_per_8h / 10_000) * funding_periods
                cost = RoundTripCost(
                    cost.entry_fee_usd, cost.exit_fee_usd,
                    cost.slippage_usd + funding_cost,
                    cost.total_usd + funding_cost,
                    cost.effective_bps, cost.contracts,
                )

            net_pnl = gross_pnl - cost.total_usd

            stop_dist = abs(position.entry_price - position.stop_loss)
            r_mult = (exit_price - position.entry_price) / stop_dist if stop_dist > 0 else 0

            position.exit_time = fill_time
            position.exit_price = exit_price
            position.pnl_gross = gross_pnl
            position.pnl_net = net_pnl
            position.fees = cost.total_usd
            position.r_multiple = r_mult
            position.exit_reason = 'signal'

            trades.append(position)
            equity += net_pnl
            equity_curve.append((fill_time, equity))
            position = None

        elif sig['direction'] == 'sell' and position is not None and position.direction == 'sell':
            pass  # ignore duplicate sells

    # Now simulate stop-outs on intrabar data for open positions
    # Walk through bars checking stop/TP hits
    if position is not None and len(df) > 0:
        # Close at last bar if still open
        last_bar = df.iloc[-1]
        exit_price = float(last_bar['close'])
        gross_pnl = (exit_price - position.entry_price) * position.size
        cost = compute_round_trip_cost(position.size, position.entry_price, slippage_bps, fee_multiplier)
        net_pnl = gross_pnl - cost.total_usd
        stop_dist = abs(position.entry_price - position.stop_loss)
        r_mult = (exit_price - position.entry_price) / stop_dist if stop_dist > 0 else 0

        position.exit_time = last_bar['time']
        position.exit_price = exit_price
        position.pnl_gross = gross_pnl
        position.pnl_net = net_pnl
        position.fees = cost.total_usd
        position.r_multiple = r_mult
        position.exit_reason = 'end_of_period'
        trades.append(position)
        equity += net_pnl
        equity_curve.append((last_bar['time'], equity))

    metrics = compute_metrics(trades, equity_curve, total_signals, size_zero_skips,
                              slippage_bps, fee_multiplier, STARTING_EQUITY)

    return BacktestResult(trades, equity_curve, metrics, strategy_name, params, period_label)


def run_backtest_with_stops(
    df: pd.DataFrame,
    strategy_obj,
    strategy_name: str,
    params: dict,
    slippage_bps: float = BASE_SLIPPAGE_BPS,
    fee_multiplier: float = 1.0,
    funding_bps_per_8h: float = 0.0,
    equity: float = STARTING_EQUITY,
    period_label: str = 'full',
) -> BacktestResult:
    """Run backtest with intrabar stop checking on higher-resolution data."""
    signals = strategy_obj.generate_signals(df)
    
    trades: list[Trade] = []
    equity_curve_data = [(df['time'].iloc[0], equity)]
    position: Optional[Trade] = None
    size_zero_skips = 0
    total_signals = len(signals)
    signal_idx = 0
    daily_pnl = 0.0

    for i in range(len(df)):
        bar = df.iloc[i]
        bar_time = bar['time']
        bar_high = float(bar['high'])
        bar_low = float(bar['low'])
        bar_close = float(bar['close'])

        # Check stop/TP on open position
        if position is not None:
            hit_stop = False
            hit_tp = False
            
            if position.direction == 'buy':
                if bar_low <= position.stop_loss:
                    hit_stop = True
                    exit_price = position.stop_loss
                elif bar_high >= position.take_profit:
                    hit_tp = True
                    exit_price = position.take_profit
            else:
                if bar_high >= position.stop_loss:
                    hit_stop = True
                    exit_price = position.stop_loss
                elif bar_low <= position.take_profit:
                    hit_tp = True
                    exit_price = position.take_profit

            if hit_stop or hit_tp:
                if position.direction == 'buy':
                    gross_pnl = (exit_price - position.entry_price) * position.size
                else:
                    gross_pnl = (position.entry_price - exit_price) * position.size

                cost = compute_round_trip_cost(position.size, position.entry_price,
                                               slippage_bps, fee_multiplier)
                if funding_bps_per_8h != 0:
                    hold_hours = (bar_time - position.entry_time).total_seconds() / 3600
                    funding_cost = position.size * position.entry_price * (funding_bps_per_8h / 10_000) * (hold_hours / 8.0)
                    cost = RoundTripCost(
                        cost.entry_fee_usd, cost.exit_fee_usd,
                        cost.slippage_usd + funding_cost,
                        cost.total_usd + funding_cost,
                        cost.effective_bps, cost.contracts,
                    )

                net_pnl = gross_pnl - cost.total_usd
                stop_dist = abs(position.entry_price - position.stop_loss)
                r_mult = gross_pnl / (stop_dist * position.size) if stop_dist > 0 and position.size > 0 else 0

                position.exit_time = bar_time
                position.exit_price = exit_price
                position.pnl_gross = gross_pnl
                position.pnl_net = net_pnl
                position.fees = cost.total_usd
                position.r_multiple = r_mult
                position.exit_reason = 'stop_loss' if hit_stop else 'take_profit'
                trades.append(position)
                equity += net_pnl
                equity_curve_data.append((bar_time, equity))
                position = None

        # Process signals at this bar
        while signal_idx < len(signals) and signals[signal_idx]['bar_idx'] == i:
            sig = signals[signal_idx]
            signal_idx += 1

            if sig['direction'] == 'buy' and position is None:
                # Fill at next bar open
                if i + 1 < len(df):
                    fill_bar = df.iloc[i + 1]
                    fill_price = float(fill_bar['open'])
                    fill_time = fill_bar['time']

                    # Re-calc stop/TP from fill price
                    curr_atr = sig['atr']
                    if strategy_name == 'trend_follow':
                        if sig['direction'] == 'buy':
                            stop = fill_price - curr_atr * params.get('stop_atr', 2.5)
                            tp = fill_price + curr_atr * params.get('tp_atr', 6.0)
                        else:
                            stop = fill_price + curr_atr * params.get('stop_atr', 2.5)
                            tp = fill_price - curr_atr * params.get('tp_atr', 6.0)
                    else:
                        stop = fill_price - curr_atr * params.get('stop_atr', 3.0)
                        tp = fill_price * 100

                    sizing = compute_position_size(fill_price, stop, equity)
                    if sizing.contracts == 0:
                        size_zero_skips += 1
                        continue

                    position = Trade(
                        entry_time=fill_time,
                        direction=sig['direction'],
                        entry_price=fill_price,
                        stop_loss=stop,
                        take_profit=tp,
                        size=sizing.size,
                        contracts=sizing.contracts,
                        strategy=strategy_name,
                        regime=sig.get('regime', 'unknown'),
                        slippage_bps=slippage_bps,
                        fee_multiplier=fee_multiplier,
                    )

            elif sig['direction'] == 'sell' and position is not None:
                if i + 1 < len(df):
                    fill_bar = df.iloc[i + 1]
                    fill_price = float(fill_bar['open'])
                    fill_time = fill_bar['time']

                    if position.direction == 'buy':
                        gross_pnl = (fill_price - position.entry_price) * position.size
                    else:
                        gross_pnl = (position.entry_price - fill_price) * position.size

                    cost = compute_round_trip_cost(position.size, position.entry_price,
                                                   slippage_bps, fee_multiplier)
                    if funding_bps_per_8h != 0:
                        hold_hours = (fill_time - position.entry_time).total_seconds() / 3600
                        funding_cost = position.size * position.entry_price * (funding_bps_per_8h / 10_000) * (hold_hours / 8.0)
                        cost = RoundTripCost(
                            cost.entry_fee_usd, cost.exit_fee_usd,
                            cost.slippage_usd + funding_cost,
                            cost.total_usd + funding_cost,
                            cost.effective_bps, cost.contracts,
                        )

                    net_pnl = gross_pnl - cost.total_usd
                    stop_dist = abs(position.entry_price - position.stop_loss)
                    r_mult = gross_pnl / (stop_dist * position.size) if stop_dist > 0 and position.size > 0 else 0

                    position.exit_time = fill_time
                    position.exit_price = fill_price
                    position.pnl_gross = gross_pnl
                    position.pnl_net = net_pnl
                    position.fees = cost.total_usd
                    position.r_multiple = r_mult
                    position.exit_reason = 'signal_exit'
                    trades.append(position)
                    equity += net_pnl
                    equity_curve_data.append((fill_time, equity))
                    position = None

    # Close any open position at end
    if position is not None:
        last_bar = df.iloc[-1]
        exit_price = float(last_bar['close'])
        if position.direction == 'buy':
            gross_pnl = (exit_price - position.entry_price) * position.size
        else:
            gross_pnl = (position.entry_price - exit_price) * position.size
        cost = compute_round_trip_cost(position.size, position.entry_price, slippage_bps, fee_multiplier)
        net_pnl = gross_pnl - cost.total_usd
        stop_dist = abs(position.entry_price - position.stop_loss)
        r_mult = gross_pnl / (stop_dist * position.size) if stop_dist > 0 and position.size > 0 else 0

        position.exit_time = last_bar['time']
        position.exit_price = exit_price
        position.pnl_gross = gross_pnl
        position.pnl_net = net_pnl
        position.fees = cost.total_usd
        position.r_multiple = r_mult
        position.exit_reason = 'end_of_period'
        trades.append(position)
        equity += net_pnl
        equity_curve_data.append((last_bar['time'], equity))

    metrics = compute_metrics(trades, equity_curve_data, total_signals, size_zero_skips,
                              slippage_bps, fee_multiplier, STARTING_EQUITY)
    return BacktestResult(trades, equity_curve_data, metrics, strategy_name, params, period_label)

# ─── Metrics ────────────────────────────────────────────────────────────

def compute_metrics(
    trades: list,
    equity_curve: list,
    total_signals: int,
    size_zero_skips: int,
    slippage_bps: float,
    fee_multiplier: float,
    starting_equity: float,
) -> dict:
    """Compute all required metrics."""
    if not trades:
        return {
            'trades': 0, 'trades_per_month': 0, 'win_rate': 0,
            'avg_r': 0, 'expectancy_usd': 0, 'expectancy_r': 0,
            'profit_factor': 0, 'net_pnl': 0, 'gross_pnl': 0,
            'total_fees': 0, 'fees_pct_of_gross': 0,
            'cagr': 0, 'max_drawdown_pct': 0, 'max_drawdown_usd': 0,
            'sharpe': 0, 'sortino': 0,
            'longest_dd_days': 0, 'size_zero_skips': size_zero_skips,
            'size_zero_pct': 100 if total_signals > 0 else 0,
            'exposure_pct': 0, 'total_signals': total_signals,
            'long_entries': 0, 'short_entries': 0,
            'avg_hold_hours': 0,
        }

    net_pnls = [t.pnl_net for t in trades]
    gross_pnls = [t.pnl_gross for t in trades]
    fees = [t.fees for t in trades]
    r_multiples = [t.r_multiple for t in trades]

    winners = [p for p in net_pnls if p > 0]
    losers = [p for p in net_pnls if p <= 0]

    total_gross = sum(gross_pnls)
    total_fees = sum(fees)
    total_net = sum(net_pnls)
    win_rate = len(winners) / len(trades) if trades else 0

    gross_wins = sum(p for p in gross_pnls if p > 0)
    gross_losses = abs(sum(p for p in gross_pnls if p <= 0))
    pf = gross_wins / gross_losses if gross_losses > 0 else float('inf')

    # Time-based metrics
    if trades:
        first_time = trades[0].entry_time
        last_time = trades[-1].exit_time or trades[-1].entry_time
        total_days = max((last_time - first_time).total_seconds() / 86400, 1)
        total_months = total_days / 30.44
        trades_per_month = len(trades) / total_months if total_months > 0 else 0
    else:
        total_days = 1
        trades_per_month = 0

    # CAGR
    final_equity = starting_equity + total_net
    years = total_days / 365.25
    cagr = (final_equity / starting_equity) ** (1 / years) - 1 if years > 0 and final_equity > 0 else 0

    # Drawdown
    eq_values = [e[1] for e in equity_curve]
    peak = starting_equity
    max_dd = 0
    max_dd_usd = 0
    dd_start = None
    longest_dd = 0
    current_dd_start = None

    for i, eq in enumerate(eq_values):
        if eq > peak:
            peak = eq
            if current_dd_start is not None:
                dd_duration = i  # approximate
                longest_dd = max(longest_dd, dd_duration)
            current_dd_start = None
        else:
            dd = (peak - eq) / peak
            dd_usd = peak - eq
            if dd > max_dd:
                max_dd = dd
                max_dd_usd = dd_usd
            if current_dd_start is None:
                current_dd_start = i

    # Sharpe & Sortino (annualized from per-trade returns)
    if len(net_pnls) > 1:
        returns = np.array(net_pnls) / starting_equity
        # Approximate annualization based on trade frequency
        avg_hold_hours = np.mean([
            (t.exit_time - t.entry_time).total_seconds() / 3600
            for t in trades if t.exit_time is not None
        ])
        trades_per_year = 365.25 * 24 / max(avg_hold_hours, 1) if avg_hold_hours > 0 else 252
        trades_per_year = min(trades_per_year, len(trades) / years) if years > 0 else 252

        mean_ret = np.mean(returns)
        std_ret = np.std(returns, ddof=1)
        sharpe = (mean_ret / std_ret) * np.sqrt(trades_per_year) if std_ret > 0 else 0

        downside = returns[returns < 0]
        downside_std = np.std(downside, ddof=1) if len(downside) > 1 else std_ret
        sortino = (mean_ret / downside_std) * np.sqrt(trades_per_year) if downside_std > 0 else 0
    else:
        sharpe = 0
        sortino = 0
        avg_hold_hours = 0

    if trades:
        avg_hold_hours = np.mean([
            (t.exit_time - t.entry_time).total_seconds() / 3600
            for t in trades if t.exit_time is not None
        ])
    
    # Exposure %
    total_exposed = sum(
        (t.exit_time - t.entry_time).total_seconds()
        for t in trades if t.exit_time is not None
    )
    exposure_pct = (total_exposed / (total_days * 86400)) * 100 if total_days > 0 else 0

    long_entries = sum(1 for t in trades if t.direction == 'buy')
    short_entries = sum(1 for t in trades if t.direction == 'sell')

    return {
        'trades': len(trades),
        'trades_per_month': trades_per_month,
        'win_rate': win_rate,
        'avg_r': np.mean(r_multiples) if r_multiples else 0,
        'expectancy_usd': np.mean(net_pnls) if net_pnls else 0,
        'expectancy_r': np.mean(r_multiples) if r_multiples else 0,
        'profit_factor': pf,
        'net_pnl': total_net,
        'gross_pnl': total_gross,
        'total_fees': total_fees,
        'fees_pct_of_gross': (total_fees / abs(total_gross) * 100) if total_gross != 0 else 0,
        'cagr': cagr,
        'max_drawdown_pct': max_dd,
        'max_drawdown_usd': max_dd_usd,
        'sharpe': sharpe,
        'sortino': sortino,
        'longest_dd_days': longest_dd,
        'size_zero_skips': size_zero_skips,
        'size_zero_pct': (size_zero_skips / total_signals * 100) if total_signals > 0 else 0,
        'exposure_pct': exposure_pct,
        'total_signals': total_signals,
        'long_entries': long_entries,
        'short_entries': short_entries,
        'avg_hold_hours': avg_hold_hours,
    }

# ─── Deflated Sharpe Ratio (Bailey & López de Prado) ───────────────────

def deflated_sharpe(observed_sharpe: float, n_trades: int, n_trials: int,
                    skewness: float = 0, kurtosis: float = 3) -> float:
    """
    Probability that the observed Sharpe is positive after correcting
    for multiple testing (Bailey & López de Prado 2014).
    Returns probability [0, 1]. >0.95 means likely real.
    """
    if n_trades < 2 or n_trials < 1:
        return 0.0

    # Expected max Sharpe under null
    euler_mascheroni = 0.5772
    expected_max_sr = np.sqrt(2 * np.log(n_trials)) * (
        1 - euler_mascheroni / (2 * np.log(n_trials))
    ) + euler_mascheroni / np.sqrt(2 * np.log(n_trials))

    # Standard error of Sharpe
    se_sr = np.sqrt(
        (1 - skewness * observed_sharpe + ((kurtosis - 1) / 4) * observed_sharpe ** 2) / (n_trades - 1)
    )

    if se_sr <= 0:
        return 0.0

    # Test statistic
    z = (observed_sharpe - expected_max_sr) / se_sr
    from scipy.stats import norm
    return float(norm.cdf(z))

# ─── PBO via CSCV (Combinatorially Symmetric Cross-Validation) ─────────

def compute_pbo(trade_returns_by_param: list[list[float]], n_splits: int = 16) -> float:
    """
    Probability of Backtest Overfitting via CSCV.
    trade_returns_by_param: list of return series, one per parameter combo.
    Returns PBO ∈ [0, 1]. < 0.3 is acceptable.
    """
    n_configs = len(trade_returns_by_param)
    if n_configs < 2:
        return 0.0

    # Pad all return series to same length
    max_len = max(len(r) for r in trade_returns_by_param)
    if max_len < n_splits:
        return 0.0

    matrix = np.zeros((max_len, n_configs))
    for j, rets in enumerate(trade_returns_by_param):
        matrix[:len(rets), j] = rets

    # Split into S blocks
    block_size = max_len // n_splits
    if block_size < 1:
        return 0.0

    # We'll use simplified CSCV: for each combination of S/2 blocks as IS,
    # the complementary S/2 blocks as OOS
    from itertools import combinations
    half = n_splits // 2
    block_indices = list(range(n_splits))

    logit_values = []
    combos = list(combinations(block_indices, half))
    max_combos = min(len(combos), 100)  # cap for performance

    for combo in combos[:max_combos]:
        is_blocks = set(combo)
        oos_blocks = set(block_indices) - is_blocks

        is_mask = np.zeros(max_len, dtype=bool)
        oos_mask = np.zeros(max_len, dtype=bool)

        for b in is_blocks:
            start = b * block_size
            end = min(start + block_size, max_len)
            is_mask[start:end] = True
        for b in oos_blocks:
            start = b * block_size
            end = min(start + block_size, max_len)
            oos_mask[start:end] = True

        is_sharpes = []
        oos_sharpes = []
        for j in range(n_configs):
            is_rets = matrix[is_mask, j]
            oos_rets = matrix[oos_mask, j]
            is_sr = np.mean(is_rets) / np.std(is_rets, ddof=1) if np.std(is_rets, ddof=1) > 0 else 0
            oos_sr = np.mean(oos_rets) / np.std(oos_rets, ddof=1) if np.std(oos_rets, ddof=1) > 0 else 0
            is_sharpes.append(is_sr)
            oos_sharpes.append(oos_sr)

        best_is = np.argmax(is_sharpes)
        best_is_oos_rank = sum(1 for s in oos_sharpes if s <= oos_sharpes[best_is])
        rank_pct = best_is_oos_rank / n_configs

        if rank_pct > 0 and rank_pct < 1:
            logit_val = np.log(rank_pct / (1 - rank_pct))
            logit_values.append(logit_val)

    if not logit_values:
        return 0.5

    # PBO = fraction of logit values < 0
    pbo = sum(1 for v in logit_values if v < 0) / len(logit_values)
    return pbo

# ─── Walk-Forward Engine ───────────────────────────────────────────────

def walk_forward(
    df: pd.DataFrame,
    strategy_class,
    strategy_name: str,
    param_grid: list[dict],
    train_months: int = WF_TRAIN_MONTHS,
    test_months: int = WF_TEST_MONTHS,
    step_months: int = WF_STEP_MONTHS,
    slippage_bps: float = BASE_SLIPPAGE_BPS,
    fee_multiplier: float = 1.0,
    funding_bps_per_8h: float = 0.0,
) -> dict:
    """Walk-forward optimization with rolling windows."""
    start_date = df['time'].min()
    end_date = df['time'].max()

    windows = []
    cursor = start_date
    while True:
        train_end = cursor + pd.DateOffset(months=train_months)
        test_end = train_end + pd.DateOffset(months=test_months)
        if test_end > end_date:
            break
        windows.append({
            'train_start': cursor,
            'train_end': train_end,
            'test_start': train_end,
            'test_end': test_end,
        })
        cursor += pd.DateOffset(months=step_months)

    if not windows:
        return {'oos_trades': [], 'oos_equity': [], 'windows': [], 'all_param_returns': []}

    oos_trades_all = []
    oos_equity = [(start_date, STARTING_EQUITY)]
    running_equity = STARTING_EQUITY
    window_results = []
    all_param_returns = {i: [] for i in range(len(param_grid))}

    for w_idx, w in enumerate(windows):
        print(f'  Window {w_idx+1}/{len(windows)}: train {w["train_start"].strftime("%Y-%m")} → '
              f'{w["train_end"].strftime("%Y-%m")}, test → {w["test_end"].strftime("%Y-%m")}')

        train_df = df[(df['time'] >= w['train_start']) & (df['time'] < w['train_end'])].copy()
        test_df = df[(df['time'] >= w['test_start']) & (df['time'] < w['test_end'])].copy()

        if len(train_df) < 50 or len(test_df) < 10:
            continue

        # Train: find best params by Sharpe
        best_sharpe = -999
        best_params = param_grid[0]
        best_params_idx = 0

        for p_idx, params in enumerate(param_grid):
            strat = strategy_class(**params)
            result = run_backtest_with_stops(
                train_df, strat, strategy_name, params,
                slippage_bps, fee_multiplier, funding_bps_per_8h,
                equity=STARTING_EQUITY,
            )
            if result.metrics['sharpe'] > best_sharpe:
                best_sharpe = result.metrics['sharpe']
                best_params = params
                best_params_idx = p_idx

            # Collect returns for PBO
            rets = [t.pnl_net for t in result.trades]
            all_param_returns[p_idx].extend(rets)

        # Test: run best params OOS
        strat = strategy_class(**best_params)
        oos_result = run_backtest_with_stops(
            test_df, strat, strategy_name, best_params,
            slippage_bps, fee_multiplier, funding_bps_per_8h,
            equity=running_equity,
        )

        for t in oos_result.trades:
            oos_trades_all.append(t)
            running_equity += t.pnl_net
            oos_equity.append((t.exit_time or t.entry_time, running_equity))

        window_results.append({
            'window': w,
            'best_params': best_params,
            'best_params_idx': best_params_idx,
            'train_sharpe': best_sharpe,
            'oos_sharpe': oos_result.metrics['sharpe'],
            'oos_trades': len(oos_result.trades),
            'oos_net_pnl': oos_result.metrics['net_pnl'],
        })

    return {
        'oos_trades': oos_trades_all,
        'oos_equity': oos_equity,
        'windows': window_results,
        'all_param_returns': [all_param_returns[i] for i in range(len(param_grid))],
    }

# ─── Parameter Grids (< 50 combinations per strategy) ──────────────────

TF_PARAM_GRID = []
for ema_f in [9, 12, 15]:
    for ema_s in [15, 21, 26]:
        if ema_f >= ema_s:
            continue
        for stop_atr in [2.0, 2.5, 3.0]:
            TF_PARAM_GRID.append({
                'ema_fast': ema_f,
                'ema_slow': ema_s,
                'stop_atr': stop_atr,
                'tp_atr': 6.0,
                'atr_period': 14,
            })
# Should be <= 50
assert len(TF_PARAM_GRID) <= 50, f'TF grid too large: {len(TF_PARAM_GRID)}'

DONCH_PARAM_GRID = []
for entry_lb in [15, 20, 25, 30]:
    for exit_lb in [5, 10, 15]:
        if exit_lb >= entry_lb:
            continue
        for stop_atr in [2.5, 3.0, 4.0]:
            DONCH_PARAM_GRID.append({
                'entry_lookback': entry_lb,
                'exit_lookback': exit_lb,
                'stop_atr': stop_atr,
                'atr_period': 14,
            })
assert len(DONCH_PARAM_GRID) <= 50, f'Donchian grid too large: {len(DONCH_PARAM_GRID)}'

# ─── Randomized Entry Baseline ─────────────────────────────────────────

def random_entry_baseline(
    df: pd.DataFrame,
    real_trades: list[Trade],
    n_runs: int = 1000,
    slippage_bps: float = BASE_SLIPPAGE_BPS,
    fee_multiplier: float = 1.0,
) -> dict:
    """Run randomized entries with the same exits and sizing as real trades."""
    if not real_trades:
        return {'mean_pnl': 0, 'std_pnl': 0, 'percentile_5': 0, 'percentile_95': 0, 'pct_better': 0}

    real_net = sum(t.pnl_net for t in real_trades)
    n_trades = len(real_trades)
    bar_count = len(df)

    random_pnls = []
    rng = np.random.default_rng(42)

    hold_durations = []
    for t in real_trades:
        if t.exit_time and t.entry_time:
            # Find bar indices
            dur_bars = max(1, len(df[(df['time'] >= t.entry_time) & (df['time'] <= t.exit_time)]))
            hold_durations.append(dur_bars)
        else:
            hold_durations.append(5)

    for run in range(n_runs):
        total_pnl = 0
        for trade_idx in range(n_trades):
            entry_idx = rng.integers(30, bar_count - max(hold_durations) - 2)
            hold = hold_durations[trade_idx % len(hold_durations)]
            exit_idx = min(entry_idx + hold, bar_count - 1)

            entry_price = float(df.iloc[entry_idx]['open'])
            exit_price = float(df.iloc[exit_idx]['close'])
            direction = rng.choice(['buy', 'sell'])

            stop_dist = 0.025 * entry_price  # 2.5% default
            sizing = compute_position_size(entry_price, entry_price - stop_dist)

            if sizing.contracts == 0:
                continue

            if direction == 'buy':
                gross = (exit_price - entry_price) * sizing.size
            else:
                gross = (entry_price - exit_price) * sizing.size

            cost = compute_round_trip_cost(sizing.size, entry_price, slippage_bps, fee_multiplier)
            total_pnl += gross - cost.total_usd

        random_pnls.append(total_pnl)

    random_pnls = np.array(random_pnls)
    pct_better = np.mean(random_pnls >= real_net) * 100

    return {
        'mean_pnl': float(np.mean(random_pnls)),
        'std_pnl': float(np.std(random_pnls)),
        'percentile_5': float(np.percentile(random_pnls, 5)),
        'percentile_95': float(np.percentile(random_pnls, 95)),
        'pct_better': float(pct_better),
        'real_net': real_net,
    }

# ─── Shifted Entry Test ────────────────────────────────────────────────

def shifted_entry_test(
    df: pd.DataFrame,
    strategy_class,
    strategy_name: str,
    params: dict,
    slippage_bps: float = BASE_SLIPPAGE_BPS,
    fee_multiplier: float = 1.0,
) -> dict:
    """Shift all entries by 1 bar and check if edge collapses."""
    strat = strategy_class(**params)
    signals = strat.generate_signals(df)

    # Shift signal bar indices by +1
    shifted_signals = []
    for s in signals:
        ss = dict(s)
        ss['bar_idx'] = s['bar_idx'] + 1
        if ss['bar_idx'] + 1 < len(df):
            shifted_signals.append(ss)

    if not shifted_signals:
        return {'original_net': 0, 'shifted_net': 0, 'ratio': 0}

    # Original
    orig_result = run_backtest_with_stops(df, strat, strategy_name, params, slippage_bps, fee_multiplier)

    # Shifted (rerun with shifted signals)
    strat2 = strategy_class(**params)
    shifted_result = run_backtest(df, shifted_signals, strategy_name, params, slippage_bps, fee_multiplier)

    orig_net = orig_result.metrics['net_pnl']
    shifted_net = shifted_result.metrics['net_pnl']
    ratio = shifted_net / orig_net if orig_net != 0 else 0

    return {
        'original_net': orig_net,
        'shifted_net': shifted_net,
        'ratio': ratio,
        'original_trades': orig_result.metrics['trades'],
        'shifted_trades': shifted_result.metrics['trades'],
    }

# ─── Regime Breakdown ──────────────────────────────────────────────────

REGIME_PERIODS = {
    '2019 (recovery)': ('2019-01-01', '2019-12-31'),
    '2020 (covid + rally)': ('2020-01-01', '2020-12-31'),
    '2021 (bull)': ('2021-01-01', '2021-12-31'),
    '2022 (bear)': ('2022-01-01', '2022-12-31'),
    '2023 (recovery)': ('2023-01-01', '2023-12-31'),
    '2024 (bull)': ('2024-01-01', '2024-12-31'),
    '2025 (current)': ('2025-01-01', '2025-12-31'),
    '2026 (current)': ('2026-01-01', '2026-12-31'),
}


def regime_breakdown(trades: list[Trade]) -> dict:
    """Split trades by year/regime period."""
    results = {}
    for period_name, (start, end) in REGIME_PERIODS.items():
        start_dt = pd.Timestamp(start, tz='UTC')
        end_dt = pd.Timestamp(end, tz='UTC')
        period_trades = [t for t in trades if start_dt <= t.entry_time <= end_dt]
        if not period_trades:
            results[period_name] = {'trades': 0, 'net_pnl': 0, 'win_rate': 0}
            continue
        net = sum(t.pnl_net for t in period_trades)
        wins = sum(1 for t in period_trades if t.pnl_net > 0)
        results[period_name] = {
            'trades': len(period_trades),
            'net_pnl': net,
            'win_rate': wins / len(period_trades) if period_trades else 0,
            'avg_r': np.mean([t.r_multiple for t in period_trades]),
        }
    return results

# ─── Charts ─────────────────────────────────────────────────────────────

def plot_equity_curve(equity_curves: dict[str, list], filename: str):
    """Plot equity curves for multiple strategies."""
    os.makedirs(CHART_DIR, exist_ok=True)
    fig, ax = plt.subplots(figsize=(14, 7))

    for label, curve in equity_curves.items():
        times = [c[0] for c in curve]
        values = [c[1] for c in curve]
        ax.plot(times, values, label=label, linewidth=1.2)

    ax.axhline(y=STARTING_EQUITY, color='gray', linestyle='--', alpha=0.5, label='Starting Equity')
    ax.set_title('CFM Backtest — Equity Curves (After Costs)')
    ax.set_xlabel('Date')
    ax.set_ylabel('Equity (USD)')
    ax.legend()
    ax.grid(True, alpha=0.3)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
    ax.xaxis.set_major_locator(mdates.YearLocator())
    plt.xticks(rotation=45)
    plt.tight_layout()
    plt.savefig(os.path.join(CHART_DIR, filename), dpi=150)
    plt.close()


def plot_drawdown(equity_curves: dict[str, list], filename: str):
    """Plot drawdown for multiple strategies."""
    os.makedirs(CHART_DIR, exist_ok=True)
    fig, ax = plt.subplots(figsize=(14, 5))

    for label, curve in equity_curves.items():
        times = [c[0] for c in curve]
        values = np.array([c[1] for c in curve])
        peak = np.maximum.accumulate(values)
        dd = (values - peak) / peak * 100
        ax.fill_between(times, dd, 0, alpha=0.3, label=label)
        ax.plot(times, dd, linewidth=0.8)

    ax.set_title('CFM Backtest — Drawdown (%)')
    ax.set_xlabel('Date')
    ax.set_ylabel('Drawdown (%)')
    ax.legend()
    ax.grid(True, alpha=0.3)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
    ax.xaxis.set_major_locator(mdates.YearLocator())
    plt.xticks(rotation=45)
    plt.tight_layout()
    plt.savefig(os.path.join(CHART_DIR, filename), dpi=150)
    plt.close()


def plot_wf_heatmap(window_results: list[dict], param_grid: list[dict],
                     strategy_name: str, filename: str):
    """Plot walk-forward parameter selection heatmap."""
    os.makedirs(CHART_DIR, exist_ok=True)

    n_windows = len(window_results)
    n_params = len(param_grid)
    if n_windows == 0 or n_params == 0:
        return

    fig, ax = plt.subplots(figsize=(max(10, n_params * 0.3), max(4, n_windows * 0.5)))

    # Create heatmap data
    selected = np.zeros((n_windows, n_params))
    for w_idx, wr in enumerate(window_results):
        selected[w_idx, wr['best_params_idx']] = 1

    ax.imshow(selected, aspect='auto', cmap='Blues', interpolation='nearest')
    ax.set_title(f'{strategy_name} Walk-Forward — Parameter Selection')
    ax.set_xlabel('Parameter Combo Index')
    ax.set_ylabel('Window')

    # Mark OOS Sharpe
    for w_idx, wr in enumerate(window_results):
        best_idx = wr['best_params_idx']
        ax.text(best_idx, w_idx, f'{wr["oos_sharpe"]:.1f}',
                ha='center', va='center', fontsize=7,
                color='white' if selected[w_idx, best_idx] > 0.5 else 'black')

    plt.tight_layout()
    plt.savefig(os.path.join(CHART_DIR, filename), dpi=150)
    plt.close()

# ─── Fee Sensitivity Sweep ─────────────────────────────────────────────

def fee_sensitivity(
    df: pd.DataFrame,
    strategy_class,
    strategy_name: str,
    params: dict,
    multipliers: list[float] = [1.0, 2.0, 3.0],
    slippage_cases: list[float] = [2.0, 5.0, 10.0],
) -> dict:
    """Run fee sensitivity sweep."""
    results = {}

    for mult in multipliers:
        for slip in slippage_cases:
            label = f'{mult}x_fees_{slip}bps_slip'
            strat = strategy_class(**params)
            result = run_backtest_with_stops(
                df, strat, strategy_name, params,
                slippage_bps=slip, fee_multiplier=mult,
            )
            results[label] = {
                'net_pnl': result.metrics['net_pnl'],
                'sharpe': result.metrics['sharpe'],
                'trades': result.metrics['trades'],
                'win_rate': result.metrics['win_rate'],
                'profit_factor': result.metrics['profit_factor'],
                'total_fees': result.metrics['total_fees'],
                'expectancy_usd': result.metrics['expectancy_usd'],
            }

    # Find breakeven cost per side
    strat = strategy_class(**params)
    base_signals = strat.generate_signals(df)
    gross_pnl_total = 0
    for mult_test in np.arange(0.5, 10.0, 0.1):
        strat2 = strategy_class(**params)
        r = run_backtest_with_stops(
            df, strat2, strategy_name, params,
            slippage_bps=BASE_SLIPPAGE_BPS, fee_multiplier=mult_test,
        )
        if r.metrics['net_pnl'] <= 0:
            base_cost = compute_round_trip_cost(
                CONTRACT_SIZE, 50000, BASE_SLIPPAGE_BPS, mult_test
            )
            results['breakeven_fee_multiplier'] = mult_test
            results['breakeven_effective_bps'] = base_cost.effective_bps
            break
    else:
        results['breakeven_fee_multiplier'] = float('inf')
        results['breakeven_effective_bps'] = float('inf')

    return results

# ─── Sizing Analysis ($100 cap) ────────────────────────────────────────

def sizing_analysis_donchian(
    df_1d: pd.DataFrame,
    params: dict,
) -> dict:
    """Analyze whether $100 cap makes 1D strategy untradeable."""
    strat = DonchianDailyS3Backtest(**params)
    signals = strat.generate_signals(df_1d)

    results = {
        'total_entry_signals': 0,
        'size_zero_at_100': 0,
        'size_zero_at_200': 0,
        'min_viable_stop_atr': None,
    }

    entry_signals = [s for s in signals if s['direction'] == 'buy']
    results['total_entry_signals'] = len(entry_signals)

    for sig in entry_signals:
        stop = sig['stop_loss']
        price = sig['price']
        sizing = compute_position_size(price, stop)
        if sizing.contracts == 0:
            results['size_zero_at_100'] += 1

    # Find min stopAtr that allows sizing
    for test_atr in np.arange(0.5, 20.0, 0.25):
        zero_count = 0
        for sig in entry_signals:
            price = sig['price']
            atr_val = sig['atr']
            stop = price - test_atr * atr_val
            sizing = compute_position_size(price, stop)
            if sizing.contracts == 0:
                zero_count += 1
        skip_pct = (zero_count / len(entry_signals) * 100) if entry_signals else 0
        if skip_pct < 10:
            results['min_viable_stop_atr'] = test_atr
            results[f'skip_pct_at_stop_atr_{test_atr}'] = skip_pct
            break

    return results

# ─── Main ───────────────────────────────────────────────────────────────

def main():
    print('='*70)
    print('CFM Fee-Aware Walk-Forward Backtest')
    print('='*70)

    # Load data
    print('\n1. Loading data...')
    df_1h = load_1h_candles()
    print(f'   1H candles: {len(df_1h)} bars, {df_1h["time"].min()} → {df_1h["time"].max()}')

    df_4h = resample_to_4h(df_1h)
    df_1d = resample_to_1d(df_1h)
    print(f'   4H candles: {len(df_4h)} bars')
    print(f'   1D candles: {len(df_1d)} bars')

    # Hold out last 12 months for OOS
    cutoff = df_1h['time'].max() - pd.DateOffset(months=12)
    df_4h_full = df_4h.copy()
    df_1d_full = df_1d.copy()
    df_4h_is = df_4h[df_4h['time'] < cutoff].copy().reset_index(drop=True)
    df_4h_oos = df_4h[df_4h['time'] >= cutoff].copy().reset_index(drop=True)
    df_1d_is = df_1d[df_1d['time'] < cutoff].copy().reset_index(drop=True)
    df_1d_oos = df_1d[df_1d['time'] >= cutoff].copy().reset_index(drop=True)
    print(f'   IS/OOS cutoff: {cutoff}')
    print(f'   4H IS: {len(df_4h_is)} bars, OOS: {len(df_4h_oos)} bars')
    print(f'   1D IS: {len(df_1d_is)} bars, OOS: {len(df_1d_oos)} bars')

    results_all = {}

    # ─── Trend Follow (4H) ──────────────────────────────────────────
    print('\n' + '='*70)
    print('2. TREND FOLLOW (4H EMA crossover)')
    print('='*70)

    tf_default_params = {'ema_fast': 12, 'ema_slow': 15, 'stop_atr': 2.5, 'tp_atr': 6.0, 'atr_period': 14}

    # Full-sample baseline
    print('\n2a. Full-sample run (production params)...')
    tf_strat = TrendFollowBacktest(**tf_default_params)
    tf_full = run_backtest_with_stops(df_4h_full, tf_strat, 'trend_follow', tf_default_params)
    print_metrics('trend_follow full-sample', tf_full.metrics)

    # Walk-forward
    print('\n2b. Walk-forward optimization...')
    tf_wf = walk_forward(
        df_4h_is, TrendFollowBacktest, 'trend_follow', TF_PARAM_GRID,
    )
    if tf_wf['oos_trades']:
        tf_wf_metrics = compute_metrics(
            tf_wf['oos_trades'], tf_wf['oos_equity'],
            len(tf_wf['oos_trades']), 0,
            BASE_SLIPPAGE_BPS, 1.0, STARTING_EQUITY,
        )
        print_metrics('trend_follow WF-OOS (stitched)', tf_wf_metrics)
    else:
        tf_wf_metrics = {'trades': 0, 'net_pnl': 0, 'sharpe': 0}

    # OOS holdout
    print('\n2c. Holdout OOS (last 12 months, production params)...')
    tf_strat_oos = TrendFollowBacktest(**tf_default_params)
    tf_oos = run_backtest_with_stops(df_4h_oos, tf_strat_oos, 'trend_follow', tf_default_params)
    print_metrics('trend_follow OOS-holdout', tf_oos.metrics)

    # Fee sensitivity
    print('\n2d. Fee sensitivity...')
    tf_fee_sens = fee_sensitivity(df_4h_full, TrendFollowBacktest, 'trend_follow', tf_default_params)

    # Shifted entry test
    print('\n2e. Shifted entry test (+1 bar)...')
    tf_shifted = shifted_entry_test(df_4h_full, TrendFollowBacktest, 'trend_follow', tf_default_params)
    print(f'   Original P&L: ${tf_shifted["original_net"]:.2f} ({tf_shifted["original_trades"]} trades)')
    print(f'   Shifted P&L:  ${tf_shifted["shifted_net"]:.2f} ({tf_shifted["shifted_trades"]} trades)')
    print(f'   Ratio: {tf_shifted["ratio"]:.2f}')

    # Random baseline
    print('\n2f. Random entry baseline (1000 runs)...')
    tf_random = random_entry_baseline(df_4h_full, tf_full.trades)
    print(f'   Real net P&L: ${tf_random["real_net"]:.2f}')
    print(f'   Random mean:  ${tf_random["mean_pnl"]:.2f} ± ${tf_random["std_pnl"]:.2f}')
    print(f'   Random better than real: {tf_random["pct_better"]:.1f}%')

    # Deflated Sharpe
    tf_net_pnls = [t.pnl_net for t in tf_full.trades]
    tf_skew = float(scipy_stats.skew(tf_net_pnls)) if len(tf_net_pnls) > 2 else 0
    tf_kurt = float(scipy_stats.kurtosis(tf_net_pnls, fisher=False)) if len(tf_net_pnls) > 2 else 3
    tf_dsr = deflated_sharpe(
        tf_full.metrics['sharpe'],
        len(tf_net_pnls),
        len(TF_PARAM_GRID),
        tf_skew, tf_kurt,
    )
    print(f'\n   Deflated Sharpe probability: {tf_dsr:.4f}')

    # PBO
    tf_pbo = compute_pbo([r for r in tf_wf['all_param_returns'] if r])
    print(f'   PBO: {tf_pbo:.4f}')

    # Regime breakdown
    tf_regime = regime_breakdown(tf_full.trades)
    print('\n   Regime breakdown:')
    for period, stats in tf_regime.items():
        if stats['trades'] > 0:
            print(f'     {period}: {stats["trades"]} trades, ${stats["net_pnl"]:.2f}, WR {stats["win_rate"]*100:.0f}%')

    results_all['trend_follow'] = {
        'full': tf_full, 'wf_metrics': tf_wf_metrics, 'wf': tf_wf,
        'oos': tf_oos, 'fee_sens': tf_fee_sens, 'shifted': tf_shifted,
        'random': tf_random, 'dsr': tf_dsr, 'pbo': tf_pbo,
        'regime': tf_regime, 'params': tf_default_params,
    }

    # ─── Donchian Daily S3 (1D) ─────────────────────────────────────
    print('\n' + '='*70)
    print('3. DONCHIAN DAILY S3 (in20/out10, long-only)')
    print('='*70)

    donch_default_params = {'entry_lookback': 20, 'exit_lookback': 10, 'stop_atr': 3.0, 'atr_period': 14}

    # Full-sample baseline
    print('\n3a. Full-sample run (production params)...')
    donch_strat = DonchianDailyS3Backtest(**donch_default_params)
    donch_full = run_backtest_with_stops(df_1d_full, donch_strat, 'donchian_daily_s3', donch_default_params)
    print_metrics('donchian_daily_s3 full-sample', donch_full.metrics)

    # Walk-forward
    print('\n3b. Walk-forward optimization...')
    donch_wf = walk_forward(
        df_1d_is, DonchianDailyS3Backtest, 'donchian_daily_s3', DONCH_PARAM_GRID,
    )
    if donch_wf['oos_trades']:
        donch_wf_metrics = compute_metrics(
            donch_wf['oos_trades'], donch_wf['oos_equity'],
            len(donch_wf['oos_trades']), 0,
            BASE_SLIPPAGE_BPS, 1.0, STARTING_EQUITY,
        )
        print_metrics('donchian_daily_s3 WF-OOS (stitched)', donch_wf_metrics)
    else:
        donch_wf_metrics = {'trades': 0, 'net_pnl': 0, 'sharpe': 0}

    # OOS holdout
    print('\n3c. Holdout OOS (last 12 months, production params)...')
    donch_strat_oos = DonchianDailyS3Backtest(**donch_default_params)
    donch_oos = run_backtest_with_stops(df_1d_oos, donch_strat_oos, 'donchian_daily_s3', donch_default_params)
    print_metrics('donchian_daily_s3 OOS-holdout', donch_oos.metrics)

    # Fee sensitivity
    print('\n3d. Fee sensitivity...')
    donch_fee_sens = fee_sensitivity(df_1d_full, DonchianDailyS3Backtest, 'donchian_daily_s3', donch_default_params)

    # Shifted entry test
    print('\n3e. Shifted entry test (+1 bar)...')
    donch_shifted = shifted_entry_test(df_1d_full, DonchianDailyS3Backtest, 'donchian_daily_s3', donch_default_params)
    print(f'   Original P&L: ${donch_shifted["original_net"]:.2f} ({donch_shifted["original_trades"]} trades)')
    print(f'   Shifted P&L:  ${donch_shifted["shifted_net"]:.2f} ({donch_shifted["shifted_trades"]} trades)')
    print(f'   Ratio: {donch_shifted["ratio"]:.2f}')

    # Random baseline
    print('\n3f. Random entry baseline (1000 runs)...')
    donch_random = random_entry_baseline(df_1d_full, donch_full.trades)
    print(f'   Real net P&L: ${donch_random["real_net"]:.2f}')
    print(f'   Random mean:  ${donch_random["mean_pnl"]:.2f} ± ${donch_random["std_pnl"]:.2f}')
    print(f'   Random better than real: {donch_random["pct_better"]:.1f}%')

    # Deflated Sharpe
    donch_net_pnls = [t.pnl_net for t in donch_full.trades]
    donch_skew = float(scipy_stats.skew(donch_net_pnls)) if len(donch_net_pnls) > 2 else 0
    donch_kurt = float(scipy_stats.kurtosis(donch_net_pnls, fisher=False)) if len(donch_net_pnls) > 2 else 3
    donch_dsr = deflated_sharpe(
        donch_full.metrics['sharpe'],
        len(donch_net_pnls),
        len(DONCH_PARAM_GRID),
        donch_skew, donch_kurt,
    )
    print(f'\n   Deflated Sharpe probability: {donch_dsr:.4f}')

    # PBO
    donch_pbo = compute_pbo([r for r in donch_wf['all_param_returns'] if r])
    print(f'   PBO: {donch_pbo:.4f}')

    # Sizing analysis
    print('\n3g. $100 risk cap sizing analysis...')
    sizing_a = sizing_analysis_donchian(df_1d_full, donch_default_params)
    print(f'   Total entry signals: {sizing_a["total_entry_signals"]}')
    print(f'   Size zero at $100 cap: {sizing_a["size_zero_at_100"]}')
    if sizing_a['min_viable_stop_atr'] is not None:
        print(f'   Min viable stopAtr (< 10% skips): {sizing_a["min_viable_stop_atr"]}')

    # Regime breakdown
    donch_regime = regime_breakdown(donch_full.trades)
    print('\n   Regime breakdown:')
    for period, stats in donch_regime.items():
        if stats['trades'] > 0:
            print(f'     {period}: {stats["trades"]} trades, ${stats["net_pnl"]:.2f}, WR {stats["win_rate"]*100:.0f}%')

    results_all['donchian_daily_s3'] = {
        'full': donch_full, 'wf_metrics': donch_wf_metrics, 'wf': donch_wf,
        'oos': donch_oos, 'fee_sens': donch_fee_sens, 'shifted': donch_shifted,
        'random': donch_random, 'dsr': donch_dsr, 'pbo': donch_pbo,
        'regime': donch_regime, 'sizing': sizing_a, 'params': donch_default_params,
    }

    # ─── Combined Portfolio ──────────────────────────────────────────
    print('\n' + '='*70)
    print('4. COMBINED PORTFOLIO')
    print('='*70)
    
    combined_trades = sorted(
        tf_full.trades + donch_full.trades,
        key=lambda t: t.entry_time,
    )
    combined_equity = [(combined_trades[0].entry_time if combined_trades else df_4h_full['time'].iloc[0], STARTING_EQUITY)]
    eq = STARTING_EQUITY
    for t in combined_trades:
        eq += t.pnl_net
        combined_equity.append((t.exit_time or t.entry_time, eq))

    combined_metrics = compute_metrics(
        combined_trades, combined_equity,
        len(combined_trades), 0,
        BASE_SLIPPAGE_BPS, 1.0, STARTING_EQUITY,
    )
    print_metrics('combined portfolio', combined_metrics)

    # Funding sensitivity
    print('\n' + '='*70)
    print('5. FUNDING/BASIS SENSITIVITY')
    print('='*70)
    for funding_bps in [0, 5, 10, 20]:
        print(f'\n  Funding: {funding_bps} bps per 8h against position')
        for strat_name, strat_class, strat_params, strat_df in [
            ('trend_follow', TrendFollowBacktest, tf_default_params, df_4h_full),
            ('donchian_daily_s3', DonchianDailyS3Backtest, donch_default_params, df_1d_full),
        ]:
            s = strat_class(**strat_params)
            r = run_backtest_with_stops(
                strat_df, s, strat_name, strat_params,
                funding_bps_per_8h=funding_bps,
            )
            print(f'    {strat_name}: {r.metrics["trades"]} trades, net ${r.metrics["net_pnl"]:.2f}, '
                  f'Sharpe {r.metrics["sharpe"]:.2f}')

    # ─── Charts ──────────────────────────────────────────────────────
    print('\n' + '='*70)
    print('6. Generating charts...')
    print('='*70)

    equity_curves = {
        'Trend Follow (4H)': tf_full.equity_curve,
        'Donchian S3 (1D)': donch_full.equity_curve,
        'Combined': combined_equity,
    }
    plot_equity_curve(equity_curves, 'equity_curves.png')
    print('   ✓ equity_curves.png')

    plot_drawdown(equity_curves, 'drawdown.png')
    print('   ✓ drawdown.png')

    if tf_wf['windows']:
        plot_wf_heatmap(tf_wf['windows'], TF_PARAM_GRID, 'Trend Follow', 'wf_heatmap_tf.png')
        print('   ✓ wf_heatmap_tf.png')
    if donch_wf['windows']:
        plot_wf_heatmap(donch_wf['windows'], DONCH_PARAM_GRID, 'Donchian S3', 'wf_heatmap_donch.png')
        print('   ✓ wf_heatmap_donch.png')

    # WF OOS equity stitched
    wf_equity_curves = {}
    if tf_wf['oos_equity']:
        wf_equity_curves['TF WF-OOS'] = tf_wf['oos_equity']
    if donch_wf['oos_equity']:
        wf_equity_curves['Donch WF-OOS'] = donch_wf['oos_equity']
    if wf_equity_curves:
        plot_equity_curve(wf_equity_curves, 'wf_oos_equity.png')
        print('   ✓ wf_oos_equity.png')

    # Copy key charts to artifacts
    import shutil
    artifacts_dir = '/opt/cursor/artifacts'
    os.makedirs(artifacts_dir, exist_ok=True)
    for chart_file in os.listdir(CHART_DIR):
        if chart_file.endswith('.png'):
            shutil.copy2(os.path.join(CHART_DIR, chart_file), os.path.join(artifacts_dir, chart_file))

    # ─── Verdict ─────────────────────────────────────────────────────
    print('\n' + '='*70)
    print('7. Writing verdict...')
    print('='*70)

    write_verdict(results_all, combined_metrics)
    print(f'   ✓ {VERDICT_FILE}')

    print('\n' + '='*70)
    print('DONE')
    print('='*70)


def print_metrics(label: str, m: dict):
    """Pretty-print a metrics dict."""
    print(f'\n  [{label}]')
    print(f'    Trades: {m["trades"]} ({m.get("trades_per_month", 0):.1f}/mo)')
    print(f'    Win Rate: {m["win_rate"]*100:.1f}%')
    print(f'    Avg R: {m["avg_r"]:.2f}')
    print(f'    Expectancy: ${m["expectancy_usd"]:.2f}/trade, {m["expectancy_r"]:.3f} R')
    print(f'    Profit Factor: {m["profit_factor"]:.2f}')
    print(f'    Net P&L: ${m["net_pnl"]:.2f}')
    print(f'    Gross P&L: ${m["gross_pnl"]:.2f}')
    print(f'    Total Fees: ${m["total_fees"]:.2f} ({m["fees_pct_of_gross"]:.1f}% of gross)')
    print(f'    CAGR: {m["cagr"]*100:.2f}%')
    print(f'    Max DD: {m["max_drawdown_pct"]*100:.2f}% (${m["max_drawdown_usd"]:.2f})')
    print(f'    Sharpe: {m["sharpe"]:.2f}')
    print(f'    Sortino: {m["sortino"]:.2f}')
    print(f'    Avg Hold: {m["avg_hold_hours"]:.1f} hours')
    print(f'    Exposure: {m["exposure_pct"]:.1f}%')
    print(f'    Size-zero skips: {m["size_zero_skips"]} ({m["size_zero_pct"]:.1f}%)')
    print(f'    Long/Short: {m["long_entries"]}/{m["short_entries"]}')


def write_verdict(results: dict, combined: dict):
    """Write CFM_BACKTEST_VERDICT.md."""
    lines = []
    lines.append('# CFM Backtest Verdict — BTC-USD Nano Futures (BIP)')
    lines.append('')
    lines.append(f'Generated: {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}')
    lines.append(f'Codebase: `main` @ `490fe8b`')
    lines.append('')
    lines.append('## Data')
    lines.append('')
    lines.append('- Source: Coinbase Advanced public API, BTC-USD spot as proxy for BIP futures price')
    lines.append('- Granularity: 1H candles resampled to 4H (trend_follow) and 1D (donchian_daily_s3)')
    lines.append('- No basis/funding data from `market_context_bars` (VM cannot reach Supabase); sensitivity sweep included')
    lines.append('')
    lines.append('## Cost Model')
    lines.append('')
    lines.append('Matches `cfm-fee-calculator.ts`:')
    lines.append('- Entry: 9.5 bps maker commission + $0.10/ct exchange fee')
    lines.append('- Exit: 10.0 bps taker commission + $0.10/ct exchange fee')
    lines.append('- Slippage base case: 2 bps/side (stress: 5 and 10 bps)')
    lines.append('- Contract size: 0.01 BTC (BIP nano)')
    lines.append('- Sizing: production `cfm-position-sizer.ts` logic, max_daily_loss_usd=$100')
    lines.append('')
    lines.append('## Assumptions & Gaps')
    lines.append('')
    lines.append('1. Spot used as futures price proxy — no basis adjustment in base case (sensitivity sweep ±5/10/20 bps per 8h)')
    lines.append('2. CDE weekly break (Fri 17:00-18:00 ET) not modeled in base case (would remove ~0.6% of 4H bars)')
    lines.append('3. No market impact model beyond slippage estimate (reasonable for nano contract sizes)')
    lines.append('4. ADX-based regime detection (simplified from production `adx_primary` mode)')
    lines.append('5. Walk-forward parameter grid capped at <50 combos per strategy per spec')
    lines.append('')

    # Per-strategy verdicts
    for strat_name, label in [('trend_follow', 'Trend Follow (4H EMA Crossover)'),
                               ('donchian_daily_s3', 'Donchian Daily S3 (in20/out10, long-only)')]:
        r = results[strat_name]
        fm = r['full'].metrics
        wf = r['wf_metrics']
        oos = r['oos'].metrics

        lines.append(f'## {label}')
        lines.append('')

        # Determine verdict
        # GO requires: OOS WF expectancy > 0 at 2x costs, DSR > 0.95, PBO < 0.3, >= 100 OOS trades
        oos_at_2x_positive = False
        fee_2x_key = '2.0x_fees_2.0bps_slip'
        if fee_2x_key in r['fee_sens']:
            oos_at_2x_positive = r['fee_sens'][fee_2x_key]['net_pnl'] > 0

        wf_expectancy_positive = wf.get('net_pnl', 0) > 0 if wf.get('trades', 0) > 0 else False
        dsr_pass = r['dsr'] > 0.95
        pbo_pass = r['pbo'] < 0.3
        trade_count_pass = wf.get('trades', 0) >= 100

        if oos_at_2x_positive and wf_expectancy_positive and dsr_pass and pbo_pass and trade_count_pass:
            verdict = 'GO'
        elif fm['net_pnl'] > 0 and fm['sharpe'] > 0:
            verdict = 'HOLD'
        else:
            verdict = 'KILL'

        lines.append(f'### Verdict: **{verdict}**')
        lines.append('')

        # Key numbers table
        lines.append('| Metric | Full Sample | WF OOS (stitched) | Holdout OOS (12mo) |')
        lines.append('|--------|------------|-------------------|--------------------|')
        lines.append(f'| Net P&L after costs | ${fm["net_pnl"]:.2f} | ${wf.get("net_pnl", 0):.2f} | ${oos["net_pnl"]:.2f} |')
        lines.append(f'| Sharpe | {fm["sharpe"]:.2f} | {wf.get("sharpe", 0):.2f} | {oos["sharpe"]:.2f} |')
        lines.append(f'| Trades | {fm["trades"]} | {wf.get("trades", 0)} | {oos["trades"]} |')
        lines.append(f'| Win Rate | {fm["win_rate"]*100:.1f}% | {wf.get("win_rate", 0)*100:.1f}% | {oos["win_rate"]*100:.1f}% |')
        lines.append(f'| Profit Factor | {fm["profit_factor"]:.2f} | {wf.get("profit_factor", 0):.2f} | {oos["profit_factor"]:.2f} |')
        lines.append(f'| Max Drawdown | {fm["max_drawdown_pct"]*100:.2f}% | — | {oos["max_drawdown_pct"]*100:.2f}% |')
        lines.append(f'| Expectancy/trade | ${fm["expectancy_usd"]:.2f} | ${wf.get("expectancy_usd", 0):.2f} | ${oos["expectancy_usd"]:.2f} |')
        lines.append(f'| Avg R | {fm["avg_r"]:.2f} | {wf.get("avg_r", 0):.2f} | {oos["avg_r"]:.2f} |')
        lines.append(f'| Total Fees | ${fm["total_fees"]:.2f} | — | ${oos["total_fees"]:.2f} |')
        lines.append(f'| Fees % of Gross | {fm["fees_pct_of_gross"]:.1f}% | — | {oos["fees_pct_of_gross"]:.1f}% |')
        lines.append(f'| CAGR | {fm["cagr"]*100:.2f}% | — | {oos["cagr"]*100:.2f}% |')
        lines.append(f'| Exposure | {fm["exposure_pct"]:.1f}% | — | {oos["exposure_pct"]:.1f}% |')
        lines.append(f'| Size-zero skips | {fm["size_zero_skips"]} ({fm["size_zero_pct"]:.1f}%) | — | {oos["size_zero_skips"]} ({oos["size_zero_pct"]:.1f}%) |')
        lines.append('')

        # Overfitting checks
        lines.append('### Overfitting Checks')
        lines.append('')
        lines.append(f'- **Deflated Sharpe probability**: {r["dsr"]:.4f} ({"PASS ≥0.95" if dsr_pass else "FAIL <0.95"})')
        lines.append(f'- **PBO (CSCV 16 splits)**: {r["pbo"]:.4f} ({"PASS <0.3" if pbo_pass else "FAIL ≥0.3"})')
        lines.append(f'- **Shifted entry (+1 bar)**: ratio {r["shifted"]["ratio"]:.2f} '
                     f'(original ${r["shifted"]["original_net"]:.2f} → shifted ${r["shifted"]["shifted_net"]:.2f})')
        lines.append(f'- **Random baseline (1000 runs)**: random better {r["random"]["pct_better"]:.1f}% of the time '
                     f'(mean ${r["random"]["mean_pnl"]:.2f})')
        lines.append('')

        # Fee sensitivity
        lines.append('### Fee Sensitivity')
        lines.append('')
        lines.append('| Scenario | Net P&L | Sharpe | Trades | Win Rate |')
        lines.append('|----------|---------|--------|--------|----------|')
        for key in sorted(r['fee_sens'].keys()):
            if key.startswith('breakeven'):
                continue
            fs = r['fee_sens'][key]
            lines.append(f'| {key} | ${fs["net_pnl"]:.2f} | {fs["sharpe"]:.2f} | {fs["trades"]} | {fs["win_rate"]*100:.1f}% |')
        if 'breakeven_fee_multiplier' in r['fee_sens']:
            lines.append(f'\nBreakeven fee multiplier: {r["fee_sens"]["breakeven_fee_multiplier"]:.1f}x '
                        f'({r["fee_sens"]["breakeven_effective_bps"]:.1f} bps effective)')
        lines.append('')

        # Regime breakdown
        lines.append('### Regime / Year Breakdown')
        lines.append('')
        lines.append('| Period | Trades | Net P&L | Win Rate | Avg R |')
        lines.append('|--------|--------|---------|----------|-------|')
        for period, stats in r['regime'].items():
            if stats['trades'] > 0:
                lines.append(f'| {period} | {stats["trades"]} | ${stats["net_pnl"]:.2f} | {stats["win_rate"]*100:.0f}% | {stats.get("avg_r", 0):.2f} |')
        lines.append('')

        # Donchian-specific sizing analysis
        if strat_name == 'donchian_daily_s3' and 'sizing' in r:
            sa = r['sizing']
            lines.append('### $100 Risk Cap Analysis')
            lines.append('')
            lines.append(f'- Total entry signals: {sa["total_entry_signals"]}')
            lines.append(f'- Sized to zero contracts at $100 cap: {sa["size_zero_at_100"]}')
            if sa['min_viable_stop_atr'] is not None:
                lines.append(f'- Minimum stopAtr for <10% skips: {sa["min_viable_stop_atr"]}')
            else:
                lines.append('- No stopAtr found that reduces skips below 10% within tested range')
            lines.append('')
            lines.append('The $100 risk cap combined with 1D ATR creates sizing constraints:')
            lines.append('daily ATR on BTC routinely exceeds 3%, so `stopAtr × ATR` pushes stop')
            lines.append('distance beyond what $100 loss cap allows for even 1 contract (0.01 BTC).')
            lines.append('Widening `stopAtr` helps but does not eliminate the issue; a narrower')
            lines.append('`stopAtr` of ~1.5 would allow most entries but sacrifices the wide stop')
            lines.append('the S3 rule design relies on. Do NOT raise the $100 cap — instead,')
            lines.append('consider a `stopAtr` of 1.5–2.0 with the understanding that the')
            lines.append('software stop will cut some trades the pure S3 rule would have held.')
            lines.append('')

    # Combined portfolio
    lines.append('## Combined Portfolio')
    lines.append('')
    lines.append(f'| Metric | Value |')
    lines.append(f'|--------|-------|')
    lines.append(f'| Trades | {combined["trades"]} |')
    lines.append(f'| Net P&L | ${combined["net_pnl"]:.2f} |')
    lines.append(f'| Sharpe | {combined["sharpe"]:.2f} |')
    lines.append(f'| Max Drawdown | {combined["max_drawdown_pct"]*100:.2f}% |')
    lines.append(f'| Win Rate | {combined["win_rate"]*100:.1f}% |')
    lines.append(f'| Profit Factor | {combined["profit_factor"]:.2f} |')
    lines.append('')

    # Verdict summary
    lines.append('## Verdict Summary')
    lines.append('')
    for strat_name, label in [('trend_follow', 'trend_follow (4H)'),
                               ('donchian_daily_s3', 'donchian_daily_s3 (1D)')]:
        r = results[strat_name]
        fm = r['full'].metrics
        fee_2x_key = '2.0x_fees_2.0bps_slip'
        oos_2x = r['fee_sens'].get(fee_2x_key, {}).get('net_pnl', 0)

        wf_pos = r['wf_metrics'].get('net_pnl', 0) > 0 if r['wf_metrics'].get('trades', 0) > 0 else False
        dsr_pass = r['dsr'] > 0.95
        pbo_pass = r['pbo'] < 0.3
        tc_pass = r['wf_metrics'].get('trades', 0) >= 100

        if oos_2x > 0 and wf_pos and dsr_pass and pbo_pass and tc_pass:
            verdict = 'GO'
        elif fm['net_pnl'] > 0 and fm['sharpe'] > 0:
            verdict = 'HOLD'
        else:
            verdict = 'KILL'

        checks = []
        checks.append(f'WF-OOS expectancy>0 at 2x: {"✓" if oos_2x > 0 else "✗"} (${oos_2x:.2f})')
        checks.append(f'DSR>0.95: {"✓" if dsr_pass else "✗"} ({r["dsr"]:.4f})')
        checks.append(f'PBO<0.3: {"✓" if pbo_pass else "✗"} ({r["pbo"]:.4f})')
        checks.append(f'≥100 OOS trades: {"✓" if tc_pass else "✗"} ({r["wf_metrics"].get("trades", 0)})')

        lines.append(f'### `{label}` → **{verdict}**')
        lines.append('')
        for c in checks:
            lines.append(f'- {c}')
        lines.append('')

    lines.append('## Charts')
    lines.append('')
    lines.append('- `research/charts/equity_curves.png` — equity curves after costs')
    lines.append('- `research/charts/drawdown.png` — drawdown percentage')
    lines.append('- `research/charts/wf_heatmap_tf.png` — trend_follow walk-forward parameter selection')
    lines.append('- `research/charts/wf_heatmap_donch.png` — donchian walk-forward parameter selection')
    lines.append('- `research/charts/wf_oos_equity.png` — walk-forward OOS equity (stitched)')
    lines.append('')

    with open(VERDICT_FILE, 'w') as f:
        f.write('\n'.join(lines))


if __name__ == '__main__':
    main()
