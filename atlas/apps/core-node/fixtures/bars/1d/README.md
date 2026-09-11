# 1d fixtures — sealed daily set + deep-history windows

Three things live here; they are different roles and are never mixed in one
`--fixture-dir`:

| `--fixture-dir` | Role | Symbols | Window (UTC, bar starts, inclusive) | Bars / symbol |
|---|---|---|---|---|
| `fixtures/bars/1d` (the loose `*.json` files) | **SEALED — HO-H1-DAILY source** (Validator; fixed 2025-03-01 → 2026-08-31 sub-window, 549 bars). Also the E4 1D data set. | BTC-USD, ETH-USD, SOL-USD | 2024-09-01 → 2026-08-31 | 730 |
| `fixtures/bars/1d/tune-2017-01_2025-03` | **TUNE (deep history)** — parameter fitting only, in-sample; ends before the sealed holdout | BTC-USD, ETH-USD | 2017-01-01 → 2025-02-28 | 2981 (no upstream gaps) |
| `fixtures/bars/1d/btc-eth-2017_plus` | **FULL SERIES 2017 → present** — research / continuity; contains the holdout months, so **not** counted evidence | BTC-USD, ETH-USD | 2017-01-01 → 2026-09-10 (last complete UTC day at generation) | 3540 (no upstream gaps) |

- **Do not regenerate or edit the loose `1d/*.json` files.** Their sha256s
  are locked (`BTC-USD.json`
  `06461bafd9b1c41a10eb066e307cb10a63dec7711e0cb117a18f9c0174a988aa`,
  `ETH-USD.json`
  `a3f0bb3db6c59ee7787c834eb7dcf05154f6686b9a585f9592bb107e36d823ca`). Any
  new daily window goes in a sibling subdirectory `1d/<role>-<from>_<to>/`.
- The tune window ends on 2025-02-28, the day before the sealed holdout
  window begins; asking it for 2025-03-01 onward is `DATA_UNAVAILABLE`
  (exit 2), as is `SOL-USD`. On the 181 days both files cover (2024-09-01 →
  2025-02-28) the tune candles are byte-identical to the sealed ones.
- The full series is the seal-safe "extend `1d/` to 2017 → present": the
  sealed files stay untouched; the full series reproduces them byte-for-byte
  on all 730 days they cover and has the tune window as an exact 2981-bar
  prefix (both unit-tested). Its last bar is always the last **complete**
  UTC day — the forming day is never written. Extending it to a newer
  present = regenerate + update the counts / sha256s / test constants
  (`MULTI_TF.md` → Regenerate).
- All real Coinbase Advanced Trade public native `ONE_DAY` candles, no
  rollup. Never `--allow-synthetic` for evidence. Full details, cross-checks,
  invocation and regeneration commands: [`../MULTI_TF.md`](../MULTI_TF.md).
