// ============================================================
// Apex Automata — Backtest page
// ============================================================

function BacktestPage() {
  const B = BACKTEST;
  const [cfg, setCfg] = useState(B.config);
  const [running, setRunning] = useState(false);
  const [ranOnce, setRanOnce] = useState(true);

  const runBacktest = () => {
    setRunning(true);
    setTimeout(() => { setRunning(false); setRanOnce(true); }, 1800);
  };

  const [size, setSize] = useState({ w: 800, h: 280 });
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(es => { for (const e of es) setSize({ w: Math.floor(e.contentRect.width), h: 280 }); });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="col" style={{gap: 16, padding: 20}}>
      {/* HERO */}
      <Panel header={false} pad={0} className="scanlines" style={{
        background: 'linear-gradient(135deg, var(--bg-1) 0%, #0d121c 60%, var(--bg-1) 100%)',
        borderColor: 'rgba(57,217,138,0.18)', position: 'relative', overflow: 'hidden'
      }}>
        <div className="gridbg" style={{position: 'absolute', inset: 0, opacity: 0.5, pointerEvents: 'none'}}/>
        <div style={{
          position: 'absolute', top: -120, right: -120, width: 360, height: 360, borderRadius: '50%',
          background: 'radial-gradient(circle, var(--up-glow) 0%, transparent 70%)', opacity: 0.5, pointerEvents: 'none'
        }}/>
        <div style={{padding: 28, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 28, position: 'relative'}}>
          <div className="col gap-12">
            <div className="row center gap-8">
              <Pill tone="up"><Icon name="flask" size={10} stroke={2}/> BACKTEST ENGINE</Pill>
              <span className="pill">v2.4.1</span>
            </div>
            <div style={{
              fontFamily: 'var(--f-serif)', fontStyle: 'italic',
              fontSize: 38, lineHeight: 1.05, fontWeight: 500, letterSpacing: '-0.02em'
            }}>
              <span style={{color: 'var(--up)'}}>Test</span> before<br/>you <span style={{color: 'var(--fg-1)'}}>trust.</span>
            </div>
            <div style={{fontSize: 12.5, color: 'var(--fg-1)', maxWidth: 380, lineHeight: 1.55}}>
              Simulated <span className="mono" style={{color: 'var(--fg-0)'}}>{B.results.trades}</span> trades across
              <span className="mono" style={{color: 'var(--fg-0)'}}> {cfg.symbols.length}</span> symbols over
              <span className="mono" style={{color: 'var(--fg-0)'}}> 90 days</span>. Fees and slippage modeled.
            </div>
          </div>

          <div className="col gap-10" style={{borderLeft: '1px solid var(--line)', paddingLeft: 24}}>
            <div className="eyebrow">RETURN · SHARPE · DD</div>
            <div>
              <div className="display" style={{fontSize: 48, color: 'var(--up)', lineHeight: 1, textShadow: '0 0 24px var(--up-glow)'}}>
                +{B.results.totalReturn.toFixed(2)}%
              </div>
              <div className="label-sm" style={{marginTop: 4}}>TOTAL RETURN · 90D</div>
            </div>
            <div className="row gap-20" style={{marginTop: 6}}>
              <div><div className="label-sm">SHARPE</div><div className="mono" style={{fontSize: 18, color: 'var(--up)'}}>{B.results.sharpe.toFixed(2)}</div></div>
              <div><div className="label-sm">SORTINO</div><div className="mono" style={{fontSize: 18}}>{B.results.sortino.toFixed(2)}</div></div>
              <div><div className="label-sm">MAX DD</div><div className="mono" style={{fontSize: 18, color: 'var(--down)'}}>-{B.results.maxDD.toFixed(1)}%</div></div>
            </div>
          </div>

          <div className="col gap-8" style={{borderLeft: '1px solid var(--line)', paddingLeft: 24}}>
            <div className="eyebrow">TRADE ECONOMICS</div>
            <FingerprintRow k="WIN RATE"       v={`${(B.results.winRate*100).toFixed(1)}%`}/>
            <FingerprintRow k="AVG R"          v={`${B.results.avgR.toFixed(2)}R`}/>
            <FingerprintRow k="PROFIT FACTOR"  v={B.results.profitFactor.toFixed(2)}/>
            <FingerprintRow k="TRADES"         v={B.results.trades}/>
            <FingerprintRow k="AVG HOLD"       v={`${B.results.avgHoldHrs}h`}/>
            <FingerprintRow k="TURNOVER"       v={`${B.results.turnover}×`}/>
          </div>
        </div>
      </Panel>

      {/* Config + run */}
      <Panel header={false} pad={0}>
        <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
          <div className="row center gap-8">
            <Icon name="settings" size={14} style={{color: 'var(--accent-2)'}}/>
            <div className="label">CONFIGURATION</div>
          </div>
          <div className="row center gap-6">
            <span className="mono" style={{fontSize: 11, color: 'var(--fg-2)'}}>{B.preset}</span>
          </div>
        </div>
        <div style={{padding: 20, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr) auto', gap: 16, alignItems: 'end'}}>
          <ConfigField label="STRATEGY">
            <select value={cfg.strategy} onChange={e => setCfg({...cfg, strategy: e.target.value})} style={{width: '100%'}}>
              <option>Breakout · 20/55 Donchian</option>
              <option>VWAP Mean Reversion</option>
              <option>Meta-Blend (ML)</option>
            </select>
          </ConfigField>
          <ConfigField label="SYMBOLS">
            <div className="row gap-4" style={{flexWrap: 'wrap'}}>
              {SYMBOLS.map(s => {
                const on = cfg.symbols.includes(s.s);
                return (
                  <button key={s.s} className={on ? 'btn btn-xs btn-primary' : 'btn btn-xs'}
                    onClick={() => setCfg({...cfg, symbols: on ? cfg.symbols.filter(x => x !== s.s) : [...cfg.symbols, s.s]})}>
                    {s.s.split('-')[0]}
                  </button>
                );
              })}
            </div>
          </ConfigField>
          <ConfigField label="DATE RANGE">
            <div className="row gap-6">
              <input type="text" value={cfg.from} onChange={e => setCfg({...cfg, from: e.target.value})} style={{width: 95, fontSize: 11}} className="mono"/>
              <span style={{alignSelf: 'center', color: 'var(--fg-2)'}}>→</span>
              <input type="text" value={cfg.to} onChange={e => setCfg({...cfg, to: e.target.value})} style={{width: 95, fontSize: 11}} className="mono"/>
            </div>
          </ConfigField>
          <ConfigField label="INITIAL CAPITAL">
            <input type="text" value={`$${fmt(cfg.initialCapital, 0)}`} onChange={() => {}} style={{width: '100%'}} className="mono"/>
          </ConfigField>
          <button className="btn btn-primary" style={{height: 40, padding: '0 20px'}} onClick={runBacktest} disabled={running}>
            {running ? <><Icon name="refresh" size={14}/> Running…</> : <><Icon name="play" size={14}/> RUN BACKTEST</>}
          </button>
        </div>
        <div style={{padding: '0 20px 20px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16}}>
          <ConfigSlider label="RISK PER TRADE" value={cfg.riskPerTrade} min={0.1} max={2.0} step={0.1} unit="%"
            onChange={v => setCfg({...cfg, riskPerTrade: v})}/>
          <ConfigSlider label="META THRESHOLD" value={cfg.metaThreshold} min={0.5} max={0.9} step={0.01} unit=""
            format={v => `${(v*100).toFixed(0)}%`} onChange={v => setCfg({...cfg, metaThreshold: v})}/>
          <ConfigSlider label="SLIPPAGE (BPS)" value={cfg.slippageBps} min={0} max={10} step={0.5} unit="bp"
            onChange={v => setCfg({...cfg, slippageBps: v})}/>
          <ConfigSlider label="FEE (BPS)" value={cfg.feeBps} min={0} max={30} step={0.5} unit="bp"
            onChange={v => setCfg({...cfg, feeBps: v})}/>
        </div>
      </Panel>

      {/* Equity + DD + Monthly */}
      <div style={{display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16}}>
        <Panel header={false} pad={0}>
          <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="row center gap-8">
              <Icon name="trend" size={14} style={{color: 'var(--up)'}}/>
              <div className="label">EQUITY CURVE · DRAWDOWN UNDERLAY</div>
            </div>
            <div className="row center gap-16" style={{fontSize: 11}}>
              <div className="row center gap-6"><div style={{width: 12, height: 2, background: 'var(--up)'}}/><span className="label-sm">EQUITY</span></div>
              <div className="row center gap-6"><div style={{width: 12, height: 6, background: 'rgba(255,90,106,0.4)'}}/><span className="label-sm">DRAWDOWN</span></div>
            </div>
          </div>
          <div ref={ref} style={{padding: '8px 4px 4px'}}>
            <EquityWithDD data={B.equity} width={size.w - 8} height={size.h}/>
          </div>
        </Panel>

        <Panel header={false} pad={0}>
          <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="label">MONTHLY RETURNS</div>
          </div>
          <div style={{padding: 16}}>
            {B.monthlyReturns.map(m => (
              <div key={m.m} style={{display: 'grid', gridTemplateColumns: '50px 1fr 70px', gap: 10, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--line)'}}>
                <span className="mono" style={{fontSize: 12, color: 'var(--fg-1)'}}>{m.m}</span>
                <div style={{position: 'relative', height: 14}}>
                  <div style={{position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--line-2)'}}/>
                  <div style={{
                    position: 'absolute', top: 2, height: 10,
                    left: m.r >= 0 ? '50%' : `calc(50% - ${Math.abs(m.r)*5}px)`,
                    width: Math.abs(m.r)*5,
                    background: m.r >= 0 ? 'var(--up)' : 'var(--down)',
                    boxShadow: m.r >= 0 ? '0 0 6px var(--up-glow)' : '0 0 6px var(--down-glow)',
                    borderRadius: m.r >= 0 ? '0 3px 3px 0' : '3px 0 0 3px',
                  }}/>
                </div>
                <span className="mono" style={{fontSize: 13, textAlign: 'right', color: m.r >= 0 ? 'var(--up)' : 'var(--down)'}}>
                  {m.r >= 0 ? '+' : ''}{m.r.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* R distribution + Trade log */}
      <div style={{display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16}}>
        <Panel header={false} pad={0}>
          <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="label">R-MULTIPLE DISTRIBUTION</div>
            <span className="pill">{B.results.trades} TRADES</span>
          </div>
          <div style={{padding: 16}}>
            <RHistogram data={B.rDist}/>
          </div>
        </Panel>

        <Panel header={false} pad={0}>
          <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="label">TRADE LOG · SAMPLE</div>
            <button className="btn btn-ghost btn-sm"><Icon name="download" size={12}/> CSV</button>
          </div>
          <table className="t">
            <thead>
              <tr><th>DATE</th><th>SYM</th><th>SIDE</th><th className="num">ENTRY</th><th className="num">EXIT</th><th className="num">R</th><th className="num">P&L</th><th>HOLD</th></tr>
            </thead>
            <tbody>
              {B.trades.map(t => (
                <tr key={t.id}>
                  <td className="mono" style={{fontSize: 11, color: 'var(--fg-2)'}}>{t.date}</td>
                  <td style={{fontWeight: 500}}>{t.sym}</td>
                  <td><Pill tone={t.side==='LONG'?'up':'down'}>{t.side}</Pill></td>
                  <td className="num">{fmt(t.entry, 2)}</td>
                  <td className="num">{fmt(t.exit, 2)}</td>
                  <td className="num" style={{color: t.r >= 0 ? 'var(--up)' : 'var(--down)'}}>{t.r >= 0 ? '+' : ''}{t.r.toFixed(2)}R</td>
                  <td className="num" style={{color: t.pnl >= 0 ? 'var(--up)' : 'var(--down)'}}>{t.pnl >= 0 ? '+' : ''}${fmt(Math.abs(t.pnl), 0)}</td>
                  <td className="mono" style={{fontSize: 11, color: 'var(--fg-1)'}}>{t.dur}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}

function ConfigField({ label, children }) {
  return (
    <div className="col gap-6">
      <span className="label-sm">{label}</span>
      {children}
    </div>
  );
}
function ConfigSlider({ label, value, min, max, step, unit = '', format, onChange }) {
  return (
    <div>
      <div className="row between" style={{marginBottom: 6}}>
        <span className="label-sm">{label}</span>
        <span className="mono" style={{fontSize: 11, color: 'var(--fg-0)'}}>{format ? format(value) : `${value}${unit}`}</span>
      </div>
      <input type="range" className="slider" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}/>
    </div>
  );
}

function EquityWithDD({ data, width, height }) {
  const padL = 50, padR = 50, padT = 14, padB = 22;
  const iw = width - padL - padR, ih = height - padT - padB;
  const vMin = Math.min(...data.map(d => d.v)) * 0.99;
  const vMax = Math.max(...data.map(d => d.v)) * 1.01;
  const vSpan = vMax - vMin || 1;
  const ddMin = Math.min(...data.map(d => d.dd));
  const step = iw / (data.length - 1);
  const yE = v => padT + ih*0.7 - ((v - vMin)/vSpan) * ih*0.7;
  const yD = d => padT + ih*0.72 + (Math.abs(d)/Math.abs(ddMin || 1)) * (ih*0.26);

  const eqD = data.map((d, i) => `${i===0?'M':'L'}${padL + i*step},${yE(d.v)}`).join(' ');
  const ddD = data.map((d, i) => `${i===0?'M':'L'}${padL + i*step},${yD(d.dd)}`).join(' ');
  const ddFill = `${ddD} L${padL + (data.length-1)*step},${padT + ih*0.72} L${padL},${padT + ih*0.72} Z`;
  const eqFill = `${eqD} L${padL + (data.length-1)*step},${padT + ih*0.7} L${padL},${padT + ih*0.7} Z`;

  return (
    <svg width={width} height={height} style={{display: 'block'}}>
      <defs>
        <linearGradient id="eqg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--up)" stopOpacity="0.3"/>
          <stop offset="100%" stopColor="var(--up)" stopOpacity="0"/>
        </linearGradient>
      </defs>
      {/* grid */}
      {[0, 0.25, 0.5, 0.75].map(t => (
        <line key={t} x1={padL} x2={padL + iw} y1={padT + ih*0.7*t} y2={padT + ih*0.7*t} stroke="var(--line)" strokeDasharray="2 3"/>
      ))}
      {/* equity value labels left */}
      {[vMax, (vMax+vMin)/2, vMin].map((v, i) => (
        <text key={i} x={padL - 6} y={yE(v) + 3} textAnchor="end" fontSize="9.5" fontFamily="var(--f-mono)" fill="var(--fg-2)">
          ${fmt(v/1000, 0)}k
        </text>
      ))}
      {/* equity */}
      <path d={eqFill} fill="url(#eqg)"/>
      <path d={eqD} fill="none" stroke="var(--up)" strokeWidth="1.6"/>
      {/* dd section divider */}
      <line x1={padL} x2={padL + iw} y1={padT + ih*0.72} y2={padT + ih*0.72} stroke="var(--line-2)"/>
      <text x={padL + 4} y={padT + ih*0.72 + 12} fontSize="9" fontFamily="var(--f-mono)" fill="var(--fg-2)">DRAWDOWN</text>
      {/* dd */}
      <path d={ddFill} fill="var(--down)" fillOpacity="0.22"/>
      <path d={ddD} fill="none" stroke="var(--down)" strokeWidth="1.2"/>
      <text x={padL - 6} y={padT + ih - 4} textAnchor="end" fontSize="9.5" fontFamily="var(--f-mono)" fill="var(--down)">
        {ddMin.toFixed(1)}%
      </text>
    </svg>
  );
}

function RHistogram({ data }) {
  const max = Math.max(...data.map(d => d.n));
  return (
    <div className="col" style={{gap: 8}}>
      {data.map(b => {
        const isLoss = b.bucket.startsWith('<') || b.bucket.startsWith('-');
        return (
          <div key={b.bucket} style={{display: 'grid', gridTemplateColumns: '68px 1fr 32px', gap: 8, alignItems: 'center'}}>
            <span className="mono" style={{fontSize: 10.5, color: 'var(--fg-2)', textAlign: 'right'}}>{b.bucket}</span>
            <div className="bar" style={{height: 14}}>
              <div style={{
                width: `${(b.n / max) * 100}%`,
                background: isLoss ? 'var(--down)' : 'var(--up)',
                boxShadow: isLoss ? '0 0 6px var(--down-glow)' : '0 0 6px var(--up-glow)',
                opacity: 0.8,
              }}/>
            </div>
            <span className="mono" style={{fontSize: 11, color: 'var(--fg-0)', textAlign: 'right'}}>{b.n}</span>
          </div>
        );
      })}
    </div>
  );
}

Object.assign(window, { BacktestPage });
