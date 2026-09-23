/**
 * H1 Apex Trend v1 — text report for the SHORT DRY-RUN.
 *
 * Line 1 is always the banner; line 2 is the data stamp. The five required
 * prints follow in order: path · variant · fee sheet · results · banner.
 * Every counted number is labelled DRY-RUN DRAFT / UNVERIFIED.
 */
import path from 'node:path';
import {
  H1_BANNER,
  H1_FEE_SHEET,
  H1_VARIANT,
  type H1CostModel,
  type H1ExitReason,
  type H1RunResult,
  type H1TradeStats,
} from './apex-trend-v1';
import { H1_PATH_LOCK, type H1LoadResult } from './apex-trend-v1-data';

/** One ladder row: the same variant re-run under another all-in bracket. */
export interface H1LadderRow {
  allInBpsPerSide: number;
  cost: H1CostModel;
  n: number;
  sharpe: number | null;
  netReturn: number;
  cagr: number | null;
  maxDrawdown: number;
  profitFactor: number | null;
  costDragBpsPerYear: number | null;
}

export interface H1ReportInput {
  data: H1LoadResult;
  requestedFixtureDir: string;
  coreNodeRoot: string;
  result: H1RunResult;
  ladder: H1LadderRow[];
  /** Same run at 0/0 cost, for the gross reference line. */
  zeroCost: H1RunResult | null;
  generatedAt: string;
}

const isoDay = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString().slice(0, 10);
const pct = (x: number | null | undefined, digits = 1): string => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(digits)} %`);
const num = (x: number | null | undefined, digits = 2): string =>
  x === null || x === undefined ? 'n/a' : !Number.isFinite(x) ? (x > 0 ? '∞' : '−∞') : x.toFixed(digits);
const usd = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : `${x < 0 ? '−' : ''}$${Math.abs(x).toFixed(2)}`);
const days = (x: number | null | undefined): string => (x === null || x === undefined ? 'n/a' : x.toFixed(1));

function tradeLine(label: string, s: H1TradeStats): string {
  return `${label.padEnd(10)} n=${String(s.n).padStart(4)}  WR ${pct(s.winRate).padStart(7)}  payoff ${num(s.payoff).padStart(5)}  PF ${num(s.profitFactor).padStart(5)}  net ${usd(s.netPnl).padStart(12)}  exp/trade ${usd(s.expectancy).padStart(10)}  hold p50 ${days(s.medianHoldDays)} d  exits R/T/E ${s.exitMix.reversal.n}/${s.exitMix.trail.n}/${s.exitMix.end_of_data.n}`;
}

/** Render the full stdout / report text. */
export function renderH1Report(input: H1ReportInput): string {
  const { data, result, ladder, zeroCost } = input;
  const v = H1_VARIANT;
  const m = result.metrics;
  const cost = result.config.cost;
  const allIn = cost.feeBpsPerSide + cost.slippageBpsPerSide;
  const lines: string[] = [];
  const push = (s = ''): void => {
    lines.push(s);
  };

  push(H1_BANNER);
  push(`DATA: ${data.dataStamp}`);
  push('H1 Apex Trend v1 — SHORT DRY-RUN (Creator open) · in-sample TRAIN · every number DRY-RUN DRAFT / UNVERIFIED');
  push(`generated ${input.generatedAt} · not research-pass · not GO · not sealed holdout · no DSR/PBO · no grid (1 variant) · no CONFIRM_LIVE`);
  push();

  // 1. PATH
  push('1. PATH (TRAIN ONLY)');
  push(`   fixture-dir: ${H1_PATH_LOCK.trainDir}  (requested "${input.requestedFixtureDir}" → ${data.fixtureDir})`);
  for (const s of data.series) {
    const match = s.sha256MatchesCommitted === null ? 'no committed hash' : s.sha256MatchesCommitted ? 'matches fixtures/bars/MULTI_TF.md' : 'MISMATCH vs committed table — investigate';
    push(
      `   opened: ${path.basename(s.filePath)}  sha256=${s.sha256.slice(0, 12)}…  (${match})  bars ${s.bars.length}/${s.totalBarsInFile}  ${isoDay(s.bars[0].time)} → ${isoDay(s.bars[s.bars.length - 1].time)}  ${s.granularity}/${s.granularitySeconds}s native, no rollup, source=${s.source}`,
    );
  }
  const lastBar = Math.max(...data.series.map((s) => s.bars[s.bars.length - 1].time));
  push(`   seal boundary ${H1_PATH_LOCK.sealBoundaryUtc}: last bar read ${isoDay(lastBar)} < boundary — asserted per bar ✔`);
  for (const [banned, present] of Object.entries(data.bannedDirsPresentOnDisk)) {
    push(`   BANNED ${banned}: ${present ? 'PRESENT on disk but' : 'not present on disk,'} never opened (path lock refuses it) ✔`);
  }
  push(`   SEALED ${H1_PATH_LOCK.sealedLooseDir}/*.json (HO-H1-DAILY 2025-03-01 → 2026-08-31): never opened (path lock refuses it) ✔`);
  push(`   files opened this run: ${data.openedFiles.length} — ${data.openedFiles.map((f) => path.relative(input.coreNodeRoot, f)).join(', ')}`);
  push('   --allow-synthetic: no such flag on this CLI (yargs strict) ✔');
  push();

  // 2. VARIANT
  push(`2. VARIANT ${v.id} · TF ${v.timeframe} · ${v.universe.join('+')}`);
  push(`   A1  MA speeds ${v.maSpeeds.join('/')} (SMA on daily closes)`);
  push(`   B1  ${v.vote}: each speed votes sign(close − MA) ∈ {−1,0,+1}; plain average → direction`);
  push(`   C   ${v.trailAtrMultiple.toFixed(1)} × daily ATR(${v.atrPeriod}, Wilder) close-based ratchet trail (tightens only)`);
  push(`   D   no-trade band ${v.noTradeBand}: |avg vote| ≤ ${v.noTradeBand} ⇒ no new direction; open positions are held through the band`);
  push(`   exits: signal reversal (flip) OR trail — no fixed TP (${v.fixedTakeProfit ? 'ON' : 'none'}); open positions at the last bar close as end_of_data`);
  push(
    `   sizing: vol-target ${pct(v.volTargetAnnual, 0)}/yr per sleeve (${v.volLookbackDays}-day realised, √${v.annualizationDays}), ${pct(v.sleeveWeight, 0)} capital per sleeve, set at entry; leverage cap ${v.leverageCap.toFixed(1)}× per sleeve (UI 4.1× ignored)`,
  );
  push(`   sides: long + short (futures framing) · fills: ${v.fillRule} ± slippage — maker sim MISSING, so maker-first is a cost LABEL only`);
  push(`   warm-up ${result.warmupBars} bars ⇒ eval span ${isoDay(m.evalStartTime)} → ${isoDay(m.evalEndTime)} (${m.evalDays.toFixed(0)} d; ${result.window.bars} bars loaded per symbol)`);
  push();

  // 3. FEE SHEET
  push(`3. FEE SHEET ${H1_FEE_SHEET.id} — ${H1_FEE_SHEET.status}`);
  push(`   brackets: ${H1_FEE_SHEET.bracketsSource}`);
  push(`   applied this run (UNVERIFIED): ${cost.feeBpsPerSide} bps fee + ${cost.slippageBpsPerSide} bps slippage per side = ${allIn} bps/side all-in (${allIn * 2} bps round trip), maker-first framing; never Intro-1`);
  push(`   not modelled: ${H1_FEE_SHEET.notModelled.join('; ')}`);
  push();

  // 4. RESULTS
  push('4. RESULTS — DRY-RUN DRAFT (in-sample TRAIN; every number UNVERIFIED; not evidence)');
  push(`   window ${isoDay(result.window.startTime)} → ${isoDay(result.window.endTime)} · eval ${isoDay(m.evalStartTime)} → ${isoDay(m.evalEndTime)} · initial capital ${usd(m.initialCapital)} · final ${usd(m.finalEquity)}`);
  const perSym = Object.entries(m.perSymbol).map(([sym, s]) => `${sym} ${s.n}`).join(' / ');
  push(`   n = ${m.trades.n} closed trades (${perSym})`);
  push(`   after-cost Sharpe = ${num(m.sharpe)}  (√${v.annualizationDays}, daily equity returns over eval span; Sortino ${num(m.sortino)})${zeroCost ? `  · zero-cost reference Sharpe ${num(zeroCost.metrics.sharpe)}` : ''}`);
  push(`   WR = ${pct(m.trades.winRate)}  (${m.trades.wins} W / ${m.trades.losses} L)`);
  push(`   payoff = ${num(m.trades.payoff)}  (avg win ${usd(m.trades.avgWin)} / avg loss ${usd(m.trades.avgLoss)})  · PF ${num(m.trades.profitFactor)} · expectancy ${usd(m.trades.expectancy)}/trade`);
  push(`   maxDD = ${pct(m.maxDrawdown)}  · CAGR ${pct(m.cagr)} · net ${pct(m.netReturn)} · ann. vol ${pct(m.annVol)} (target ${pct(v.volTargetAnnual, 0)}) · Calmar ${num(m.calmar)}`);
  const em = m.trades.exitMix;
  const emRow = (r: H1ExitReason): string => `${r} ${em[r].n} (${pct(em[r].share)}; WR ${pct(em[r].winRate)}; net ${usd(em[r].netPnl)}; hold ${days(em[r].meanHoldDays)} d)`;
  push(`   exit mix = ${emRow('reversal')} / ${emRow('trail')} / ${emRow('end_of_data')}`);
  push(`   hold p50 ${days(m.trades.medianHoldDays)} d (mean ${days(m.trades.meanHoldDays)}) · exposure ${pct(m.exposure)} of eval days (≥1 sleeve on) · re-entries same-direction after a trail exit ${m.trades.reentriesAfterTrail}`);
  push(`   leverage per sleeve: mean ${num(m.leverage.mean)}× · max ${num(m.leverage.max)}× · cap ${v.leverageCap.toFixed(1)}× bound on ${m.leverage.capBinds} entries · gross turnover ${num(m.grossTurnoverPerYear, 1)}×/yr · cost drag ${num(m.costDragBpsPerYear, 0)} bps/yr (fees ${usd(m.trades.fees)} + slippage ${usd(m.trades.slippageCost)})`);
  push();
  push('   per symbol (after cost):');
  for (const [sym, s] of Object.entries(m.perSymbol)) push(`   ${tradeLine(sym, s)}  in-market ${pct(s.exposure)}`);
  push('   per side (after cost):');
  push(`   ${tradeLine('long', m.perSide.long)}`);
  push(`   ${tradeLine('short', m.perSide.short)}`);
  push();
  push('   signal mix over eligible bars (direction from banded avg vote):');
  for (const [sym, s] of Object.entries(m.signals)) {
    const hist = Object.entries(s.avgVoteHistogram)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([k, n]) => `${k}:${n}`)
      .join(' ');
    push(`   ${sym.padEnd(8)} eligible ${s.eligibleBars} · long ${s.longBars} (${pct(s.longBars / s.eligibleBars)}) · short ${s.shortBars} (${pct(s.shortBars / s.eligibleBars)}) · band ${s.bandBars} (${pct(s.bandBars / s.eligibleBars)}) · avg-vote histogram ${hist}`);
  }
  push();
  push('   per year (in-sample diagnostics; calendar UTC; never evidence):');
  push('   year  days  net return   Sharpe   maxDD    exposure  trades closed');
  for (const y of m.perYear) {
    push(`   ${y.year}  ${String(y.days).padStart(4)}  ${pct(y.netReturn).padStart(10)}  ${num(y.sharpe).padStart(7)}  ${pct(y.maxDrawdown).padStart(7)}  ${pct(y.exposure).padStart(8)}  ${String(y.tradesClosed).padStart(6)}`);
  }
  push();
  if (ladder.length > 0) {
    push('   fee sensitivity — same variant, all-in bps per side (informational; every row UNVERIFIED; never graded; not a variant sweep):');
    push('   all-in bps/side   n   Sharpe   net return    CAGR    maxDD     PF   cost drag bps/yr');
    for (const r of ladder) {
      push(
        `   ${String(r.allInBpsPerSide).padStart(15)}  ${String(r.n).padStart(3)}  ${num(r.sharpe).padStart(7)}  ${pct(r.netReturn).padStart(11)}  ${pct(r.cagr).padStart(7)}  ${pct(r.maxDrawdown).padStart(7)}  ${num(r.profitFactor).padStart(5)}  ${num(r.costDragBpsPerYear, 0).padStart(9)}`,
      );
    }
    push();
  }

  push('5. ' + H1_BANNER);
  return lines.join('\n');
}
