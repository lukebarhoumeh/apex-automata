#!/usr/bin/env python3
"""
Fetch 1H candles for multiple Coinbase spot products.
Saves to atlas/var/bt-data/<product>_1h.csv.

Usage: python3 research/fetch_multi_candles.py
"""
import os
import time
import json
import urllib.request
import urllib.error
import csv
from datetime import datetime, timezone, timedelta

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'atlas', 'var', 'bt-data')

PRODUCTS = [
    'ETH-USD',
    'SOL-USD',
    'LTC-USD',
    'DOGE-USD',
    'XRP-USD',
]

# Approximate listing dates on Coinbase (conservative — we start from here)
PRODUCT_START_DATES = {
    'ETH-USD': '2016-05-01',
    'SOL-USD': '2021-06-01',
    'LTC-USD': '2016-08-01',
    'DOGE-USD': '2021-06-01',
    'XRP-USD': '2019-02-01',
}

GRANULARITY = 'ONE_HOUR'
BAR_SECONDS = 3600
MAX_CANDLES_PER_REQUEST = 300
API_BASE = 'https://api.coinbase.com'


def fetch_candles(product: str, start_ts: int, end_ts: int) -> list[dict]:
    url = (
        f'{API_BASE}/api/v3/brokerage/market/products/{product}/candles'
        f'?start={start_ts}&end={end_ts}&granularity={GRANULARITY}'
    )
    req = urllib.request.Request(url, headers={'User-Agent': 'apex-automata-research/1.0'})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())
                return data.get('candles', [])
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            if attempt < 4:
                wait = 2 ** (attempt + 1)
                print(f'    Retry {attempt+1}/4 after error: {e} (wait {wait}s)')
                time.sleep(wait)
            else:
                raise
    return []


def fetch_product(product: str):
    output_file = os.path.join(DATA_DIR, f'{product.lower().replace("-", "_")}_1h.csv')
    os.makedirs(DATA_DIR, exist_ok=True)

    existing_rows = {}
    if os.path.exists(output_file):
        with open(output_file, 'r') as f:
            reader = csv.DictReader(f)
            for row in reader:
                existing_rows[int(row['time'])] = row
        print(f'  Loaded {len(existing_rows)} existing candles from cache')

    start_str = PRODUCT_START_DATES.get(product, '2019-01-01')
    start_date = datetime.strptime(start_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    # Use 2019-01-01 as floor for consistency with BTC data
    start_date = max(start_date, datetime(2019, 1, 1, tzinfo=timezone.utc))

    now = datetime.now(timezone.utc)
    end_date = now.replace(minute=0, second=0, microsecond=0)

    all_candles = dict(existing_rows)
    cursor = start_date
    total_fetched = 0
    consecutive_empties = 0

    while cursor < end_date:
        chunk_end = min(cursor + timedelta(seconds=BAR_SECONDS * MAX_CANDLES_PER_REQUEST), end_date)
        start_ts = int(cursor.timestamp())
        end_ts = int(chunk_end.timestamp())

        expected_count = (end_ts - start_ts) // BAR_SECONDS
        existing_in_range = sum(1 for t in range(start_ts, end_ts, BAR_SECONDS) if t in all_candles)
        if existing_in_range >= expected_count * 0.95:
            cursor = chunk_end
            consecutive_empties = 0
            continue

        try:
            candles = fetch_candles(product, start_ts, end_ts)
        except Exception as e:
            print(f'    Error fetching {product} at {cursor}: {e}')
            cursor = chunk_end
            consecutive_empties += 1
            if consecutive_empties > 20:
                print(f'    Too many consecutive empty chunks, assuming pre-listing period')
                break
            continue

        if not candles:
            consecutive_empties += 1
            if consecutive_empties > 20:
                break
        else:
            consecutive_empties = 0

        for c in candles:
            ts = int(c['start'])
            all_candles[ts] = {
                'time': ts,
                'open': c['open'],
                'high': c['high'],
                'low': c['low'],
                'close': c['close'],
                'volume': c['volume'],
            }
        total_fetched += len(candles)

        if total_fetched % 3000 < 300:
            date_str = cursor.strftime('%Y-%m-%d')
            print(f'    {date_str}: cached={len(all_candles)}, fetched this run={total_fetched}')

        cursor = chunk_end
        time.sleep(0.35)

    sorted_candles = sorted(all_candles.values(), key=lambda c: int(c['time']))

    if not sorted_candles:
        print(f'  WARNING: No candles fetched for {product}')
        return 0

    with open(output_file, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['time', 'open', 'high', 'low', 'close', 'volume'])
        writer.writeheader()
        writer.writerows(sorted_candles)

    start_dt = datetime.fromtimestamp(int(sorted_candles[0]['time']), tz=timezone.utc)
    end_dt = datetime.fromtimestamp(int(sorted_candles[-1]['time']), tz=timezone.utc)
    print(f'  Saved {len(sorted_candles)} candles to {output_file}')
    print(f'  Range: {start_dt.strftime("%Y-%m-%d")} to {end_dt.strftime("%Y-%m-%d")}')
    return len(sorted_candles)


def main():
    print('Fetching multi-asset candles...')
    for product in PRODUCTS:
        print(f'\n{product}:')
        count = fetch_product(product)
        if count == 0:
            print(f'  SKIPPED — no data available')

    # Summary
    print('\n' + '='*60)
    print('Summary:')
    for product in PRODUCTS:
        fname = f'{product.lower().replace("-", "_")}_1h.csv'
        fpath = os.path.join(DATA_DIR, fname)
        if os.path.exists(fpath):
            with open(fpath) as f:
                lines = sum(1 for _ in f) - 1
            print(f'  {product}: {lines} bars')
        else:
            print(f'  {product}: no data')


if __name__ == '__main__':
    main()
