#!/usr/bin/env python3
"""
Fetch BTC-USD 1H candles from Coinbase Advanced public API.
Saves to atlas/var/bt-data/btc_usd_1h.csv.

Usage: python3 research/fetch_btc_candles.py
"""
import os
import time
import json
import urllib.request
import urllib.error
import csv
from datetime import datetime, timezone, timedelta

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'atlas', 'var', 'bt-data')
OUTPUT_FILE = os.path.join(DATA_DIR, 'btc_usd_1h.csv')

PRODUCT = 'BTC-USD'
GRANULARITY = 'ONE_HOUR'  # 3600 seconds
BAR_SECONDS = 3600
START_DATE = datetime(2019, 1, 1, tzinfo=timezone.utc)
MAX_CANDLES_PER_REQUEST = 300  # Coinbase limit

API_BASE = 'https://api.coinbase.com'


def fetch_candles(start_ts: int, end_ts: int) -> list[dict]:
    """Fetch candles from Coinbase Advanced Trade public endpoint."""
    url = (
        f'{API_BASE}/api/v3/brokerage/market/products/{PRODUCT}/candles'
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
                print(f'  Retry {attempt+1}/4 after error: {e} (wait {wait}s)')
                time.sleep(wait)
            else:
                raise
    return []


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    existing_rows = {}
    if os.path.exists(OUTPUT_FILE):
        with open(OUTPUT_FILE, 'r') as f:
            reader = csv.DictReader(f)
            for row in reader:
                existing_rows[int(row['time'])] = row
        print(f'Loaded {len(existing_rows)} existing candles from cache')

    now = datetime.now(timezone.utc)
    end_date = now.replace(minute=0, second=0, microsecond=0)

    all_candles = dict(existing_rows)
    cursor = START_DATE
    total_fetched = 0

    while cursor < end_date:
        chunk_end = min(cursor + timedelta(seconds=BAR_SECONDS * MAX_CANDLES_PER_REQUEST), end_date)
        start_ts = int(cursor.timestamp())
        end_ts = int(chunk_end.timestamp())

        # Skip chunks we already have
        expected_count = (end_ts - start_ts) // BAR_SECONDS
        existing_in_range = sum(1 for t in range(start_ts, end_ts, BAR_SECONDS) if t in all_candles)
        if existing_in_range >= expected_count * 0.95:
            cursor = chunk_end
            continue

        candles = fetch_candles(start_ts, end_ts)
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

        date_str = cursor.strftime('%Y-%m-%d')
        print(f'  {date_str}: fetched {len(candles)} candles (total cached: {len(all_candles)})')

        cursor = chunk_end
        time.sleep(0.35)  # rate limit courtesy

    sorted_candles = sorted(all_candles.values(), key=lambda c: int(c['time']))

    with open(OUTPUT_FILE, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['time', 'open', 'high', 'low', 'close', 'volume'])
        writer.writeheader()
        writer.writerows(sorted_candles)

    start_dt = datetime.fromtimestamp(int(sorted_candles[0]['time']), tz=timezone.utc)
    end_dt = datetime.fromtimestamp(int(sorted_candles[-1]['time']), tz=timezone.utc)
    print(f'\nSaved {len(sorted_candles)} candles to {OUTPUT_FILE}')
    print(f'Range: {start_dt.isoformat()} to {end_dt.isoformat()}')
    print(f'New candles fetched this run: {total_fetched}')


if __name__ == '__main__':
    main()
