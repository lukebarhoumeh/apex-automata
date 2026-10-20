#!/usr/bin/env python3
"""
Parity tests: verify Python backtest modules match production TypeScript.

Tests:
  1. Fee calculator parity (cfm-fee-calculator.ts)
  2. Position sizer parity (cfm-position-sizer.ts)
  3. Signal parity (trend_follow and donchian_daily_s3 on synthetic data)

Usage: python3 research/test_parity.py
"""
import sys
import math
import numpy as np

# Import the backtest module
sys.path.insert(0, '.')
from cfm_backtest import (
    compute_round_trip_cost, compute_position_size,
    TrendFollowBacktest, DonchianDailyS3Backtest,
    ema, atr,
    CONTRACT_SIZE, MAKER_BPS, TAKER_BPS, EXCHANGE_FEE_PER_CONTRACT,
    MAX_DAILY_LOSS_USD, MAX_NOTIONAL_USD, L1_DAILY_R_BUDGET_USD,
)

PASS = 0
FAIL = 0


def assert_close(actual, expected, tol, msg):
    global PASS, FAIL
    if abs(actual - expected) <= tol:
        PASS += 1
    else:
        FAIL += 1
        print(f'  FAIL: {msg}: actual={actual}, expected={expected}, tol={tol}')


def assert_equal(actual, expected, msg):
    global PASS, FAIL
    if actual == expected:
        PASS += 1
    else:
        FAIL += 1
        print(f'  FAIL: {msg}: actual={actual}, expected={expected}')


# ─── 1. Fee Calculator Parity ──────────────────────────────────────────

def test_fee_calculator():
    """Test against the worked example in cfm-fee-calculator.ts docstring."""
    print('\n1. Fee Calculator Parity')
    print('   Reference: cfm-fee-calculator.ts docstring example')
    print('   1 nano BTC round trip @ $77,000')

    # From the docstring:
    #   Notional: 0.01 BTC × $77,000 = $770
    #   Entry (maker, post_only): 9.5 bps × $770 = $0.7315 + $0.10 exchange = $0.8315
    #   Exit (taker): 10 bps × $770 = $0.77 + $0.10 exchange = $0.87
    #   Round trip: $0.8315 + $0.87 = $1.7015 (22.1 bps effective)
    #   + slippage 3 bps × $770 × 2 = $0.462
    #   Total: ~$2.16

    cost = compute_round_trip_cost(
        size_underlying=0.01,
        price=77000,
        slippage_bps=3.0,  # docstring uses 3 bps
        fee_multiplier=1.0,
    )

    expected_notional = 770.0
    expected_entry_comm = 770 * 9.5 / 10000  # $0.7315
    expected_entry_exchange = 1 * 0.10  # $0.10
    expected_entry_fee = expected_entry_comm + expected_entry_exchange  # $0.8315
    expected_exit_comm = 770 * 10.0 / 10000  # $0.77
    expected_exit_exchange = 1 * 0.10  # $0.10
    expected_exit_fee = expected_exit_comm + expected_exit_exchange  # $0.87
    expected_slippage = 770 * 3.0 / 10000 * 2  # $0.462
    expected_total = expected_entry_fee + expected_exit_fee + expected_slippage

    assert_close(cost.entry_fee_usd, expected_entry_fee, 0.001, 'entry fee')
    assert_close(cost.exit_fee_usd, expected_exit_fee, 0.001, 'exit fee')
    assert_close(cost.slippage_usd, expected_slippage, 0.001, 'slippage')
    assert_close(cost.total_usd, expected_total, 0.01, 'total cost')
    assert_equal(cost.contracts, 1, 'contracts')

    print(f'   Entry fee: ${cost.entry_fee_usd:.4f} (expected ${expected_entry_fee:.4f})')
    print(f'   Exit fee:  ${cost.exit_fee_usd:.4f} (expected ${expected_exit_fee:.4f})')
    print(f'   Slippage:  ${cost.slippage_usd:.4f} (expected ${expected_slippage:.4f})')
    print(f'   Total:     ${cost.total_usd:.4f} (expected ${expected_total:.4f})')

    # Test with multiple contracts
    cost_10 = compute_round_trip_cost(0.10, 77000, 3.0, 1.0)
    assert_equal(cost_10.contracts, 10, '10 contracts')
    expected_10_entry = 7700 * 9.5 / 10000 + 10 * 0.10
    assert_close(cost_10.entry_fee_usd, expected_10_entry, 0.01, '10-ct entry fee')

    # Test fee multiplier
    cost_2x = compute_round_trip_cost(0.01, 77000, 3.0, 2.0)
    expected_2x_entry = 770 * (9.5 * 2) / 10000 + 1 * (0.10 * 2)
    assert_close(cost_2x.entry_fee_usd, expected_2x_entry, 0.001, '2x entry fee')

    # Zero size
    cost_zero = compute_round_trip_cost(0, 77000, 3.0, 1.0)
    assert_equal(cost_zero.contracts, 0, 'zero-size contracts')


# ─── 2. Position Sizer Parity ──────────────────────────────────────────

def test_position_sizer():
    """Test against cfm-position-sizer.ts logic."""
    print('\n2. Position Sizer Parity')
    print('   Reference: cfm-position-sizer.ts')

    # Case 1: Normal sizing, daily_loss cap
    # entry=50000, stop=47500 → stopDist=5%, lossCap=min(100,100)=100
    # maxNotional = 100/0.05 = 2000, capped by max_notional
    # maxSize = 2000/50000 = 0.04 → 4 contracts → size=0.04
    s1 = compute_position_size(50000, 47500)
    assert_equal(s1.contracts, 4, 'case1 contracts')
    assert_close(s1.size, 0.04, 0.0001, 'case1 size')
    assert_close(s1.stop_distance_pct, 0.05, 0.001, 'case1 stop dist')
    assert_close(s1.notional_usd, 2000, 1.0, 'case1 notional')
    print(f'   Case 1: {s1.contracts} contracts, size={s1.size}, capped_by={s1.capped_by}')

    # Case 2: Wide stop, loss cap dominates
    # entry=50000, stop=45000 → stopDist=10%, lossCap=100
    # maxNotional = 100/0.10 = 1000
    # maxSize = 1000/50000 = 0.02 → 2 contracts
    s2 = compute_position_size(50000, 45000)
    assert_equal(s2.contracts, 2, 'case2 contracts')
    assert_close(s2.size, 0.02, 0.0001, 'case2 size')
    print(f'   Case 2: {s2.contracts} contracts, size={s2.size}, capped_by={s2.capped_by}')

    # Case 3: Very wide stop → 0 contracts
    # entry=50000, stop=25000 → stopDist=50%, lossCap=100
    # maxNotional = 100/0.50 = 200
    # maxSize = 200/50000 = 0.004 → 0 contracts (floor)
    s3 = compute_position_size(50000, 25000)
    assert_equal(s3.contracts, 0, 'case3 contracts (size zero)')
    assert_close(s3.size, 0, 0.0001, 'case3 size')
    print(f'   Case 3: {s3.contracts} contracts (sized to zero)')

    # Case 4: Tight stop
    # entry=50000, stop=49500 → stopDist=1%, lossCap=100
    # maxNotional = 100/0.01 = 10000 → capped at 2000
    # maxSize = 2000/50000 = 0.04 → 4 contracts
    s4 = compute_position_size(50000, 49500)
    assert_equal(s4.contracts, 4, 'case4 contracts')
    assert_equal(s4.capped_by, 'max_notional', 'case4 capped_by')
    print(f'   Case 4: {s4.contracts} contracts, capped_by={s4.capped_by}')

    # Edge cases
    s5 = compute_position_size(0, 47500)
    assert_equal(s5.contracts, 0, 'zero price')
    s6 = compute_position_size(50000, 50000)
    assert_equal(s6.contracts, 0, 'zero stop distance')


# ─── 3. Signal Parity ──────────────────────────────────────────────────

def test_signal_parity():
    """Test that strategies generate expected signals on synthetic data."""
    print('\n3. Signal Parity')
    import pandas as pd

    # Create a synthetic trending dataset
    np.random.seed(42)
    n = 500
    prices = np.cumsum(np.random.randn(n) * 100) + 50000
    prices = np.maximum(prices, 1000)

    times = pd.date_range('2023-01-01', periods=n, freq='4h', tz='UTC')
    df_4h = pd.DataFrame({
        'time': times,
        'open': prices - np.random.rand(n) * 50,
        'high': prices + np.abs(np.random.randn(n)) * 200,
        'low': prices - np.abs(np.random.randn(n)) * 200,
        'close': prices,
        'volume': np.random.rand(n) * 1000,
    })
    # Ensure OHLC consistency
    df_4h['high'] = df_4h[['open', 'high', 'close']].max(axis=1)
    df_4h['low'] = df_4h[['open', 'low', 'close']].min(axis=1)

    # Test trend_follow
    tf = TrendFollowBacktest(ema_fast=12, ema_slow=15, stop_atr=2.5, tp_atr=6.0)
    tf_signals = tf.generate_signals(df_4h)
    print(f'   TrendFollow on synthetic 4H: {len(tf_signals)} signals')

    for sig in tf_signals:
        assert_equal(sig['direction'] in ('buy', 'sell'), True, f'TF signal direction valid')
        assert_equal(sig['stop_loss'] > 0, True, f'TF signal has stop_loss')
        assert_equal(sig['take_profit'] > 0, True, f'TF signal has take_profit')
        if sig['direction'] == 'buy':
            assert_equal(sig['stop_loss'] < sig['price'], True, 'TF buy stop < price')
            assert_equal(sig['take_profit'] > sig['price'], True, 'TF buy TP > price')

    # Test donchian
    times_1d = pd.date_range('2020-01-01', periods=500, freq='1D', tz='UTC')
    prices_1d = np.cumsum(np.random.randn(500) * 500) + 30000
    prices_1d = np.maximum(prices_1d, 5000)
    df_1d = pd.DataFrame({
        'time': times_1d,
        'open': prices_1d - np.random.rand(500) * 100,
        'high': prices_1d + np.abs(np.random.randn(500)) * 500,
        'low': prices_1d - np.abs(np.random.randn(500)) * 500,
        'close': prices_1d,
        'volume': np.random.rand(500) * 10000,
    })
    df_1d['high'] = df_1d[['open', 'high', 'close']].max(axis=1)
    df_1d['low'] = df_1d[['open', 'low', 'close']].min(axis=1)

    donch = DonchianDailyS3Backtest(entry_lookback=20, exit_lookback=10, stop_atr=3.0)
    donch_signals = donch.generate_signals(df_1d)
    print(f'   DonchianS3 on synthetic 1D: {len(donch_signals)} signals')

    # Verify signal properties
    buy_count = sum(1 for s in donch_signals if s['direction'] == 'buy')
    sell_count = sum(1 for s in donch_signals if s['direction'] == 'sell')
    print(f'   Donchian buy/sell: {buy_count}/{sell_count}')
    assert_equal(sell_count <= buy_count, True, 'Donchian: sells <= buys (long-only)')

    # Verify buy signals are breakouts
    for sig in donch_signals:
        if sig['direction'] == 'buy':
            idx = sig['bar_idx']
            prior_closes = df_1d['close'].values[idx-20:idx]
            if len(prior_closes) == 20:
                assert_equal(sig['price'] > max(prior_closes), True,
                           f'Donchian buy at {idx}: close > prior 20-day high')

    # Verify alternating buy/sell pattern
    for i in range(1, len(donch_signals)):
        if donch_signals[i-1]['direction'] == 'sell':
            if i < len(donch_signals):
                assert_equal(donch_signals[i]['direction'], 'buy',
                           f'Donchian: sell followed by buy at signal {i}')


# ─── 4. EMA/ATR Indicator Parity ───────────────────────────────────────

def test_indicators():
    """Test EMA and ATR against known values."""
    print('\n4. Indicator Parity')

    # EMA test
    data = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0])
    ema_3 = ema(data, 3)

    # EMA(3) initial = avg(1,2,3) = 2.0
    assert_close(ema_3[2], 2.0, 0.001, 'EMA(3) initial')
    # Next: 4 * 0.5 + 2.0 * 0.5 = 3.0
    assert_close(ema_3[3], 3.0, 0.001, 'EMA(3) bar 3')
    print(f'   EMA(3) first 5: {ema_3[:5]}')

    # ATR test with simple data
    highs = np.array([10, 12, 11, 13, 12, 14, 13, 15, 14, 16], dtype=float)
    lows = np.array([8, 9, 9, 10, 10, 11, 11, 12, 12, 13], dtype=float)
    closes = np.array([9, 11, 10, 12, 11, 13, 12, 14, 13, 15], dtype=float)

    atr_3 = atr(highs, lows, closes, 3)
    # TR values: [2, 3, 2, 3, 2, 3, 2, 3, 2, 3]
    # ATR(3) initial = avg(2,3,2) = 2.333
    assert_close(atr_3[2], 7/3, 0.01, 'ATR(3) initial')
    print(f'   ATR(3) first 5: {atr_3[:5]}')


# ─── Run All ────────────────────────────────────────────────────────────

def main():
    print('='*60)
    print('CFM Backtest Parity Tests')
    print('='*60)

    test_fee_calculator()
    test_position_sizer()
    test_signal_parity()
    test_indicators()

    print(f'\n{"="*60}')
    print(f'Results: {PASS} passed, {FAIL} failed')
    print(f'{"="*60}')

    sys.exit(1 if FAIL > 0 else 0)


if __name__ == '__main__':
    main()
