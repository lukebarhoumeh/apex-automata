// ============================================================
// Apex Automata — Signals page
// ============================================================

function SignalsPage() {
  const [strategies, setStrategies] = useState(STRATEGIES);
  const [sigFilter, setSigFilter] = useState('ALL');
  const [liveSignals, setLiveSignals] = useState(SIGNALS);

  useEffect(() => {
    const id = setInterval(() => {
      const sym = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
      const strat = Math.random() > 0.5 ? 'breakout' : 'vwap_mr';
      const conf = +(Math.random() * 0.45 + 0.5).toFixed(2);
      const state = conf > 0.65 ? 'ACCEPTED' : 'REJECTED';
      const now = new Date();
      const ts = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}:${String(now.getUTCSeconds()).padStart(2,'0')}`;
      const z = strat === 'vwap_mr' ? +((Math.random() - 0.5) * 5).toFixed(2) : null;
      const adx = +(Math.random() * 20 + 18).toFixed(0);
      const newSig = {
        id: `s${212 + Math.floor(Math.random() * 200)}`, ts, sym: sym.s, strat,
        side: Math.random() > 0.5 ? 'BUY' : 'SELL', conf, state, z, adx,
        note: state === 'REJECTED' ? `meta p=${conf.toFixed(2)} < 0.65` : 'confluence'
      };
      setLiveSignals(prev => [newSig, ...prev].slice(0, 60));
    }, 6000);
    return () => clearInterval(id);
  }, []);

  const updateParam = (sid, key, v) => {
    setStrategies(prev => prev.map(s => s.id === sid ? {
      ...s, params: s.params.map(p => p.key === key ? { ...p, val: v } : p)
    } : s));
  };
  const toggleEnabled = (sid) => {
    setStrategies(prev => prev.map(s => s.id === sid ? { ...s, enabled: !s.enabled } : s));
  };

  const meta = strategies.find(s => s.id === 'meta');
  const active = strategies.filter(s => s.id !== 'meta');

  const filtered = sigFilter === 'ALL' ? liveSignals : liveSignals.filter(s => s.state === sigFilter);

  const acceptRate = liveSignals.filter(s => s.state === 'ACCEPTED').length / Math.max(1, liveSignals.length);

  return (
    <div className="col" style={{ gap: 16, padding: 20 }}>
      {/* Meta model hero */}
      <Panel header={false} pad={0} className="scanlines" tone="accent">
        <div style={{ padding: 20, display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 24, position: 'relative', overflow: 'hidden' }}>
          <div style={{
            position: 'absolute', top: -80, right: -80, width: 280, height: 280, borderRadius: '50%',
            background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 70%)', opacity: 0.6, pointerEvents: 'none'
          }}/>
          <div className="col" style={{gap: 10}}>
            <div className="row center gap-8">
              <div style={{
                width: 34, height: 34, borderRadius: 8, background: 'var(--accent-soft)',
                display: 'grid', placeItems: 'center', color: 'var(--accent-2)',
                boxShadow: '0 0 0 1px rgba(59,130,246,0.3)'
              }}>
                <Icon name="brain" size={18} stroke={1.6}/>
              </div>
              <div className="col" style={{gap: 0}}>
                <div className="label" style={{color: 'var(--accent-2)'}}>META MODEL — ML FILTER</div>
                <div style={{fontSize: 16, fontWeight: 500}}>ONNX · xgb_v2.4 · 128 features</div>
              </div>
            </div>
            <div style={{fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.5, maxWidth: 440}}>
              The meta model gates every signal across strategies. It learned from <span className="mono" style={{color:'var(--fg-0)'}}>47,331</span> historical trades, ROC-AUC <span className="mono" style={{color:'var(--up)'}}>0.78</span>. 
              Raise the threshold for higher quality; lower it for more volume.
            </div>
            <div className="row gap-16" style={{marginTop: 4}}>
              <Stat label="ROC AUC" value="78.4%" tone="accent"/>
              <Stat label="PRECISION" value="64.2%"/>
              <Stat label="RECALL" value="71.8%"/>
              <Stat label="F1" value="67.8%"/>
            </div>
          </div>

          {/* Threshold control */}
          <div className="col" style={{gap: 14, padding: '0 16px', borderLeft: '1px solid var(--line)'}}>
            <div className="row between center">
              <span className="label">PROBABILITY THRESHOLD</span>
              <span className="display" style={{
                fontSize: 28, color: 'var(--accent-2)',
                textShadow: '0 0 20px var(--accent-glow)'
              }}>
                {(meta.params[0].val * 100).toFixed(0)}%
              </span>
            </div>
            <input type="range" className="slider"
              min={0.50} max={0.90} step={0.01}
              value={meta.params[0].val}
              onChange={e => updateParam('meta', 'threshold', parseFloat(e.target.value))}
            />
            <div className="row between" style={{fontSize: 10, color: 'var(--fg-3)', fontFamily: 'var(--f-mono)'}}>
              <span>50% · volume</span>
              <span>70% · balanced</span>
              <span>90% · quality</span>
            </div>
            <div className="divider"/>
            <div className="row gap-16">
              <div className="col gap-2">
                <span className="label-sm">EST TRADES/DAY</span>
                <span className="mono" style={{fontSize: 16}}>
                  ~{Math.round(12 * Math.exp(-(meta.params[0].val - 0.65) * 5))}
                </span>
              </div>
              <div className="col gap-2">
                <span className="label-sm">QUALITY BIAS</span>
                <span className="mono" style={{fontSize: 16, color: 'var(--accent-2)'}}>
                  {meta.params[0].val >= 0.75 ? 'HIGH' : meta.params[0].val >= 0.6 ? 'BALANCED' : 'VOLUME'}
                </span>
              </div>
            </div>
          </div>

          {/* Acceptance stats */}
          <div className="col" style={{gap: 12, padding: '0 0 0 16px', borderLeft: '1px solid var(--line)'}}>
            <div className="label">LAST 7 DAYS · ACCEPTANCE</div>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
              <div className="inset" style={{padding: 10}}>
                <div className="label-sm">ACCEPTED</div>
                <div className="mono" style={{fontSize: 24, fontWeight: 500, color: 'var(--up)'}}>
                  {Math.round(liveSignals.filter(s=>s.state==='ACCEPTED').length)}
                </div>
                <div style={{fontSize:10.5, color: 'var(--fg-2)'}}>of {liveSignals.length} signals</div>
              </div>
              <div className="inset" style={{padding: 10}}>
                <div className="label-sm">REJECTED</div>
                <div className="mono" style={{fontSize: 24, fontWeight: 500, color: 'var(--fg-1)'}}>
                  {liveSignals.filter(s=>s.state==='REJECTED').length}
                </div>
                <div style={{fontSize:10.5, color: 'var(--fg-2)'}}>low confidence</div>
              </div>
            </div>
            <div>
              <div className="row between" style={{marginBottom: 4, fontSize: 11}}>
                <span className="label-sm">ACCEPTANCE RATE</span>
                <span className="mono" style={{color: 'var(--accent-2)'}}>{(acceptRate*100).toFixed(1)}%</span>
              </div>
              <div className="bar"><div style={{width: `${acceptRate*100}%`, background: 'var(--accent)', boxShadow: '0 0 8px var(--accent-glow)'}}/></div>
            </div>
          </div>
        </div>
      </Panel>

      {/* Strategy cards (full config) */}
      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16}}>
        {active.map(s => (
          <StrategyConfigCard key={s.id} strat={s} onParam={updateParam} onToggle={toggleEnabled} />
        ))}
      </div>

      {/* Signals history */}
      <Panel header={false} pad={0}>
        <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
          <div className="row center gap-12">
            <div className="row center gap-8">
              <Icon name="pulse" size={14} style={{color: 'var(--accent-2)'}}/>
              <div className="label">SIGNAL STREAM</div>
            </div>
            <div className="row center gap-6">
              <span className="dot dot-live"/>
              <span className="mono" style={{fontSize: 10.5, color: 'var(--fg-2)'}}>LIVE</span>
            </div>
          </div>
          <Segmented value={sigFilter} onChange={setSigFilter} options={[
            {v:'ALL',l:'ALL'},{v:'ACCEPTED',l:'ACCEPTED'},{v:'REJECTED',l:'REJECTED'},{v:'CANCELLED',l:'CANCEL'}
          ]}/>
        </div>
        <div style={{maxHeight: 440, overflowY: 'auto'}}>
          <table className="t">
            <thead>
              <tr>
                <th>TIME</th><th>SYMBOL</th><th>STRATEGY</th><th>SIDE</th>
                <th>CONFIDENCE</th><th className="num">Z</th><th className="num">ADX</th>
                <th>NOTE</th><th>STATE</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id}>
                  <td className="mono fg-2" style={{fontSize: 11}}>{s.ts}</td>
                  <td style={{fontWeight: 500}}>{s.sym}</td>
                  <td className="mono" style={{fontSize: 11, color: 'var(--fg-1)'}}>{s.strat}</td>
                  <td>
                    <Pill tone={s.side === 'BUY' ? 'up' : 'down'}>{s.side}</Pill>
                  </td>
                  <td>
                    <div className="row center gap-8">
                      <div style={{width: 60, position: 'relative', height: 4, background: 'var(--bg-3)', borderRadius: 999}}>
                        <div style={{
                          width: `${s.conf*100}%`, height: '100%',
                          background: s.conf >= 0.65 ? 'var(--accent)' : 'var(--fg-2)',
                          borderRadius: 999,
                          boxShadow: s.conf >= 0.65 ? '0 0 6px var(--accent-glow)' : 'none'
                        }}/>
                        {/* threshold marker */}
                        <div style={{position: 'absolute', left: '65%', top: -2, width: 1, height: 8, background: 'var(--fg-2)'}}/>
                      </div>
                      <span className="mono" style={{fontSize: 11, color: s.conf >= 0.65 ? 'var(--accent-2)' : 'var(--fg-2)'}}>
                        {(s.conf*100).toFixed(0)}%
                      </span>
                    </div>
                  </td>
                  <td className="num">{s.z != null ? s.z.toFixed(2) : '—'}</td>
                  <td className="num">{s.adx}</td>
                  <td style={{fontSize: 11, color: 'var(--fg-2)'}}>{s.note}</td>
                  <td>
                    <Pill tone={s.state==='ACCEPTED'?'up':s.state==='REJECTED'?null:'warn'}>
                      {s.state}
                    </Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function StrategyConfigCard({ strat, onParam, onToggle }) {
  const color = strat.kind === 'trend' ? 'var(--up)' : 'var(--warn)';
  const bgSoft = strat.kind === 'trend' ? 'rgba(57,217,138,0.08)' : 'rgba(255,176,32,0.08)';

  return (
    <Panel header={false} pad={0} style={{opacity: strat.enabled ? 1 : 0.6}}>
      <div className="row between center" style={{padding: '14px 16px', borderBottom: '1px solid var(--line)'}}>
        <div className="row center gap-10">
          <div style={{
            width: 32, height: 32, borderRadius: 7, background: bgSoft,
            display: 'grid', placeItems: 'center', color,
            boxShadow: `0 0 0 1px ${bgSoft}`
          }}>
            <Icon name={strat.kind === 'trend' ? 'trend' : 'activity'} size={16} stroke={1.6}/>
          </div>
          <div className="col gap-2">
            <div style={{fontSize: 14, fontWeight: 600}}>{strat.name}</div>
            <div style={{fontSize: 11, color: 'var(--fg-2)'}}>{strat.desc}</div>
          </div>
        </div>
        <Switch on={strat.enabled} onChange={() => onToggle(strat.id)}/>
      </div>

      {/* Params */}
      <div style={{padding: 16, display: 'flex', flexDirection: 'column', gap: 16}}>
        {strat.params.map(p => (
          <div key={p.key}>
            <div className="row between" style={{marginBottom: 6, fontSize: 12}}>
              <span className="label">{p.label}</span>
              <span className="mono" style={{fontSize: 12, color: 'var(--fg-0)'}}>{p.format(p.val)}</span>
            </div>
            <input type="range" className="slider"
              min={p.min} max={p.max} step={p.step} value={p.val}
              onChange={e => onParam(strat.id, p.key, parseFloat(e.target.value))}
            />
            <div className="row between" style={{marginTop: 2, fontSize: 9.5, color: 'var(--fg-3)', fontFamily: 'var(--f-mono)'}}>
              <span>{p.format(p.min)}</span>
              <span>{p.format(p.max)}</span>
            </div>
          </div>
        ))}

        <div className="divider"/>

        <div className="row between">
          <div className="col gap-2">
            <span className="label-sm">WIN RATE</span>
            <span className="mono" style={{fontSize: 18}}>{(strat.stats.winRate*100).toFixed(1)}%</span>
          </div>
          <div className="col gap-2">
            <span className="label-sm">AVG R</span>
            <span className="mono" style={{fontSize: 18, color: 'var(--up)'}}>{strat.stats.avgR.toFixed(2)}R</span>
          </div>
          <div className="col gap-2">
            <span className="label-sm">TRADES</span>
            <span className="mono" style={{fontSize: 18}}>{strat.stats.trades}</span>
          </div>
          <div className="col gap-2" style={{marginLeft: 'auto'}}>
            <span className="label-sm">LAST 12 R</span>
            <RDotStrip rs={strat.stats.lastR}/>
          </div>
        </div>
      </div>
    </Panel>
  );
}

Object.assign(window, { SignalsPage });
