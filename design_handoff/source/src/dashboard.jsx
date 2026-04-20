// ============================================================
// Apex Automata — Dashboard / Overview
// ============================================================

function HeroState({ mode }) {
  const [pnl, setPnl] = useState(SESSION.pnl);
  const [unreal, setUnreal] = useState(SESSION.unrealized);
  const [feed, setFeed] = useState(FEED.snapshot());

  useEffect(() => FEED.subscribe(setFeed), []);
  useEffect(() => {
    const id = setInterval(() => {
      setPnl(p => p + (Math.random() - 0.45) * 12);
      setUnreal(u => u + (Math.random() - 0.48) * 7);
    }, 1100);
    return () => clearInterval(id);
  }, []);

  const modeCfg = {
    paper:  { label: 'PAPER',  tone: 'var(--accent)', glow: 'state-glow-paper',  subtitle: 'Simulated capital — no real orders' },
    live:   { label: 'LIVE',   tone: 'var(--up)',     glow: 'state-glow-live',   subtitle: 'Executing real orders on Coinbase' },
    paused: { label: 'PAUSED', tone: 'var(--warn)',   glow: 'state-glow-paused', subtitle: 'New entries halted — positions held' },
  }[mode];

  // Heat progress
  const heatPct = (SESSION.heat / SESSION.heatCap) * 100;

  return (
    <div className="panel scanlines noise" style={{
      padding: 0, overflow: 'hidden', position: 'relative',
      background: 'linear-gradient(135deg, var(--bg-1) 0%, #0d121c 60%, var(--bg-1) 100%)',
      borderColor: 'rgba(59,130,246,0.18)'
    }}>
      <div className="gridbg" style={{ position: 'absolute', inset: 0, opacity: 0.6, pointerEvents: 'none' }} />
      {/* Accent corner glow */}
      <div style={{
        position: 'absolute', top: -120, right: -120, width: 360, height: 360, borderRadius: '50%',
        background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 70%)',
        opacity: 0.6, pointerEvents: 'none'
      }} />

      <div style={{ position: 'relative', padding: '28px 32px 24px', display: 'grid', gridTemplateColumns: '1.05fr 1fr 1fr', gap: 28 }}>
        {/* Column 1: State + narrative */}
        <div className="col" style={{ gap: 14 }}>
          <div className="row center gap-8">
            <div className={`row center gap-8 ${modeCfg.glow}`} style={{
              padding: '5px 12px', borderRadius: 999,
              background: 'var(--bg-0)',
            }}>
              <span className="dot" style={{ background: modeCfg.tone, boxShadow: `0 0 10px ${modeCfg.tone}` }} />
              <span className="mono" style={{ fontSize: 11, letterSpacing: '0.12em', fontWeight: 600, color: modeCfg.tone }}>
                {modeCfg.label} MODE
              </span>
            </div>
            <span className="pill pill-accent">
              <Icon name="zap" size={10} stroke={2} /> ENGINE v2.4.1
            </span>
          </div>

          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>CURRENT SESSION</div>
            <div style={{
              fontSize: 44, lineHeight: 1, fontWeight: 500,
              fontFamily: 'var(--f-serif)', fontStyle: 'italic',
              letterSpacing: '-0.02em',
              color: 'var(--fg-0)'
            }}>
              The engine is <span style={{ color: 'var(--accent-2)' }}>scanning</span><br/>
              <span style={{ color: 'var(--fg-1)' }}>6 markets</span> for edge.
            </div>
          </div>

          <div style={{ fontSize: 12.5, color: 'var(--fg-1)', lineHeight: 1.55, maxWidth: 380 }}>
            {modeCfg.subtitle}. Meta model gating at <span className="mono" style={{ color: 'var(--fg-0)' }}>p ≥ 0.65</span>.
            Ran <span className="mono" style={{ color: 'var(--fg-0)' }}>{SESSION.signalsSeen}</span> candidates
            · took <span className="mono" style={{ color: 'var(--accent-2)' }}>{SESSION.signalsTaken}</span> this session.
          </div>

          <div className="row gap-8" style={{ marginTop: 4 }}>
            <button className="btn btn-primary btn-sm"><Icon name="play" size={11}/> Intervene</button>
            <button className="btn btn-sm"><Icon name="pause" size={11}/> Pause engine</button>
            <button className="btn btn-sm"><Icon name="external" size={11}/> Logs</button>
          </div>
        </div>

        {/* Column 2: P&L headline */}
        <div className="col" style={{ gap: 4, justifyContent: 'center', borderLeft: '1px solid var(--line)', paddingLeft: 28 }}>
          <div className="eyebrow">SESSION P&L</div>
          <div className="row" style={{ alignItems: 'baseline', gap: 10 }}>
            <div className="display" style={{
              fontSize: 56, lineHeight: 1, color: pnl >= 0 ? 'var(--up)' : 'var(--down)',
              textShadow: pnl >= 0 ? '0 0 32px rgba(57,217,138,0.3)' : '0 0 32px rgba(255,90,106,0.3)',
              fontWeight: 500, letterSpacing: '-0.03em'
            }}>
              {pnl >= 0 ? '+' : ''}${fmt(Math.abs(pnl), 2)}
            </div>
          </div>
          <div className="row gap-12" style={{ marginTop: 10, fontSize: 12 }}>
            <div className="col" style={{ gap: 2 }}>
              <span className="label-sm">REALIZED</span>
              <span className="mono" style={{ color: 'var(--fg-0)' }}>${fmt(SESSION.realized, 2)}</span>
            </div>
            <div className="col" style={{ gap: 2 }}>
              <span className="label-sm">UNREALIZED</span>
              <span className="mono" style={{ color: unreal >= 0 ? 'var(--up)' : 'var(--down)' }}>
                {unreal >= 0 ? '+' : ''}${fmt(Math.abs(unreal), 2)}
              </span>
            </div>
            <div className="col" style={{ gap: 2 }}>
              <span className="label-sm">IN R</span>
              <span className="mono" style={{ color: 'var(--accent-2)' }}>+{SESSION.pnlR.toFixed(2)}R</span>
            </div>
          </div>
          {/* intraday spark */}
          <div style={{ marginTop: 14 }}>
            <Sparkline data={EQUITY.slice(-60).map(e => e.v)} width={320} height={32}
              color={pnl >= 0 ? 'var(--up)' : 'var(--down)'} strokeW={1.5} />
            <div className="row between" style={{ marginTop: 4, fontSize: 10, color: 'var(--fg-3)', fontFamily: 'var(--f-mono)' }}>
              <span>09:00</span><span>NOW</span>
            </div>
          </div>
        </div>

        {/* Column 3: Portfolio heat + quick stats */}
        <div className="col" style={{ gap: 10, borderLeft: '1px solid var(--line)', paddingLeft: 28 }}>
          <div className="row between center">
            <div className="eyebrow">PORTFOLIO HEAT</div>
            <span className="mono" style={{ fontSize: 11, color: 'var(--fg-1)' }}>
              {SESSION.heat.toFixed(1)}% / {SESSION.heatCap.toFixed(1)}%
            </span>
          </div>
          <div style={{ position: 'relative' }}>
            <HeatBar value={SESSION.heat} cap={SESSION.heatCap} color="var(--accent)" />
            {/* threshold markers */}
            <div style={{ position: 'absolute', left: '66%', top: -2, width: 1, height: 8, background: 'var(--warn)' }} />
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--fg-3)', fontFamily: 'var(--f-mono)' }}>0%—2%—CAP 3%</div>

          <div style={{ height: 1, background: 'var(--line)', margin: '6px 0' }} />

          <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
            <QuickStat label="WIN RATE" value={`${(SESSION.winRate*100).toFixed(1)}%`} tone="var(--up)" />
            <QuickStat label="TRADES" value={SESSION.trades} />
            <QuickStat label="W/L" value={`${SESSION.wins}/${SESSION.losses}`} />
            <QuickStat label="REGIME" value={REGIME.label} small />
            <QuickStat label="ADX" value={REGIME.adx} />
            <QuickStat label="UPTIME" value={SESSION.uptime} />
          </div>
        </div>
      </div>
    </div>
  );
}

function QuickStat({ label, value, tone, small }) {
  return (
    <div className="col" style={{ gap: 2, minWidth: small ? 90 : 60 }}>
      <span className="label-sm">{label}</span>
      <span className={small ? '' : 'mono'} style={{
        fontSize: small ? 11 : 15,
        fontWeight: small ? 500 : 500,
        color: tone || 'var(--fg-0)',
        fontFamily: small ? 'var(--f-mono)' : 'var(--f-mono)',
        letterSpacing: small ? '0.04em' : '-0.01em'
      }}>{value}</span>
    </div>
  );
}

// -------- Big chart with candles + live ticker --------
function ChartPanel() {
  const [sym, setSym] = useState('BTC-USD');
  const [tf, setTf] = useState('5m');
  const [feed, setFeed] = useState(FEED.snapshot());
  useEffect(() => FEED.subscribe(setFeed), []);

  const ticker = feed.find(t => t.s === sym) || feed[0];
  const candles = useMemo(() => makeCandles(sym.charCodeAt(0) * 7, ticker.px, ticker.atr, 80), [sym, ticker.px, ticker.atr]);

  const [size, setSize] = useState({ w: 800, h: 340 });
  const containerRef = useRef(null);
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setSize({ w: Math.floor(e.contentRect.width), h: Math.max(320, Math.floor(e.contentRect.height)) });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <Panel header={false} pad={0} className="col" >
      <div className="row between center" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
        <div className="row center gap-12">
          <div className="row center gap-8">
            <Icon name="activity" size={14} style={{ color: 'var(--accent-2)' }} />
            <div className="col" style={{ gap: 0, lineHeight: 1.2 }}>
              <div className="row center gap-8">
                <span style={{ fontWeight: 600, fontSize: 15 }}>{sym}</span>
                <span className="mono" style={{ color: ticker.chgPct >= 0 ? 'var(--up)' : 'var(--down)', fontSize: 12, fontWeight: 500 }}>
                  {ticker.chgPct >= 0 ? '▲' : '▼'} {Math.abs(ticker.chgPct).toFixed(2)}%
                </span>
              </div>
              <div className="label" style={{ fontSize: 10 }}>{ticker.name} · Coinbase · Spot</div>
            </div>
          </div>
          <div className="vdivider" style={{ height: 24 }} />
          <div className="display" style={{ fontSize: 22 }}>
            ${ticker.last.toLocaleString(undefined, { minimumFractionDigits: ticker.dec, maximumFractionDigits: ticker.dec })}
          </div>
        </div>

        <div className="row center gap-8">
          <select value={sym} onChange={e => setSym(e.target.value)} style={{ fontSize: 12, padding: '5px 8px', height: 28 }}>
            {feed.map(t => <option key={t.s} value={t.s}>{t.s}</option>)}
          </select>
          <Segmented value={tf} onChange={setTf} options={[
            { v: '1m', l: '1M' }, { v: '5m', l: '5M' }, { v: '15m', l: '15M' }, { v: '1h', l: '1H' }, { v: '4h', l: '4H' }
          ]}/>
          <button className="btn btn-ghost btn-sm"><Icon name="eye" size={13} /></button>
        </div>
      </div>

      <div ref={containerRef} style={{ height: 340, position: 'relative' }}>
        <CandleChart candles={candles} width={size.w} height={size.h} liveLast={ticker.last} />
        {/* Regime annotations overlay */}
        <div style={{ position: 'absolute', top: 12, left: 58, display: 'flex', gap: 6 }}>
          <span className="pill pill-accent" style={{ fontSize: 9.5 }}>● VWAP</span>
          <span className="pill" style={{ fontSize: 9.5 }}>DONCHIAN 20</span>
          <span className="pill" style={{ fontSize: 9.5 }}>ADX {REGIME.adx}</span>
        </div>
      </div>

      {/* Overlay hash for signals on this symbol */}
      <div className="row" style={{ borderTop: '1px solid var(--line)', padding: '10px 16px', gap: 24, flexWrap: 'wrap' }}>
        <ChartMeta label="OPEN" value={`$${fmt(ticker.px, ticker.dec)}`} />
        <ChartMeta label="HIGH" value={`$${fmt(ticker.hi, ticker.dec)}`} tone="var(--up)" />
        <ChartMeta label="LOW" value={`$${fmt(ticker.lo, ticker.dec)}`} tone="var(--down)" />
        <ChartMeta label="VWAP" value={`$${fmt(ticker.px * 0.998, ticker.dec)}`} />
        <ChartMeta label="ATR (14)" value={`$${fmt(ticker.atr, 2)}`} />
        <ChartMeta label="SPREAD" value="0.03 bps" tone="var(--fg-1)" />
      </div>
    </Panel>
  );
}
function ChartMeta({ label, value, tone }) {
  return (
    <div className="col" style={{ gap: 2 }}>
      <span className="label-sm" style={{ fontSize: 9 }}>{label}</span>
      <span className="mono" style={{ fontSize: 12.5, color: tone || 'var(--fg-0)' }}>{value}</span>
    </div>
  );
}

// -------- Equity curve big panel --------
function EquityPanel() {
  const [range, setRange] = useState('1M');
  const slice = { '1W': 7, '1M': 30, '3M': 90, 'ALL': EQUITY.length }[range];
  const data = EQUITY.slice(-slice);
  const [size, setSize] = useState({ w: 800, h: 200 });
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(es => {
      for (const e of es) setSize({ w: Math.floor(e.contentRect.width), h: 200 });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const first = data[0].v, last = data[data.length - 1].v;
  const delta = last - first, deltaPct = (delta / first) * 100;

  return (
    <Panel header={false} pad={0}>
      <div className="row between center" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
        <div className="col">
          <div className="label">EQUITY CURVE</div>
          <div className="row center gap-8" style={{ marginTop: 4 }}>
            <span className="display" style={{ fontSize: 22 }}>${fmt(last, 0)}</span>
            <span className="mono" style={{ fontSize: 13, color: delta >= 0 ? 'var(--up)' : 'var(--down)' }}>
              {delta >= 0 ? '+' : ''}${fmt(Math.abs(delta), 0)} ({deltaPct.toFixed(2)}%)
            </span>
          </div>
        </div>
        <Segmented value={range} onChange={setRange} options={[
          { v: '1W', l: '1W' }, { v: '1M', l: '1M' }, { v: '3M', l: '3M' }, { v: 'ALL', l: 'ALL' }
        ]}/>
      </div>
      <div ref={ref} style={{ padding: '0 4px 4px' }}>
        <AreaChart data={data} width={size.w - 8} height={size.h} color="var(--accent)" />
      </div>
    </Panel>
  );
}

// -------- Active positions strip --------
function PositionStrip() {
  const [feed, setFeed] = useState(FEED.snapshot());
  useEffect(() => FEED.subscribe(setFeed), []);
  return (
    <Panel header={false} pad={0}>
      <div className="row between center" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
        <div className="row center gap-8">
          <span className="dot dot-live" />
          <div className="label">ACTIVE POSITIONS</div>
          <span className="pill pill-accent">{POSITIONS.length} OPEN</span>
        </div>
        <button className="btn btn-ghost btn-sm">View all <Icon name="arrowRight" size={12}/></button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0 }}>
        {POSITIONS.map((p, i) => {
          const t = feed.find(x => x.s === p.sym);
          const last = t ? t.last : p.entry;
          const pnl = p.side === 'LONG' ? (last - p.entry) * p.qty : (p.entry - last) * p.qty;
          const pnlPct = (pnl / (p.entry * p.qty)) * 100;
          const tp = Math.abs(p.target - p.entry);
          const sl = Math.abs(p.entry - p.stop);
          const moved = p.side === 'LONG' ? last - p.entry : p.entry - last;
          const progressPct = Math.max(-100, Math.min(100, (moved / (moved > 0 ? tp : sl)) * 100));

          return (
            <div key={p.id} style={{
              padding: 16,
              borderRight: i < POSITIONS.length - 1 ? '1px solid var(--line)' : 'none',
              position: 'relative',
            }}>
              <div className="row between center" style={{ marginBottom: 8 }}>
                <div className="row center gap-8">
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{p.sym}</span>
                  <Pill tone={p.side === 'LONG' ? 'up' : 'down'}>
                    {p.side === 'LONG' ? <Icon name="arrowUp" size={9} stroke={2.5}/> : <Icon name="arrowDown" size={9} stroke={2.5}/>}
                    {p.side}
                  </Pill>
                </div>
                <Pill className={`strat-${p.strat}`}>{p.strat.replace('_', ' ')}</Pill>
              </div>

              <div className="row between" style={{ marginBottom: 8 }}>
                <div className="col" style={{ gap: 1 }}>
                  <span className="label-sm">UNREAL P&L</span>
                  <span className="mono" style={{ fontSize: 18, fontWeight: 500, color: pnl >= 0 ? 'var(--up)' : 'var(--down)' }}>
                    {pnl >= 0 ? '+' : ''}${fmt(Math.abs(pnl), 2)}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: pnl >= 0 ? 'var(--up)' : 'var(--down)' }}>
                    {pnl >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                  </span>
                </div>
                <div className="col" style={{ gap: 1, textAlign: 'right' }}>
                  <span className="label-sm">LAST</span>
                  <span className="mono" style={{ fontSize: 14 }}>${fmt(last, 2)}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--fg-2)' }}>qty {fmt(p.qty, 4)}</span>
                </div>
              </div>

              {/* stop - entry - target bar */}
              <div style={{ marginTop: 10 }}>
                <div style={{ position: 'relative', height: 6, background: 'var(--bg-3)', borderRadius: 3, overflow: 'hidden' }}>
                  {/* Entry marker */}
                  <div style={{ position: 'absolute', left: '50%', top: 0, width: 2, height: '100%', background: 'var(--fg-2)', transform: 'translateX(-1px)' }} />
                  {/* fill bar showing move toward TP or SL */}
                  <div style={{
                    position: 'absolute',
                    left: progressPct >= 0 ? '50%' : `${50 + progressPct/2}%`,
                    width: `${Math.abs(progressPct)/2}%`,
                    height: '100%',
                    background: progressPct >= 0 ? 'var(--up)' : 'var(--down)',
                    boxShadow: `0 0 8px ${progressPct >= 0 ? 'var(--up-glow)' : 'var(--down-glow)'}`
                  }} />
                </div>
                <div className="row between" style={{ marginTop: 4, fontSize: 10, fontFamily: 'var(--f-mono)' }}>
                  <span style={{ color: 'var(--down)' }}>SL {fmt(p.stop, 2)}</span>
                  <span style={{ color: 'var(--fg-2)' }}>ENTRY {fmt(p.entry, 2)}</span>
                  <span style={{ color: 'var(--up)' }}>TP {fmt(p.target, 2)}</span>
                </div>
              </div>

              <div className="row gap-6" style={{ marginTop: 10 }}>
                <button className="btn btn-xs">Flatten</button>
                <button className="btn btn-xs">Move SL</button>
                <span className="label-sm" style={{ marginLeft: 'auto', alignSelf: 'center' }}>{p.opened}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// -------- Engine event stream (right rail) --------
function EngineFeed() {
  const [events, setEvents] = useState(INIT_EVENTS);
  // Prepend new synthetic events every ~8s
  useEffect(() => {
    const samples = [
      { kind: 'SCAN',    msg: 'BTC-USD scanning 5m/15m', tag: 'breakout' },
      { kind: 'SCAN',    msg: 'ETH-USD z-score -0.4',    tag: 'vwap_mr' },
      { kind: 'REGIME',  msg: 'ADX holding above 30',    tag: 'system' },
      { kind: 'HEART',   msg: 'MD WS 43ms · Broker 112ms', tag: 'system' },
      { kind: 'SIGNAL',  msg: 'LINK-USD candidate p=0.62', tag: 'meta' },
    ];
    const id = setInterval(() => {
      const now = new Date();
      const ts = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}:${String(now.getUTCSeconds()).padStart(2,'0')}`;
      const s = samples[Math.floor(Math.random() * samples.length)];
      setEvents(prev => [{ ts, ...s }, ...prev].slice(0, 60));
    }, 3500);
    return () => clearInterval(id);
  }, []);

  const kindColor = (k) => ({
    FILL:    'var(--up)',
    SIGNAL:  'var(--accent-2)',
    REJECT:  'var(--fg-2)',
    RISK:    'var(--down)',
    REGIME:  'var(--warn)',
    SCAN:    'var(--fg-2)',
    HEART:   'var(--fg-2)',
    SESSION: 'var(--accent-2)',
  }[k] || 'var(--fg-1)');

  return (
    <Panel header={false} pad={0}>
      <div className="row between center" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
        <div className="row center gap-8">
          <span className="dot dot-live" />
          <div className="label">ENGINE STREAM</div>
        </div>
        <span className="label-sm">LIVE</span>
      </div>
      <div style={{ padding: '6px 0', maxHeight: 540, overflowY: 'auto' }}>
        {events.map((e, i) => (
          <div key={`${e.ts}-${i}`} style={{
            display: 'grid', gridTemplateColumns: '60px 72px 1fr',
            gap: 10, padding: '7px 16px',
            borderBottom: i < events.length - 1 ? '1px dashed var(--line)' : 'none',
            animation: i === 0 ? 'row-flash 900ms ease-out' : undefined,
            alignItems: 'center'
          }}>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{e.ts}</span>
            <span className="mono" style={{
              fontSize: 10, color: kindColor(e.kind), fontWeight: 600,
              letterSpacing: '0.08em'
            }}>{e.kind}</span>
            <span style={{ fontSize: 11.5, color: 'var(--fg-1)' }}>{e.msg}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// -------- Strategy cards --------
function StrategyCards() {
  return (
    <Panel header={false} pad={0}>
      <div className="row between center" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
        <div className="row center gap-8">
          <Icon name="layers" size={14} style={{ color: 'var(--accent-2)' }} />
          <div className="label">ACTIVE STRATEGIES</div>
        </div>
        <button className="btn btn-ghost btn-sm">Configure <Icon name="chevRight" size={12}/></button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0 }}>
        {STRATEGIES.map((s, i) => (
          <div key={s.id} style={{ padding: 16, borderRight: i < 2 ? '1px solid var(--line)' : 'none' }}>
            <div className="row between center" style={{ marginBottom: 10 }}>
              <div className="row center gap-8">
                <div style={{
                  width: 28, height: 28, borderRadius: 6,
                  background: s.kind === 'ml' ? 'var(--accent-soft)' : s.kind === 'trend' ? 'rgba(57,217,138,0.1)' : 'rgba(255,176,32,0.1)',
                  display: 'grid', placeItems: 'center',
                  color: s.kind === 'ml' ? 'var(--accent-2)' : s.kind === 'trend' ? 'var(--up)' : 'var(--warn)'
                }}>
                  <Icon name={s.kind === 'ml' ? 'brain' : s.kind === 'trend' ? 'trend' : 'activity'} size={15} stroke={1.6} />
                </div>
                <div className="col" style={{ gap: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{s.name}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-2)' }}>{s.desc}</div>
                </div>
              </div>
              <Switch on={s.enabled} onChange={()=>{}} />
            </div>

            <div className="row gap-16" style={{ marginTop: 14 }}>
              <div className="col" style={{ gap: 2 }}>
                <span className="label-sm">WIN RATE</span>
                <span className="mono" style={{ fontSize: 16 }}>
                  {s.stats.winRate ? `${(s.stats.winRate*100).toFixed(1)}%` : '—'}
                </span>
              </div>
              <div className="col" style={{ gap: 2 }}>
                <span className="label-sm">AVG R</span>
                <span className="mono" style={{ fontSize: 16, color: 'var(--up)' }}>
                  {s.stats.avgR ? `${s.stats.avgR.toFixed(2)}R` : '—'}
                </span>
              </div>
              {s.stats.lastR && (
                <div className="col" style={{ gap: 2, marginLeft: 'auto' }}>
                  <span className="label-sm">LAST 12</span>
                  <RDotStrip rs={s.stats.lastR} />
                </div>
              )}
              {s.kind === 'ml' && (
                <div className="col" style={{ gap: 2, marginLeft: 'auto' }}>
                  <span className="label-sm">ACCEPTANCE</span>
                  <span className="mono" style={{ fontSize: 16, color: 'var(--accent-2)' }}>
                    {(s.stats.acceptance*100).toFixed(0)}%
                  </span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
function RDotStrip({ rs }) {
  return (
    <div className="row gap-4" style={{ alignItems: 'center' }}>
      {rs.map((r, i) => (
        <div key={i} style={{
          width: 8, height: 14, borderRadius: 2,
          background: r >= 0 ? 'var(--up)' : 'var(--down)',
          opacity: 0.3 + Math.min(1, Math.abs(r)) * 0.7,
          boxShadow: r >= 0 ? '0 0 4px var(--up-glow)' : '0 0 4px var(--down-glow)'
        }} />
      ))}
    </div>
  );
}

// -------- System health compact --------
function SystemHealth() {
  return (
    <Panel header={false} pad={0}>
      <div className="row between center" style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
        <div className="row center gap-8">
          <Icon name="heart" size={14} style={{ color: 'var(--up)' }} />
          <div className="label">SYSTEM HEALTH</div>
        </div>
        <span className="label-sm" style={{ color: 'var(--up)' }}>● ALL GREEN</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)' }}>
        {HEALTH.map((h, i) => (
          <div key={h.k} style={{
            padding: '10px 16px',
            borderBottom: i < HEALTH.length - 2 ? '1px solid var(--line)' : 'none',
            borderRight: i % 2 === 0 ? '1px solid var(--line)' : 'none',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center'
          }}>
            <div className="row center gap-8">
              <span className="dot" style={{ background: h.ok ? 'var(--up)' : 'var(--down)' }} />
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-2)', letterSpacing: '0.06em' }}>{h.k}</span>
            </div>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-0)' }}>{h.v}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// -------- Regime panel --------
function RegimePanel() {
  return (
    <Panel header={false} pad={0}>
      <div className="row between center" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
        <div className="row center gap-8">
          <Icon name="target" size={14} style={{ color: 'var(--warn)' }} />
          <div className="label">MARKET REGIME</div>
        </div>
        <Pill tone="warn">{REGIME.label}</Pill>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ fontSize: 11, color: 'var(--fg-1)', marginBottom: 12, lineHeight: 1.5 }}>
          Trend regime confirmed (ADX {REGIME.adx}). <span style={{color:'var(--fg-0)'}}>Breakout</span> strategy favored; 
          mean-reversion suppressed.
        </div>
        <div className="col gap-8">
          <RegimeBar label="ADX"          v={REGIME.adx}          max={50} threshold={25} unit="" tone="var(--warn)" />
          <RegimeBar label="ATR PCTILE"   v={REGIME.atrPctile}    max={100} threshold={60} unit="%" tone="var(--accent-2)" />
          <RegimeBar label="SPREAD PCTILE" v={REGIME.spreadPctile} max={100} threshold={98} unit="%" tone="var(--up)" />
        </div>
      </div>
    </Panel>
  );
}
function RegimeBar({ label, v, max, threshold, unit, tone }) {
  const pct = (v / max) * 100;
  const tpct = (threshold / max) * 100;
  return (
    <div>
      <div className="row between" style={{ marginBottom: 4, fontSize: 11 }}>
        <span className="label-sm">{label}</span>
        <span className="mono">{v}{unit} <span style={{ color: 'var(--fg-3)' }}>/ thr {threshold}{unit}</span></span>
      </div>
      <div style={{ position: 'relative', height: 5, background: 'var(--bg-3)', borderRadius: 999 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: tone, borderRadius: 999, boxShadow: `0 0 8px ${tone}` }} />
        <div style={{ position: 'absolute', left: `${tpct}%`, top: -3, width: 1.5, height: 11, background: 'var(--fg-2)' }} />
      </div>
    </div>
  );
}

// -------- Dashboard page layout --------
function Dashboard({ mode, layout = 'focus' }) {
  return (
    <div className="col" style={{ gap: 16, padding: 20 }}>
      <HeroState mode={mode} />

      {layout === 'focus' ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 16 }}>
            <div className="col gap-16">
              <ChartPanel />
              <PositionStrip />
              <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 16 }}>
                <EquityPanel />
                <RegimePanel />
              </div>
              <StrategyCards />
            </div>
            <div className="col gap-16">
              <EngineFeed />
              <SystemHealth />
            </div>
          </div>
        </>
      ) : (
        <>
          {/* split layout */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <ChartPanel />
            <EquityPanel />
          </div>
          <PositionStrip />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <EngineFeed />
            <RegimePanel />
            <SystemHealth />
          </div>
          <StrategyCards />
        </>
      )}
    </div>
  );
}

Object.assign(window, { Dashboard, HeroState, ChartPanel, EquityPanel, PositionStrip, EngineFeed, StrategyCards, SystemHealth, RegimePanel });
