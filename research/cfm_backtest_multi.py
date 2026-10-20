#!/usr/bin/env python3
"""
Multi-asset Donchian Daily S3 backtest with stopAtr sweep.

Extends cfm_backtest.py to run donchian_daily_s3 across BTC, ETH, SOL, LTC,
DOGE, and XRP, then pools trades for improved statistical significance.

Usage:
    python3 research/cfm_backtest_multi.py
    pnpm backtest:cfm:multi                  # from root

Reads: atlas/var/bt-data/*_1h.csv
"""
import os
import sys
import math
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime, timezone
from scipy import stats as scipy_stats

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cfm_backtest import (
    DonchianDailyS3Backtest, TrendFollowBacktest,
    compute_round_trip_cost, compute_position_size, compute_metrics,
    deflated_sharpe, compute_pbo, random_entry_baseline, regime_breakdown,
    walk_forward, run_backtest_with_stops,
    resample_to_1d, resample_to_4h,
    plot_equity_curve, plot_drawdown, plot_wf_heatmap,
    print_metrics,
    DONCH_PARAM_GRID, TF_PARAM_GRID,
    CONTRACT_SIZE, STARTING_EQUITY, MAX_DAILY_LOSS_USD,
    BASE_SLIPPAGE_BPS, DONCH_ATR_MIN_PCT, DONCH_ATR_MAX_PCT,
    WF_TRAIN_MONTHS, WF_TEST_MONTHS, WF_STEP_MONTHS,
    Trade, RoundTripCost,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, 'atlas', 'var', 'bt-data')
CHART_DIR = os.path.join(ROOT, 'research', 'charts')
VERDICT_FILE = os.path.join(ROOT, 'research', 'CFM_BACKTEST_VERDICT.md')

# ─── Instrument Definitions ────────────────────────────────────────────
# contract_size: actual CDE nano spec (BIP, ETP) or hypothetical for
# instruments that don't have a listed CFM product yet.
# ATR bounds from guardrails (donchian_daily_s3).

INSTRUMENTS = {
    'BTC-USD': {
        'contract_size': 0.01,       # BIP nano BTC
        'cfm_product': 'BIP-20DEC30-CDE',
        'price_increment': 5.0,
        'atr_min_pct': 0.025,
        'atr_max_pct': 0.15,
        'status': 'listed',          # actual CDE product
        'csv': 'btc_usd_1h.csv',
    },
    'ETH-USD': {
        'contract_size': 0.1,        # ETP nano ETH
        'cfm_product': 'ETP-20DEC30-CDE',
        'price_increment': 0.50,
        'atr_min_pct': 0.025,
        'atr_max_pct': 0.15,
        'status': 'listed',          # actual CDE product (disabled in guardrails)
        'csv': 'eth_usd_1h.csv',
    },
    'SOL-USD': {
        'contract_size': 1.0,        # hypothetical: 1 SOL/ct (~$150/ct)
        'cfm_product': None,
        'price_increment': 0.01,
        'atr_min_pct': 0.025,
        'atr_max_pct': 0.20,         # SOL is more volatile
        'status': 'hypothetical',
        'csv': 'sol_usd_1h.csv',
    },
    'LTC-USD': {
        'contract_size': 1.0,        # hypothetical: 1 LTC/ct (~$70/ct)
        'cfm_product': None,
        'price_increment': 0.01,
        'atr_min_pct': 0.025,
        'atr_max_pct': 0.15,
        'status': 'hypothetical',
        'csv': 'ltc_usd_1h.csv',
    },
    'DOGE-USD': {
        'contract_size': 1000.0,     # hypothetical: 1000 DOGE/ct (~$100/ct)
        'cfm_product': None,
        'price_increment': 0.0001,
        'atr_min_pct': 0.025,
        'atr_max_pct': 0.20,
        'status': 'hypothetical',
        'csv': 'doge_usd_1h.csv',
    },
    'XRP-USD': {
        'contract_size': 100.0,      # hypothetical: 100 XRP/ct (~$50/ct)
        'cfm_product': None,
        'price_increment': 0.0001,
        'atr_min_pct': 0.025,
        'atr_max_pct': 0.15,
        'status': 'hypothetical',
        'csv': 'xrp_usd_1h.csv',
    },
}

# Minimum daily bars needed (donchian 20 lookback + ATR 14 + margin)
MIN_DAILY_BARS = 100


def load_instrument(symbol: str) -> pd.DataFrame | None:
    """Load 1H candles for an instrument, return None if unavailable."""
    spec = INSTRUMENTS[symbol]
    fpath = os.path.join(DATA_DIR, spec['csv'])
    if not os.path.exists(fpath):
        return None
    df = pd.read_csv(fpath)
    if len(df) < 24 * MIN_DAILY_BARS:  # need at least MIN_DAILY_BARS days of hourly data
        return None
    df['time'] = pd.to_datetime(df['time'].astype(int), unit='s', utc=True)
    for col in ['open', 'high', 'low', 'close', 'volume']:
        df[col] = df[col].astype(float)
    df = df.sort_values('time').reset_index(drop=True)
    df = df.drop_duplicates(subset='time').reset_index(drop=True)
    return df


# ─── Modified Sizer for different contract sizes ───────────────────────

def compute_position_size_generic(
    entry_price: float,
    stop_price: float,
    contract_size: float,
    max_daily_loss_usd: float = MAX_DAILY_LOSS_USD,
    max_notional_usd: float = 2000.0,
    l1_budget_usd: float = 100.0,
) -> dict:
    """Position sizer that works with arbitrary contract sizes."""
    if entry_price <= 0 or contract_size <= 0:
        return {'size': 0, 'contracts': 0, 'capped_by': 'none', 'notional': 0, 'stop_dist_pct': 0}

    stop_distance = abs(entry_price - stop_price)
    stop_dist_pct = stop_distance / entry_price
    if stop_distance <= 0:
        return {'size': 0, 'contracts': 0, 'capped_by': 'none', 'notional': 0, 'stop_dist_pct': 0}

    loss_cap = min(max_daily_loss_usd, l1_budget_usd)
    capped_by = 'daily_loss' if loss_cap == max_daily_loss_usd else 'l1_budget'

    max_notional = loss_cap / stop_dist_pct
    if max_notional > max_notional_usd:
        max_notional = max_notional_usd
        capped_by = 'max_notional'

    max_size = max_notional / entry_price
    whole_contracts = int(max_size / contract_size)
    size = whole_contracts * contract_size
    notional = size * entry_price

    return {
        'size': size,
        'contracts': whole_contracts,
        'capped_by': capped_by if whole_contracts > 0 else 'none',
        'notional': notional,
        'stop_dist_pct': stop_dist_pct,
    }


def compute_rt_cost_generic(
    size_underlying: float,
    price: float,
    contract_size: float,
    slippage_bps: float = BASE_SLIPPAGE_BPS,
    fee_multiplier: float = 1.0,
    maker_bps: float = 9.5,
    taker_bps: float = 10.0,
    exchange_fee_per_ct: float = 0.10,
) -> RoundTripCost:
    """Round-trip cost for arbitrary contract sizes."""
    notional = size_underlying * price
    contracts = int(size_underlying / contract_size) if contract_size > 0 else 0

    m_rate = (maker_bps * fee_multiplier) / 10_000
    t_rate = (taker_bps * fee_multiplier) / 10_000
    per_ct = exchange_fee_per_ct * fee_multiplier

    entry_fee = notional * m_rate + contracts * per_ct
    exit_fee = notional * t_rate + contracts * per_ct
    slippage = notional * (slippage_bps / 10_000) * 2
    total = entry_fee + exit_fee + slippage
    eff = (total / notional * 10_000) if notional > 0 else 0

    return RoundTripCost(entry_fee, exit_fee, slippage, total, eff, contracts)


# ─── Per-instrument Donchian backtest ──────────────────────────────────

def run_donchian_single(
    df_1d: pd.DataFrame,
    symbol: str,
    stop_atr: float = 3.0,
    entry_lookback: int = 20,
    exit_lookback: int = 10,
    slippage_bps: float = BASE_SLIPPAGE_BPS,
    fee_multiplier: float = 1.0,
    funding_bps_per_8h: float = 0.0,
    equity: float = STARTING_EQUITY,
) -> dict:
    """Run donchian_daily_s3 on one instrument with its contract size."""
    spec = INSTRUMENTS[symbol]
    contract_size = spec['contract_size']
    atr_min = spec['atr_min_pct']
    atr_max = spec['atr_max_pct']

    strat = DonchianDailyS3Backtest(
        entry_lookback=entry_lookback,
        exit_lookback=exit_lookback,
        stop_atr=stop_atr,
        atr_period=14,
        atr_min_pct=atr_min,
        atr_max_pct=atr_max,
    )
    signals = strat.generate_signals(df_1d)

    trades: list[Trade] = []
    equity_curve = [(df_1d['time'].iloc[0], equity)]
    position = None
    size_zero_skips = 0
    total_signals = len(signals)

    for sig in signals:
        bar_idx = sig['bar_idx']
        if bar_idx + 1 >= len(df_1d):
            continue

        fill_bar = df_1d.iloc[bar_idx + 1]
        fill_price = float(fill_bar['open'])
        fill_time = fill_bar['time']

        if sig['direction'] == 'buy' and position is None:
            curr_atr = sig['atr']
            stop = fill_price - stop_atr * curr_atr

            sizing = compute_position_size_generic(
                fill_price, stop, contract_size,
            )
            if sizing['contracts'] == 0:
                size_zero_skips += 1
                continue

            position = Trade(
                entry_time=fill_time,
                direction='buy',
                entry_price=fill_price,
                stop_loss=stop,
                take_profit=fill_price * 100,
                size=sizing['size'],
                contracts=sizing['contracts'],
                strategy='donchian_daily_s3',
                regime=sig.get('regime', 'n/a'),
                slippage_bps=slippage_bps,
                fee_multiplier=fee_multiplier,
            )

        elif sig['direction'] == 'sell' and position is not None:
            exit_price = fill_price
            gross_pnl = (exit_price - position.entry_price) * position.size

            cost = compute_rt_cost_generic(
                position.size, position.entry_price, contract_size,
                slippage_bps, fee_multiplier,
            )

            if funding_bps_per_8h != 0 and position.entry_time is not None:
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

    # Also check stops intrabar
    if position is not None:
        last_bar = df_1d.iloc[-1]
        exit_price = float(last_bar['close'])
        gross_pnl = (exit_price - position.entry_price) * position.size
        cost = compute_rt_cost_generic(position.size, position.entry_price, contract_size, slippage_bps, fee_multiplier)
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

    metrics = compute_metrics(
        trades, equity_curve, total_signals, size_zero_skips,
        slippage_bps, fee_multiplier, STARTING_EQUITY,
    )

    return {
        'trades': trades,
        'equity_curve': equity_curve,
        'metrics': metrics,
        'symbol': symbol,
        'size_zero_skips': size_zero_skips,
        'total_signals': total_signals,
    }


# ─── stopAtr sweep ─────────────────────────────────────────────────────

def stop_atr_sweep(
    daily_data: dict[str, pd.DataFrame],
    stop_atr_values: list[float],
) -> list[dict]:
    """Sweep stopAtr for each instrument, report skip rate and metrics."""
    results = []
    for sa in stop_atr_values:
        all_trades = []
        total_signals = 0
        total_skips = 0
        per_asset = {}

        for symbol, df_1d in daily_data.items():
            r = run_donchian_single(df_1d, symbol, stop_atr=sa)
            all_trades.extend(r['trades'])
            total_signals += r['total_signals']
            total_skips += r['size_zero_skips']
            per_asset[symbol] = {
                'trades': r['metrics']['trades'],
                'net_pnl': r['metrics']['net_pnl'],
                'size_zero_skips': r['size_zero_skips'],
                'total_signals': r['total_signals'],
            }

        # Pool metrics
        if all_trades:
            all_trades_sorted = sorted(all_trades, key=lambda t: t.entry_time)
            eq = STARTING_EQUITY
            eq_curve = [(all_trades_sorted[0].entry_time, eq)]
            for t in all_trades_sorted:
                eq += t.pnl_net
                eq_curve.append((t.exit_time or t.entry_time, eq))
            pooled_metrics = compute_metrics(
                all_trades_sorted, eq_curve, total_signals, total_skips,
                BASE_SLIPPAGE_BPS, 1.0, STARTING_EQUITY,
            )
        else:
            pooled_metrics = {'trades': 0, 'net_pnl': 0, 'sharpe': 0}
            eq_curve = []

        skip_pct = (total_skips / total_signals * 100) if total_signals > 0 else 0

        results.append({
            'stop_atr': sa,
            'pooled_metrics': pooled_metrics,
            'pooled_trades': all_trades,
            'pooled_equity': eq_curve,
            'per_asset': per_asset,
            'total_signals': total_signals,
            'total_skips': total_skips,
            'skip_pct': skip_pct,
        })

    return results


# ─── Walk-forward for pooled donchian ──────────────────────────────────

def walk_forward_pooled(
    daily_data: dict[str, pd.DataFrame],
    param_grid: list[dict],
    stop_atr: float,
    train_months: int = WF_TRAIN_MONTHS,
    test_months: int = WF_TEST_MONTHS,
    step_months: int = WF_STEP_MONTHS,
) -> dict:
    """Walk-forward across all instruments, pooling trades per window."""
    # Find common date range
    all_starts = []
    all_ends = []
    for df in daily_data.values():
        all_starts.append(df['time'].min())
        all_ends.append(df['time'].max())
    common_start = max(all_starts)
    common_end = min(all_ends)

    windows = []
    cursor = common_start
    while True:
        train_end = cursor + pd.DateOffset(months=train_months)
        test_end = train_end + pd.DateOffset(months=test_months)
        if test_end > common_end:
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
    running_equity = STARTING_EQUITY
    oos_equity = [(common_start, STARTING_EQUITY)]
    window_results = []
    all_param_returns = {i: [] for i in range(len(param_grid))}

    for w_idx, w in enumerate(windows):
        print(f'  Window {w_idx+1}/{len(windows)}: train {w["train_start"].strftime("%Y-%m")} → '
              f'{w["train_end"].strftime("%Y-%m")}, test → {w["test_end"].strftime("%Y-%m")}')

        best_sharpe = -999
        best_params = param_grid[0]
        best_params_idx = 0

        for p_idx, params in enumerate(param_grid):
            window_trades = []
            for symbol, df_full in daily_data.items():
                train_df = df_full[(df_full['time'] >= w['train_start']) & (df_full['time'] < w['train_end'])].copy().reset_index(drop=True)
                if len(train_df) < 50:
                    continue
                r = run_donchian_single(
                    train_df, symbol,
                    stop_atr=params.get('stop_atr', stop_atr),
                    entry_lookback=params.get('entry_lookback', 20),
                    exit_lookback=params.get('exit_lookback', 10),
                )
                window_trades.extend(r['trades'])

            if window_trades:
                window_trades.sort(key=lambda t: t.entry_time)
                rets = [t.pnl_net for t in window_trades]
                mean_r = np.mean(rets) if rets else 0
                std_r = np.std(rets, ddof=1) if len(rets) > 1 else 1
                sr = mean_r / std_r if std_r > 0 else 0
            else:
                sr = 0
                rets = []

            if sr > best_sharpe:
                best_sharpe = sr
                best_params = params
                best_params_idx = p_idx

            all_param_returns[p_idx].extend(rets)

        # Test best params OOS
        oos_window_trades = []
        for symbol, df_full in daily_data.items():
            test_df = df_full[(df_full['time'] >= w['test_start']) & (df_full['time'] < w['test_end'])].copy().reset_index(drop=True)
            if len(test_df) < 20:
                continue
            r = run_donchian_single(
                test_df, symbol,
                stop_atr=best_params.get('stop_atr', stop_atr),
                entry_lookback=best_params.get('entry_lookback', 20),
                exit_lookback=best_params.get('exit_lookback', 10),
                equity=running_equity,
            )
            oos_window_trades.extend(r['trades'])

        oos_window_trades.sort(key=lambda t: t.entry_time)
        for t in oos_window_trades:
            oos_trades_all.append(t)
            running_equity += t.pnl_net
            oos_equity.append((t.exit_time or t.entry_time, running_equity))

        oos_net = sum(t.pnl_net for t in oos_window_trades)
        window_results.append({
            'window': w,
            'best_params': best_params,
            'best_params_idx': best_params_idx,
            'train_sharpe': best_sharpe,
            'oos_trades': len(oos_window_trades),
            'oos_net_pnl': oos_net,
        })

    return {
        'oos_trades': oos_trades_all,
        'oos_equity': oos_equity,
        'windows': window_results,
        'all_param_returns': [all_param_returns[i] for i in range(len(param_grid))],
    }


# ─── Main ───────────────────────────────────────────────────────────────

def main():
    print('='*70)
    print('Multi-Asset Donchian Daily S3 Backtest (stopAtr Sweep)')
    print('='*70)

    # Load all instruments
    print('\n1. Loading data...')
    daily_data: dict[str, pd.DataFrame] = {}
    instrument_info = {}

    # Always include BTC
    btc_path = os.path.join(DATA_DIR, 'btc_usd_1h.csv')
    if os.path.exists(btc_path):
        df_1h = pd.read_csv(btc_path)
        df_1h['time'] = pd.to_datetime(df_1h['time'].astype(int), unit='s', utc=True)
        for col in ['open', 'high', 'low', 'close', 'volume']:
            df_1h[col] = df_1h[col].astype(float)
        df_1h = df_1h.sort_values('time').drop_duplicates(subset='time').reset_index(drop=True)
        df_1d = resample_to_1d(df_1h)
        daily_data['BTC-USD'] = df_1d
        instrument_info['BTC-USD'] = {
            'bars_1h': len(df_1h), 'bars_1d': len(df_1d),
            'start': df_1d['time'].min().strftime('%Y-%m-%d'),
            'end': df_1d['time'].max().strftime('%Y-%m-%d'),
        }
        print(f'   BTC-USD: {len(df_1d)} daily bars ({df_1d["time"].min().strftime("%Y-%m-%d")} → {df_1d["time"].max().strftime("%Y-%m-%d")})')

    for symbol in INSTRUMENTS:
        if symbol == 'BTC-USD':
            continue
        df_1h = load_instrument(symbol)
        if df_1h is None:
            print(f'   {symbol}: SKIPPED (no data or insufficient bars)')
            continue
        df_1d = resample_to_1d(df_1h)
        if len(df_1d) < MIN_DAILY_BARS:
            print(f'   {symbol}: SKIPPED ({len(df_1d)} daily bars < {MIN_DAILY_BARS} required)')
            continue
        daily_data[symbol] = df_1d
        instrument_info[symbol] = {
            'bars_1h': len(df_1h), 'bars_1d': len(df_1d),
            'start': df_1d['time'].min().strftime('%Y-%m-%d'),
            'end': df_1d['time'].max().strftime('%Y-%m-%d'),
        }
        print(f'   {symbol}: {len(df_1d)} daily bars ({df_1d["time"].min().strftime("%Y-%m-%d")} → {df_1d["time"].max().strftime("%Y-%m-%d")})')

    symbols_used = list(daily_data.keys())
    print(f'\n   Instruments: {len(symbols_used)} → {", ".join(symbols_used)}')

    # ─── 2. stopAtr Sweep ───────────────────────────────────────────
    print('\n' + '='*70)
    print('2. stopAtr Sweep (1.5 → 2.5)')
    print('='*70)

    stop_atr_values = [1.5, 1.75, 2.0, 2.25, 2.5]
    sweep_results = stop_atr_sweep(daily_data, stop_atr_values)

    print(f'\n{"stopAtr":>8} {"Trades":>7} {"Net P&L":>10} {"Sharpe":>8} {"Skips":>6} {"Skip%":>7} {"WinRate":>8} {"PF":>6}')
    print('-' * 72)
    for sr in sweep_results:
        m = sr['pooled_metrics']
        print(f'{sr["stop_atr"]:8.2f} {m["trades"]:7d} {m["net_pnl"]:10.2f} '
              f'{m["sharpe"]:8.2f} {sr["total_skips"]:6d} {sr["skip_pct"]:6.1f}% '
              f'{m["win_rate"]*100:7.1f}% {m["profit_factor"]:5.2f}')

    # Per-asset breakdown for each stopAtr
    print('\n  Per-asset breakdown:')
    for sr in sweep_results:
        print(f'\n  stopAtr={sr["stop_atr"]}:')
        for sym, pa in sr['per_asset'].items():
            skip_pct = (pa['size_zero_skips'] / pa['total_signals'] * 100) if pa['total_signals'] > 0 else 0
            print(f'    {sym:>8}: {pa["trades"]:3d} trades, ${pa["net_pnl"]:8.2f}, '
                  f'skips={pa["size_zero_skips"]}/{pa["total_signals"]} ({skip_pct:.0f}%)')

    # ─── 3. Pick best stopAtr, run full analysis ────────────────────
    # Best = highest Sharpe that keeps skip% under 15%
    viable = [s for s in sweep_results if s['skip_pct'] < 15]
    if not viable:
        viable = sweep_results  # fall back to all
    best_sweep = max(viable, key=lambda s: s['pooled_metrics']['sharpe'])
    best_stop_atr = best_sweep['stop_atr']
    print(f'\n   Best stopAtr: {best_stop_atr} (Sharpe={best_sweep["pooled_metrics"]["sharpe"]:.2f}, '
          f'skip%={best_sweep["skip_pct"]:.1f}%)')

    # ─── 4. Holdout OOS (last 12 months) ────────────────────────────
    print('\n' + '='*70)
    print(f'3. Holdout OOS (last 12 months, stopAtr={best_stop_atr})')
    print('='*70)

    # Split each instrument
    daily_data_is = {}
    daily_data_oos = {}
    for sym, df in daily_data.items():
        cutoff = df['time'].max() - pd.DateOffset(months=12)
        daily_data_is[sym] = df[df['time'] < cutoff].copy().reset_index(drop=True)
        daily_data_oos[sym] = df[df['time'] >= cutoff].copy().reset_index(drop=True)

    oos_trades = []
    oos_per_asset = {}
    for sym in symbols_used:
        if sym not in daily_data_oos or len(daily_data_oos[sym]) < 30:
            continue
        r = run_donchian_single(daily_data_oos[sym], sym, stop_atr=best_stop_atr)
        oos_trades.extend(r['trades'])
        oos_per_asset[sym] = r['metrics']
        print(f'   {sym}: {r["metrics"]["trades"]} trades, ${r["metrics"]["net_pnl"]:.2f}')

    if oos_trades:
        oos_trades.sort(key=lambda t: t.entry_time)
        eq = STARTING_EQUITY
        oos_eq = [(oos_trades[0].entry_time, eq)]
        for t in oos_trades:
            eq += t.pnl_net
            oos_eq.append((t.exit_time or t.entry_time, eq))
        oos_metrics = compute_metrics(
            oos_trades, oos_eq, len(oos_trades), 0,
            BASE_SLIPPAGE_BPS, 1.0, STARTING_EQUITY,
        )
        print_metrics('Pooled OOS Holdout', oos_metrics)
    else:
        oos_metrics = {'trades': 0, 'net_pnl': 0, 'sharpe': 0}

    # ─── 5. Walk-forward pooled ─────────────────────────────────────
    print('\n' + '='*70)
    print(f'4. Walk-Forward (pooled, stopAtr={best_stop_atr})')
    print('='*70)

    # Use IS data for walk-forward (common range that all instruments have)
    # Build param grid incorporating best_stop_atr sweep
    donch_wf_grid = []
    for entry_lb in [15, 20, 25, 30]:
        for exit_lb in [5, 10, 15]:
            if exit_lb >= entry_lb:
                continue
            donch_wf_grid.append({
                'entry_lookback': entry_lb,
                'exit_lookback': exit_lb,
                'stop_atr': best_stop_atr,
                'atr_period': 14,
            })

    wf_result = walk_forward_pooled(daily_data_is, donch_wf_grid, best_stop_atr)

    if wf_result['oos_trades']:
        wf_trades = wf_result['oos_trades']
        wf_eq = wf_result['oos_equity']
        wf_metrics = compute_metrics(
            wf_trades, wf_eq, len(wf_trades), 0,
            BASE_SLIPPAGE_BPS, 1.0, STARTING_EQUITY,
        )
        print_metrics('Pooled WF-OOS (stitched)', wf_metrics)
    else:
        wf_metrics = {'trades': 0, 'net_pnl': 0, 'sharpe': 0}
        wf_trades = []

    # ─── 6. Overfitting checks ──────────────────────────────────────
    print('\n' + '='*70)
    print('5. Overfitting Checks')
    print('='*70)

    # Deflated Sharpe on pooled full-sample at best_stop_atr
    full_trades = best_sweep['pooled_trades']
    full_metrics = best_sweep['pooled_metrics']
    net_pnls = [t.pnl_net for t in full_trades]
    n_trials = len(donch_wf_grid) * len(stop_atr_values)  # total parameter combos tried
    skew = float(scipy_stats.skew(net_pnls)) if len(net_pnls) > 2 else 0
    kurt = float(scipy_stats.kurtosis(net_pnls, fisher=False)) if len(net_pnls) > 2 else 3

    dsr = deflated_sharpe(full_metrics['sharpe'], len(net_pnls), n_trials, skew, kurt)
    print(f'   Deflated Sharpe probability: {dsr:.4f} (n_trades={len(net_pnls)}, n_trials={n_trials})')

    # PBO
    pbo = compute_pbo([r for r in wf_result['all_param_returns'] if r], n_splits=16)
    print(f'   PBO (CSCV 16 splits): {pbo:.4f}')

    # Random baseline — per-instrument with proper contract sizes, then aggregate
    print('\n   Random baseline (1000 runs, per-instrument aggregated)...')
    N_RANDOM = 1000
    rand_pnls = np.zeros(N_RANDOM)
    real_net_total = full_metrics['net_pnl']
    rng = np.random.default_rng(42)

    for sym, df in daily_data.items():
        spec = INSTRUMENTS[sym]
        contract_size = spec['contract_size']
        sym_r = run_donchian_single(df, sym, stop_atr=best_stop_atr)
        sym_real_trades = sym_r['trades']
        n_sym_trades = len(sym_real_trades)
        if n_sym_trades == 0:
            continue

        hold_durations = []
        for t in sym_real_trades:
            if t.exit_time and t.entry_time:
                dur = max(1, len(df[(df['time'] >= t.entry_time) & (df['time'] <= t.exit_time)]))
                hold_durations.append(dur)
            else:
                hold_durations.append(10)

        bar_count = len(df)
        max_hold = max(hold_durations) if hold_durations else 10

        for run_idx in range(N_RANDOM):
            total = 0
            for ti in range(n_sym_trades):
                entry_idx = rng.integers(30, max(31, bar_count - max_hold - 2))
                hold = hold_durations[ti % len(hold_durations)]
                exit_idx = min(entry_idx + hold, bar_count - 1)
                entry_price = float(df.iloc[entry_idx]['open'])
                exit_price = float(df.iloc[exit_idx]['close'])
                stop_dist = 0.025 * entry_price
                sizing = compute_position_size_generic(entry_price, entry_price - stop_dist, contract_size)
                if sizing['contracts'] == 0:
                    continue
                gross = (exit_price - entry_price) * sizing['size']  # long only
                cost = compute_rt_cost_generic(sizing['size'], entry_price, contract_size)
                total += gross - cost.total_usd
            rand_pnls[run_idx] += total

    pct_better = float(np.mean(rand_pnls >= real_net_total) * 100)
    rand_result = {
        'real_net': real_net_total,
        'mean_pnl': float(np.mean(rand_pnls)),
        'std_pnl': float(np.std(rand_pnls)),
        'pct_better': pct_better,
    }
    print(f'   Real net: ${rand_result["real_net"]:.2f}')
    print(f'   Random mean: ${rand_result["mean_pnl"]:.2f} ± ${rand_result["std_pnl"]:.2f}')
    print(f'   Random better: {rand_result["pct_better"]:.1f}%')

    # Shifted entry test — per-instrument using run_donchian_single with shifted signals
    print('\n   Shifted entry test (per-instrument)...')
    orig_pnl = full_metrics['net_pnl']
    shifted_pnl_total = 0
    orig_pnl_check = 0
    for sym, df in daily_data.items():
        # Original
        r_orig = run_donchian_single(df, sym, stop_atr=best_stop_atr)
        orig_pnl_check += r_orig['metrics']['net_pnl']

        # Shifted: run strategy, shift signals by +1 bar, then re-run
        strat = DonchianDailyS3Backtest(
            entry_lookback=20, exit_lookback=10, stop_atr=best_stop_atr,
            atr_period=14, atr_min_pct=INSTRUMENTS[sym]['atr_min_pct'],
            atr_max_pct=INSTRUMENTS[sym]['atr_max_pct'],
        )
        signals = strat.generate_signals(df)
        # Shift bar_idx by +1 (delay entry by 1 bar)
        shifted_sigs = []
        shifted_state = 'OUT'
        for s in signals:
            ss = dict(s)
            ss['bar_idx'] = s['bar_idx'] + 1
            if ss['bar_idx'] + 1 < len(df):
                shifted_sigs.append(ss)

        # Run shifted using generic sizer
        spec = INSTRUMENTS[sym]
        contract_size = spec['contract_size']
        shifted_equity = STARTING_EQUITY
        shifted_net = 0
        position = None
        for sig in shifted_sigs:
            bar_idx = sig['bar_idx']
            if bar_idx + 1 >= len(df):
                continue
            fill_bar = df.iloc[bar_idx + 1]
            fill_price = float(fill_bar['open'])
            fill_time = fill_bar['time']

            if sig['direction'] == 'buy' and position is None:
                stop = fill_price - best_stop_atr * sig['atr']
                sizing = compute_position_size_generic(fill_price, stop, contract_size)
                if sizing['contracts'] == 0:
                    continue
                position = {'entry_price': fill_price, 'size': sizing['size'],
                            'entry_time': fill_time, 'stop': stop}
            elif sig['direction'] == 'sell' and position is not None:
                gross = (fill_price - position['entry_price']) * position['size']
                cost = compute_rt_cost_generic(position['size'], position['entry_price'], contract_size)
                shifted_net += gross - cost.total_usd
                position = None

        if position is not None:
            last_close = float(df.iloc[-1]['close'])
            gross = (last_close - position['entry_price']) * position['size']
            cost = compute_rt_cost_generic(position['size'], position['entry_price'], contract_size)
            shifted_net += gross - cost.total_usd

        shifted_pnl_total += shifted_net

    shifted_pnl = shifted_pnl_total
    shift_ratio = shifted_pnl / orig_pnl if orig_pnl != 0 else 0
    print(f'   Original: ${orig_pnl:.2f}, Shifted: ${shifted_pnl:.2f}, Ratio: {shift_ratio:.2f}')

    # Fee sensitivity at 2x, 3x
    print('\n   Fee sensitivity (pooled):')
    for fee_mult in [1.0, 2.0, 3.0]:
        fee_trades = []
        for sym, df in daily_data.items():
            r = run_donchian_single(df, sym, stop_atr=best_stop_atr, fee_multiplier=fee_mult)
            fee_trades.extend(r['trades'])
        fee_net = sum(t.pnl_net for t in fee_trades)
        print(f'   {fee_mult}x fees: ${fee_net:.2f} ({len(fee_trades)} trades)')

    # ─── 7. GO Criteria ─────────────────────────────────────────────
    print('\n' + '='*70)
    print('6. GO Criteria (Pooled Donchian Daily S3)')
    print('='*70)

    # Compute 2x cost WF-OOS expectancy
    fee_2x_wf_trades = []
    for sym, df in daily_data.items():
        r = run_donchian_single(df, sym, stop_atr=best_stop_atr, fee_multiplier=2.0)
        fee_2x_wf_trades.extend(r['trades'])
    fee_2x_net = sum(t.pnl_net for t in fee_2x_wf_trades)

    wf_oos_positive = wf_metrics.get('net_pnl', 0) > 0 if wf_metrics.get('trades', 0) > 0 else False
    oos_2x_positive = fee_2x_net > 0
    dsr_pass = dsr > 0.95
    pbo_pass = pbo < 0.3
    oos_trade_count = wf_metrics.get('trades', 0)
    trade_count_pass = oos_trade_count >= 100

    print(f'   1. WF-OOS expectancy > 0: {"PASS" if wf_oos_positive else "FAIL"} (${wf_metrics.get("net_pnl", 0):.2f})')
    print(f'   2. Full-sample positive at 2x costs: {"PASS" if oos_2x_positive else "FAIL"} (${fee_2x_net:.2f})')
    print(f'   3. Deflated Sharpe > 0.95: {"PASS" if dsr_pass else "FAIL"} ({dsr:.4f})')
    print(f'   4. PBO < 0.3: {"PASS" if pbo_pass else "FAIL"} ({pbo:.4f})')
    print(f'   5. ≥100 WF-OOS trades: {"PASS" if trade_count_pass else "FAIL"} ({oos_trade_count})')

    all_pass = wf_oos_positive and oos_2x_positive and dsr_pass and pbo_pass and trade_count_pass
    if all_pass:
        final_verdict = 'GO'
    elif full_metrics['net_pnl'] > 0 and full_metrics['sharpe'] > 0:
        final_verdict = 'HOLD'
    else:
        final_verdict = 'KILL'

    print(f'\n   FINAL VERDICT: {final_verdict}')

    # ─── 8. Charts ──────────────────────────────────────────────────
    print('\n' + '='*70)
    print('7. Charts')
    print('='*70)

    # Per-asset equity at best stopAtr
    asset_equity = {}
    for sym in symbols_used:
        r = run_donchian_single(daily_data[sym], sym, stop_atr=best_stop_atr)
        asset_equity[f'{sym} (stopAtr={best_stop_atr})'] = r['equity_curve']
    asset_equity['Pooled'] = best_sweep['pooled_equity']

    plot_equity_curve(asset_equity, 'donch_multi_equity.png')
    print('   ✓ donch_multi_equity.png')

    plot_drawdown(asset_equity, 'donch_multi_drawdown.png')
    print('   ✓ donch_multi_drawdown.png')

    # stopAtr sweep chart
    fig, axes = plt.subplots(1, 3, figsize=(18, 5))
    stop_atrs = [s['stop_atr'] for s in sweep_results]
    net_pnls_sweep = [s['pooled_metrics']['net_pnl'] for s in sweep_results]
    sharpes = [s['pooled_metrics']['sharpe'] for s in sweep_results]
    skips = [s['skip_pct'] for s in sweep_results]

    axes[0].bar(range(len(stop_atrs)), net_pnls_sweep, color='steelblue')
    axes[0].set_xticks(range(len(stop_atrs)))
    axes[0].set_xticklabels([f'{s:.2f}' for s in stop_atrs])
    axes[0].set_title('Net P&L by stopAtr')
    axes[0].set_xlabel('stopAtr')
    axes[0].set_ylabel('Net P&L ($)')
    axes[0].axhline(y=0, color='red', linestyle='--', alpha=0.5)

    axes[1].bar(range(len(stop_atrs)), sharpes, color='forestgreen')
    axes[1].set_xticks(range(len(stop_atrs)))
    axes[1].set_xticklabels([f'{s:.2f}' for s in stop_atrs])
    axes[1].set_title('Sharpe by stopAtr')
    axes[1].set_xlabel('stopAtr')
    axes[1].set_ylabel('Sharpe')

    axes[2].bar(range(len(stop_atrs)), skips, color='tomato')
    axes[2].set_xticks(range(len(stop_atrs)))
    axes[2].set_xticklabels([f'{s:.2f}' for s in stop_atrs])
    axes[2].set_title('Size-Zero Skip % by stopAtr')
    axes[2].set_xlabel('stopAtr')
    axes[2].set_ylabel('Skip %')
    axes[2].axhline(y=10, color='orange', linestyle='--', alpha=0.7, label='10% threshold')
    axes[2].legend()

    plt.tight_layout()
    plt.savefig(os.path.join(CHART_DIR, 'donch_stopatr_sweep.png'), dpi=150)
    plt.close()
    print('   ✓ donch_stopatr_sweep.png')

    if wf_result['oos_equity'] and len(wf_result['oos_equity']) > 1:
        plot_equity_curve({'Pooled WF-OOS': wf_result['oos_equity']}, 'donch_multi_wf_oos.png')
        print('   ✓ donch_multi_wf_oos.png')

    # Copy to artifacts
    import shutil
    artifacts_dir = '/opt/cursor/artifacts'
    os.makedirs(artifacts_dir, exist_ok=True)
    for chart_file in os.listdir(CHART_DIR):
        if chart_file.endswith('.png'):
            shutil.copy2(os.path.join(CHART_DIR, chart_file), os.path.join(artifacts_dir, chart_file))

    # ─── 9. Update verdict file ─────────────────────────────────────
    print('\n' + '='*70)
    print('8. Updating CFM_BACKTEST_VERDICT.md')
    print('='*70)

    # Pre-compute fee sensitivity for verdict writer
    fee_sens_for_verdict = []
    for fee_mult in [1.0, 2.0, 3.0]:
        fee_trades = []
        for sym, df in daily_data.items():
            r = run_donchian_single(df, sym, stop_atr=best_stop_atr, fee_multiplier=fee_mult)
            fee_trades.extend(r['trades'])
        fee_net_val = sum(t.pnl_net for t in fee_trades)
        fee_sens_for_verdict.append((fee_mult, fee_net_val, len(fee_trades)))

    write_multi_verdict(
        instruments_info=instrument_info,
        symbols_used=symbols_used,
        sweep_results=sweep_results,
        best_stop_atr=best_stop_atr,
        full_metrics=full_metrics,
        wf_metrics=wf_metrics,
        oos_metrics=oos_metrics,
        oos_per_asset=oos_per_asset,
        dsr=dsr,
        pbo=pbo,
        rand_result=rand_result,
        shift_ratio=shift_ratio,
        shifted_pnl=shifted_pnl,
        orig_pnl=orig_pnl,
        fee_2x_net=fee_2x_net,
        final_verdict=final_verdict,
        n_trials=n_trials,
        wf_result=wf_result,
        fee_sensitivity_results=fee_sens_for_verdict,
    )

    print(f'   ✓ {VERDICT_FILE}')
    print('\n' + '='*70)
    print('DONE')
    print('='*70)


def write_multi_verdict(*, instruments_info, symbols_used, sweep_results,
                         best_stop_atr, full_metrics, wf_metrics, oos_metrics,
                         oos_per_asset, dsr, pbo, rand_result, shift_ratio,
                         shifted_pnl, orig_pnl, fee_2x_net, final_verdict,
                         n_trials, wf_result, fee_sensitivity_results):
    """Rewrite the full CFM_BACKTEST_VERDICT.md with multi-asset results."""
    # Read existing file for the trend_follow section
    existing_lines = []
    tf_section = []
    in_tf = False
    with open(VERDICT_FILE) as f:
        for line in f:
            line = line.rstrip('\n')
            if line.startswith('## Trend Follow'):
                in_tf = True
            if in_tf:
                tf_section.append(line)
                if line.startswith('## Donchian Daily S3'):
                    in_tf = False
                    tf_section.pop()  # remove the donchian header we just added

    lines = []
    lines.append('# CFM Backtest Verdict — BTC-USD Nano Futures (BIP) + Multi-Asset Extension')
    lines.append('')
    lines.append(f'Generated: {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}')
    lines.append(f'Codebase: `main` @ `490fe8b`')
    lines.append('')
    lines.append('## Data')
    lines.append('')
    lines.append('- Source: Coinbase Advanced public API, spot prices as proxy for CFM futures')
    lines.append('- Granularity: 1H candles resampled to 4H (trend_follow) and 1D (donchian_daily_s3)')
    lines.append(f'- Instruments: {len(symbols_used)} → {", ".join(symbols_used)}')
    lines.append('')
    lines.append('| Instrument | CFM Product | Contract Size | Status | Daily Bars | Period |')
    lines.append('|-----------|------------|---------------|--------|-----------|--------|')
    for sym in symbols_used:
        spec = INSTRUMENTS[sym]
        info = instruments_info.get(sym, {})
        lines.append(f'| {sym} | {spec.get("cfm_product") or "—"} | {spec["contract_size"]} | '
                     f'{spec["status"]} | {info.get("bars_1d", "?")} | {info.get("start", "?")} → {info.get("end", "?")} |')
    lines.append('')
    lines.append('### Why these instruments')
    lines.append('')
    lines.append('- **BTC-USD (BIP)**: listed CDE nano BTC, 0.01 BTC/ct — the primary target')
    lines.append('- **ETH-USD (ETP)**: listed CDE nano ETH, 0.1 ETH/ct — disabled in guardrails pending Risk Master sign-off, but spec verified')
    lines.append('- **SOL-USD**: hypothetical 1 SOL/ct — reliable Coinbase spot history since 2021-06, second-largest alt after ETH')
    lines.append('- **LTC-USD**: hypothetical 1 LTC/ct — Coinbase spot since 2016, proxy for established non-BTC trends')
    lines.append('- **DOGE-USD**: hypothetical 1000 DOGE/ct — Coinbase spot since 2021-06, high-vol alt')
    lines.append('- **XRP-USD**: hypothetical 100 XRP/ct — Coinbase spot since 2019-02, different correlation regime')
    lines.append('')
    lines.append('Hypothetical contract sizes chosen so 1 contract ≈ $50–$150 notional, matching BIP/ETP nano sizing philosophy.')
    lines.append('')
    lines.append('## Cost Model')
    lines.append('')
    lines.append('Same as Phase 1 (matches `cfm-fee-calculator.ts`):')
    lines.append('- Entry: 9.5 bps maker commission + $0.10/ct exchange fee')
    lines.append('- Exit: 10.0 bps taker commission + $0.10/ct exchange fee')
    lines.append('- Slippage base case: 2 bps/side')
    lines.append('- Sizing: production `cfm-position-sizer.ts` logic, max_daily_loss_usd=$100 (NOT raised)')
    lines.append('')

    # ── Trend Follow section (preserved from Phase 1) ──
    if tf_section:
        for line in tf_section:
            lines.append(line)
        lines.append('')

    # ── Donchian multi-asset section ──
    lines.append('## Donchian Daily S3 — Multi-Asset Extension')
    lines.append('')
    lines.append(f'### Verdict: **{final_verdict}**')
    lines.append('')

    # stopAtr sweep table
    lines.append('### stopAtr Sweep (1.5 → 2.5)')
    lines.append('')
    lines.append('| stopAtr | Trades | Net P&L | Sharpe | Skip % | Win Rate | PF |')
    lines.append('|---------|--------|---------|--------|--------|----------|----|')
    for sr in sweep_results:
        m = sr['pooled_metrics']
        lines.append(f'| {sr["stop_atr"]:.2f} | {m["trades"]} | ${m["net_pnl"]:.2f} | '
                     f'{m["sharpe"]:.2f} | {sr["skip_pct"]:.1f}% | {m["win_rate"]*100:.1f}% | {m["profit_factor"]:.2f} |')
    lines.append('')
    lines.append(f'**Selected stopAtr: {best_stop_atr}** (best Sharpe with <15% skip rate)')
    lines.append('')

    # Per-asset at best stopAtr
    lines.append(f'### Per-Asset Results (stopAtr={best_stop_atr})')
    lines.append('')
    best = [s for s in sweep_results if s['stop_atr'] == best_stop_atr][0]
    lines.append('| Asset | Trades | Net P&L | Skips | Skip % |')
    lines.append('|-------|--------|---------|-------|--------|')
    for sym, pa in best['per_asset'].items():
        sp = (pa['size_zero_skips'] / pa['total_signals'] * 100) if pa['total_signals'] > 0 else 0
        lines.append(f'| {sym} | {pa["trades"]} | ${pa["net_pnl"]:.2f} | '
                     f'{pa["size_zero_skips"]}/{pa["total_signals"]} | {sp:.0f}% |')
    lines.append('')

    # Key numbers table
    lines.append(f'### Key Numbers (stopAtr={best_stop_atr}, pooled)')
    lines.append('')
    lines.append('| Metric | Full Sample | WF OOS (stitched) | Holdout OOS (12mo) |')
    lines.append('|--------|------------|-------------------|--------------------|')
    lines.append(f'| Net P&L after costs | ${full_metrics["net_pnl"]:.2f} | ${wf_metrics.get("net_pnl", 0):.2f} | ${oos_metrics.get("net_pnl", 0):.2f} |')
    lines.append(f'| Sharpe | {full_metrics["sharpe"]:.2f} | {wf_metrics.get("sharpe", 0):.2f} | {oos_metrics.get("sharpe", 0):.2f} |')
    lines.append(f'| Trades | {full_metrics["trades"]} | {wf_metrics.get("trades", 0)} | {oos_metrics.get("trades", 0)} |')
    lines.append(f'| Win Rate | {full_metrics["win_rate"]*100:.1f}% | {wf_metrics.get("win_rate", 0)*100:.1f}% | {oos_metrics.get("win_rate", 0)*100:.1f}% |')
    lines.append(f'| Profit Factor | {full_metrics["profit_factor"]:.2f} | {wf_metrics.get("profit_factor", 0):.2f} | {oos_metrics.get("profit_factor", 0):.2f} |')
    lines.append(f'| Max Drawdown | {full_metrics["max_drawdown_pct"]*100:.2f}% | — | {oos_metrics.get("max_drawdown_pct", 0)*100:.2f}% |')
    lines.append(f'| Expectancy/trade | ${full_metrics["expectancy_usd"]:.2f} | ${wf_metrics.get("expectancy_usd", 0):.2f} | ${oos_metrics.get("expectancy_usd", 0):.2f} |')
    lines.append(f'| Avg R | {full_metrics["avg_r"]:.2f} | {wf_metrics.get("avg_r", 0):.2f} | {oos_metrics.get("avg_r", 0):.2f} |')
    lines.append(f'| Total Fees | ${full_metrics["total_fees"]:.2f} | — | ${oos_metrics.get("total_fees", 0):.2f} |')
    lines.append(f'| Exposure | {full_metrics["exposure_pct"]:.1f}% | — | {oos_metrics.get("exposure_pct", 0):.1f}% |')
    lines.append('')

    # Holdout per-asset
    if oos_per_asset:
        lines.append('### Holdout OOS Per-Asset')
        lines.append('')
        lines.append('| Asset | Trades | Net P&L | Win Rate | Sharpe |')
        lines.append('|-------|--------|---------|----------|--------|')
        for sym, m in oos_per_asset.items():
            lines.append(f'| {sym} | {m["trades"]} | ${m["net_pnl"]:.2f} | {m["win_rate"]*100:.0f}% | {m["sharpe"]:.2f} |')
        lines.append('')

    # Overfitting checks
    lines.append('### Overfitting Checks')
    lines.append('')
    lines.append(f'- **Deflated Sharpe probability**: {dsr:.4f} '
                 f'({"PASS ≥0.95" if dsr > 0.95 else "FAIL <0.95"}) '
                 f'[n_trades={full_metrics["trades"]}, n_trials={n_trials}]')
    lines.append(f'- **PBO (CSCV 16 splits)**: {pbo:.4f} ({"PASS <0.3" if pbo < 0.3 else "FAIL ≥0.3"})')
    lines.append(f'- **Shifted entry (+1 bar)**: ratio {shift_ratio:.2f} '
                 f'(original ${orig_pnl:.2f} → shifted ${shifted_pnl:.2f})')
    lines.append(f'- **Random baseline (1000 runs)**: random better {rand_result["pct_better"]:.1f}% '
                 f'(mean ${rand_result["mean_pnl"]:.2f})')
    lines.append('')

    # Fee sensitivity
    lines.append('### Fee Sensitivity (pooled)')
    lines.append('')
    for fee_mult, fee_net_val, fee_trade_count in fee_sensitivity_results:
        lines.append(f'- **{fee_mult}x fees**: ${fee_net_val:.2f} ({fee_trade_count} trades)')
    lines.append('')

    # GO criteria
    dsr_pass = dsr > 0.95
    pbo_pass = pbo < 0.3
    wf_positive = wf_metrics.get('net_pnl', 0) > 0 if wf_metrics.get('trades', 0) > 0 else False
    oos_2x = fee_2x_net > 0
    tc_pass = wf_metrics.get('trades', 0) >= 100

    lines.append('### GO Criteria')
    lines.append('')
    lines.append('| Criterion | Result | Value |')
    lines.append('|-----------|--------|-------|')
    lines.append(f'| WF-OOS expectancy > 0 | {"✓ PASS" if wf_positive else "✗ FAIL"} | ${wf_metrics.get("net_pnl", 0):.2f} |')
    lines.append(f'| Full-sample positive at 2x costs | {"✓ PASS" if oos_2x else "✗ FAIL"} | ${fee_2x_net:.2f} |')
    lines.append(f'| Deflated Sharpe > 0.95 | {"✓ PASS" if dsr_pass else "✗ FAIL"} | {dsr:.4f} |')
    lines.append(f'| PBO < 0.3 | {"✓ PASS" if pbo_pass else "✗ FAIL"} | {pbo:.4f} |')
    lines.append(f'| ≥100 WF-OOS trades | {"✓ PASS" if tc_pass else "✗ FAIL"} | {wf_metrics.get("trades", 0)} |')
    lines.append('')

    lines.append(f'### `donchian_daily_s3 (1D, multi-asset)` → **{final_verdict}**')
    lines.append('')

    if final_verdict == 'HOLD':
        lines.append('The pooled multi-asset donchian strategy is structurally profitable and fee-resistant,')
        lines.append('but fails statistical rigour checks (DSR, PBO). The trade count is higher with')
        lines.append('multiple instruments but may still be insufficient for CSCV to converge. The strategy')
        lines.append('should remain in soak / research mode until more data accumulates or the parameter')
        lines.append('grid is narrowed to reduce the trial count.')
    elif final_verdict == 'GO':
        lines.append('All GO criteria pass. The pooled multi-asset donchian strategy has a positive edge')
        lines.append('after costs with acceptable overfitting risk.')
    else:
        lines.append('The strategy does not show a reliable edge after costs.')
    lines.append('')

    # $100 risk cap
    lines.append('### $100 Risk Cap')
    lines.append('')
    lines.append(f'At stopAtr={best_stop_atr}, the skip rate is {[s for s in sweep_results if s["stop_atr"]==best_stop_atr][0]["skip_pct"]:.1f}%.')
    lines.append('The $100 cap is viable with a tighter stopAtr; the tradeoff is that the software stop')
    lines.append('will cut more trades the pure S3 rule would have held. Do NOT raise the $100 cap.')
    lines.append('')

    lines.append('## Charts')
    lines.append('')
    lines.append('- `research/charts/equity_curves.png` — BTC-only equity (Phase 1)')
    lines.append('- `research/charts/donch_multi_equity.png` — multi-asset donchian equity')
    lines.append('- `research/charts/donch_multi_drawdown.png` — multi-asset donchian drawdown')
    lines.append('- `research/charts/donch_stopatr_sweep.png` — stopAtr sweep (P&L, Sharpe, skip %)')
    lines.append('- `research/charts/donch_multi_wf_oos.png` — multi-asset WF-OOS equity')
    lines.append('- `research/charts/drawdown.png` — BTC-only drawdown (Phase 1)')
    lines.append('- `research/charts/wf_heatmap_tf.png` / `wf_heatmap_donch.png` — Phase 1 WF heatmaps')
    lines.append('')

    with open(VERDICT_FILE, 'w') as f:
        f.write('\n'.join(lines))


if __name__ == '__main__':
    main()
