// ============================================================
// Apex Automata — Model page
// ============================================================

function ModelPage() {
  const M = MODEL;
  const [selectedFeature, setSelectedFeature] = useState(M.shap[0].k);
  const [thresh, setThresh] = useState(0.5);

  // Live inference ticker
  const [infer, setInfer] = useState(M.infer);
  useEffect(() => {
    const id = setInterval(() => {
      const sym = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)].s;
      const p = +(Math.random() * 0.5 + 0.4).toFixed(2);
      const now = new Date();
      const ts = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}:${String(now.getUTCSeconds()).padStart(2,'0')}`;
      const tops = ['regime_adx · volume_z', 'breakout_width · vwap_dist', 'spread_pctile · rv_24h', 'hour_of_day · regime_adx'];
      setInfer(prev => [{ ts, sym, p, state: p >= 0.65 ? 'ACCEPTED' : 'REJECTED', top: tops[Math.floor(Math.random()*tops.length)] }, ...prev].slice(0, 12));
    }, 4000);
    return () => clearInterval(id);
  }, []);

  // Current example prediction SHAP
  const basePred = 0.5;
  const contrib = M.shap.reduce((s, f) => s + f.v, 0);
  const finalP = Math.max(0, Math.min(1, basePred + contrib));

  // Confusion matrix derived
  const { tp, fp, fn, tn } = M.cm;
  const total = tp + fp + fn + tn;
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  const accuracy = (tp + tn) / total;

  return (
    <div className="col" style={{gap: 16, padding: 20}}>
      {/* HERO */}
      <Panel header={false} pad={0} className="scanlines" style={{
        background: 'linear-gradient(135deg, var(--bg-1) 0%, #0d121c 60%, var(--bg-1) 100%)',
        borderColor: 'rgba(59,130,246,0.2)', overflow: 'hidden', position: 'relative'
      }}>
        <div className="gridbg" style={{position: 'absolute', inset: 0, opacity: 0.5, pointerEvents: 'none'}}/>
        <div style={{
          position: 'absolute', top: -120, left: -120, width: 400, height: 400, borderRadius: '50%',
          background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 70%)', opacity: 0.55, pointerEvents: 'none'
        }}/>
        <div style={{padding: 28, display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr', gap: 28, position: 'relative'}}>
          <div className="col gap-12">
            <div className="row center gap-8">
              <div style={{
                width: 42, height: 42, borderRadius: 8, background: 'var(--accent-soft)',
                display: 'grid', placeItems: 'center', color: 'var(--accent-2)',
                boxShadow: '0 0 0 1px rgba(59,130,246,0.3), 0 8px 18px -4px var(--accent-glow)'
              }}>
                <Icon name="brain" size={22} stroke={1.5}/>
              </div>
              <div className="col" style={{gap: 0}}>
                <div className="eyebrow" style={{color: 'var(--accent-2)'}}>META MODEL · ACTIVE</div>
                <div style={{fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em'}}>{M.name}</div>
              </div>
            </div>
            <div style={{
              fontFamily: 'var(--f-serif)', fontStyle: 'italic',
              fontSize: 32, lineHeight: 1.1, fontWeight: 500, letterSpacing: '-0.02em'
            }}>
              The model that <span style={{color: 'var(--accent-2)'}}>decides</span><br/>
              which signals <span style={{color: 'var(--fg-1)'}}>earn capital.</span>
            </div>
            <div style={{fontSize: 12.5, color: 'var(--fg-1)', lineHeight: 1.5, maxWidth: 400}}>
              {M.arch}. Trained on <span className="mono" style={{color: 'var(--fg-0)'}}>{fmt(M.trainedOn, 0)}</span> signals.
              Last retrained <span className="mono" style={{color: 'var(--fg-0)'}}>{M.trainedAt}</span>.
            </div>
            <div className="row gap-6">
              <button className="btn btn-sm"><Icon name="refresh" size={12}/> Retrain</button>
              <button className="btn btn-sm"><Icon name="download" size={12}/> Export ONNX</button>
              <button className="btn btn-sm btn-ghost">Rollback</button>
            </div>
          </div>

          {/* Metric constellation */}
          <div className="col gap-12" style={{borderLeft: '1px solid var(--line)', paddingLeft: 24}}>
            <div className="eyebrow">PERFORMANCE</div>
            <div className="row between" style={{alignItems: 'baseline'}}>
              <div>
                <div className="display" style={{fontSize: 48, color: 'var(--accent-2)', textShadow: '0 0 24px var(--accent-glow)', lineHeight: 1}}>
                  {(M.rocAuc * 100).toFixed(1)}
                </div>
                <div className="label-sm" style={{marginTop: 4}}>ROC AUC %</div>
              </div>
              <Sparkline data={[0.68, 0.70, 0.71, 0.74, 0.76, 0.78, 0.78, 0.78]} width={120} height={40} color="var(--accent)" strokeW={1.8}/>
            </div>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
              <MetricTile label="PRECISION" value={`${(M.precision*100).toFixed(1)}%`} tone="var(--up)"/>
              <MetricTile label="RECALL"    value={`${(M.recall*100).toFixed(1)}%`}    tone="var(--accent-2)"/>
              <MetricTile label="F1 SCORE"  value={`${(M.f1*100).toFixed(1)}%`}/>
              <MetricTile label="BRIER"     value={M.brier.toFixed(3)} tone="var(--warn)"/>
            </div>
          </div>

          {/* Model fingerprint */}
          <div className="col gap-8" style={{borderLeft: '1px solid var(--line)', paddingLeft: 24}}>
            <div className="eyebrow">FINGERPRINT</div>
            <FingerprintRow k="ARCH"     v={M.arch}/>
            <FingerprintRow k="FEATURES" v={M.features}/>
            <FingerprintRow k="PARAMS"   v={M.params}/>
            <FingerprintRow k="FILE"     v={M.file} mono/>
            <FingerprintRow k="SIZE"     v={M.size}/>
            <FingerprintRow k="TRAINED"  v={M.trainedAt.slice(0,10)}/>
            <div className="divider" style={{margin: '6px 0'}}/>
            <div className="row center gap-8">
              <span className="dot dot-live"/>
              <span className="mono" style={{fontSize: 11, color: 'var(--up)'}}>SERVING · 4.2ms p50</span>
            </div>
          </div>
        </div>
      </Panel>

      {/* SHAP waterfall + Live inference */}
      <div style={{display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16}}>
        <Panel header={false} pad={0}>
          <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="row center gap-8">
              <Icon name="pulse" size={14} style={{color: 'var(--accent-2)'}}/>
              <div className="label">FEATURE ATTRIBUTION · SHAP</div>
            </div>
            <span className="pill pill-accent">BTC-USD · 14:22:04</span>
          </div>
          <div style={{padding: 20}}>
            <div className="row between" style={{marginBottom: 14}}>
              <div>
                <div className="label-sm">BASE RATE</div>
                <div className="mono" style={{fontSize: 20, color: 'var(--fg-1)'}}>{(basePred*100).toFixed(0)}%</div>
              </div>
              <Icon name="arrowRight" size={18} style={{color: 'var(--fg-3)', alignSelf: 'center'}}/>
              <div style={{textAlign: 'right'}}>
                <div className="label-sm">FINAL PROBABILITY</div>
                <div className="display" style={{fontSize: 24, color: finalP >= 0.65 ? 'var(--up)' : 'var(--down)'}}>
                  {(finalP*100).toFixed(1)}%
                </div>
              </div>
            </div>
            <ShapWaterfall base={basePred} features={M.shap}/>
            <div className="label-sm" style={{marginTop: 8, textAlign: 'center'}}>
              ← DECREASES P &nbsp;&nbsp; · &nbsp;&nbsp; INCREASES P →
            </div>
          </div>
        </Panel>

        <Panel header={false} pad={0}>
          <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="row center gap-8">
              <span className="dot dot-live"/>
              <div className="label">LIVE INFERENCE TRACE</div>
            </div>
            <span className="mono" style={{fontSize: 10.5, color: 'var(--fg-2)'}}>LAST {infer.length}</span>
          </div>
          <div style={{maxHeight: 420, overflowY: 'auto'}}>
            {infer.map((r, i) => (
              <div key={r.ts + i} style={{
                padding: '10px 16px',
                borderBottom: i < infer.length - 1 ? '1px solid var(--line)' : 'none',
                animation: i === 0 ? 'row-flash 900ms ease-out' : undefined,
              }}>
                <div className="row between" style={{marginBottom: 4}}>
                  <div className="row center gap-8">
                    <span className="mono" style={{fontSize: 10.5, color: 'var(--fg-3)'}}>{r.ts}</span>
                    <span style={{fontWeight: 500, fontSize: 12.5}}>{r.sym}</span>
                  </div>
                  <Pill tone={r.state === 'ACCEPTED' ? 'up' : null}>
                    {r.state}
                  </Pill>
                </div>
                <div className="row center gap-8">
                  <div className="bar" style={{flex: 1, height: 4}}>
                    <div style={{
                      width: `${r.p * 100}%`,
                      background: r.p >= 0.65 ? 'var(--up)' : 'var(--fg-2)',
                      boxShadow: r.p >= 0.65 ? '0 0 6px var(--up-glow)' : 'none'
                    }}/>
                  </div>
                  <span className="mono" style={{fontSize: 11, color: r.p >= 0.65 ? 'var(--up)' : 'var(--fg-2)', minWidth: 36}}>
                    {(r.p*100).toFixed(0)}%
                  </span>
                </div>
                <div style={{fontSize: 10.5, color: 'var(--fg-2)', marginTop: 3, fontFamily: 'var(--f-mono)'}}>
                  top: {r.top}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* Confusion matrix + Calibration curve + Training runs */}
      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16}}>
        <Panel header={false} pad={0}>
          <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="row center gap-8">
              <Icon name="grid" size={14} style={{color: 'var(--accent-2)'}}/>
              <div className="label">CONFUSION MATRIX</div>
            </div>
            <span className="mono" style={{fontSize: 10.5, color: 'var(--fg-2)'}}>N = {fmt(total, 0)}</span>
          </div>
          <div style={{padding: 20, display: 'grid', gridTemplateColumns: '1fr auto', gap: 24, alignItems: 'center'}}>
            <ConfusionMatrixViz cm={M.cm}/>
            <div className="col gap-10" style={{minWidth: 140}}>
              <div><div className="label-sm">ACCURACY</div><div className="mono" style={{fontSize: 18}}>{(accuracy*100).toFixed(1)}%</div></div>
              <div><div className="label-sm">PRECISION</div><div className="mono" style={{fontSize: 18, color: 'var(--up)'}}>{(precision*100).toFixed(1)}%</div></div>
              <div><div className="label-sm">RECALL</div><div className="mono" style={{fontSize: 18, color: 'var(--accent-2)'}}>{(recall*100).toFixed(1)}%</div></div>
              <div><div className="label-sm">FALSE POS RATE</div><div className="mono" style={{fontSize: 14, color: 'var(--warn)'}}>{(fp/(fp+tn)*100).toFixed(1)}%</div></div>
            </div>
          </div>
        </Panel>

        <Panel header={false} pad={0}>
          <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="row center gap-8">
              <Icon name="chart" size={14} style={{color: 'var(--up)'}}/>
              <div className="label">CALIBRATION CURVE</div>
            </div>
            <span className="pill pill-accent">WELL CALIBRATED</span>
          </div>
          <div style={{padding: 16}}>
            <CalibrationChart data={M.calibration} width={380} height={240}/>
            <div style={{fontSize: 11.5, color: 'var(--fg-2)', marginTop: 8, lineHeight: 1.5}}>
              When the model predicts X%, outcomes actually occur at ≈X%. Divergence from the diagonal = miscalibration.
            </div>
          </div>
        </Panel>
      </div>

      {/* Training runs */}
      <Panel header={false} pad={0}>
        <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
          <div className="row center gap-8">
            <Icon name="flask" size={14} style={{color: 'var(--warn)'}}/>
            <div className="label">TRAINING RUNS · VERSION HISTORY</div>
          </div>
          <button className="btn btn-primary btn-sm"><Icon name="refresh" size={12}/> New run</button>
        </div>
        <table className="t">
          <thead>
            <tr><th>VERSION</th><th>DATE</th><th className="num">ROC AUC</th><th className="num">PRECISION</th><th className="num">TRADES</th><th>NOTE</th><th></th></tr>
          </thead>
          <tbody>
            {M.runs.map(r => (
              <tr key={r.v}>
                <td>
                  <div className="row center gap-8">
                    <span className="mono" style={{fontWeight: 500, color: r.live ? 'var(--accent-2)' : 'var(--fg-0)'}}>{r.v}</span>
                    {r.live && <Pill tone="accent">LIVE</Pill>}
                  </div>
                </td>
                <td className="mono" style={{color: 'var(--fg-2)'}}>{r.date}</td>
                <td className="num">
                  <span className="mono" style={{color: r.live ? 'var(--up)' : 'var(--fg-1)'}}>{(r.auc*100).toFixed(1)}%</span>
                </td>
                <td className="num">{(r.prec*100).toFixed(1)}%</td>
                <td className="num">{fmt(r.trades, 0)}</td>
                <td style={{color: 'var(--fg-1)', fontSize: 12}}>{r.note}</td>
                <td className="num">
                  {!r.live && <button className="btn btn-xs">Rollback</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function MetricTile({ label, value, tone }) {
  return (
    <div className="inset" style={{padding: 10}}>
      <div className="label-sm">{label}</div>
      <div className="mono" style={{fontSize: 20, fontWeight: 500, color: tone || 'var(--fg-0)', marginTop: 2}}>
        {value}
      </div>
    </div>
  );
}

function FingerprintRow({ k, v, mono }) {
  return (
    <div className="row between" style={{fontSize: 11.5}}>
      <span className="label-sm">{k}</span>
      <span className={mono ? 'mono' : ''} style={{color: 'var(--fg-0)', fontFamily: 'var(--f-mono)', fontSize: 11.5}}>{v}</span>
    </div>
  );
}

function ShapWaterfall({ base, features }) {
  // horizontal waterfall: center 0, bars extend left (negative) or right (positive)
  const maxAbs = Math.max(...features.map(f => Math.abs(f.v))) * 1.2;
  const rowH = 30, barMaxW = 180;
  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 2}}>
      {features.map((f, i) => {
        const w = (Math.abs(f.v) / maxAbs) * barMaxW;
        const pos = f.v >= 0;
        return (
          <div key={f.k} style={{display: 'grid', gridTemplateColumns: '1fr 400px 60px', gap: 10, alignItems: 'center', height: rowH}}>
            <div style={{textAlign: 'right'}}>
              <div className="mono" style={{fontSize: 11.5, color: 'var(--fg-0)'}}>{f.k}</div>
              <div style={{fontSize: 10, color: 'var(--fg-3)'}}>{f.desc}</div>
            </div>
            <div style={{position: 'relative', height: 20}}>
              {/* center line */}
              <div style={{position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--line-2)'}}/>
              {/* bar */}
              <div style={{
                position: 'absolute',
                left: pos ? '50%' : `calc(50% - ${w}px)`,
                top: 2, height: 16,
                width: w,
                background: pos ? 'var(--up)' : 'var(--down)',
                boxShadow: pos ? '0 0 8px var(--up-glow)' : '0 0 8px var(--down-glow)',
                borderRadius: pos ? '0 3px 3px 0' : '3px 0 0 3px',
                opacity: 0.85,
              }}/>
            </div>
            <div className="mono" style={{fontSize: 12, color: pos ? 'var(--up)' : 'var(--down)'}}>
              {pos ? '+' : ''}{(f.v*100).toFixed(1)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ConfusionMatrixViz({ cm }) {
  const { tp, fp, fn, tn } = cm;
  const max = Math.max(tp, fp, fn, tn);
  const cell = (val, label, sub, tone, highlight) => (
    <div style={{
      aspectRatio: '1',
      background: highlight ? `rgba(57,217,138,${0.12 + (val/max)*0.25})` : tone === 'bad' ? `rgba(255,90,106,${0.08 + (val/max)*0.2})` : 'var(--bg-2)',
      border: `1px solid ${highlight ? 'var(--up)' : tone === 'bad' ? 'rgba(255,90,106,0.4)' : 'var(--line)'}`,
      borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center'
    }}>
      <div className="label-sm">{label}</div>
      <div className="mono" style={{fontSize: 22, fontWeight: 500, color: highlight ? 'var(--up)' : tone === 'bad' ? 'var(--down)' : 'var(--fg-0)', marginTop: 4}}>
        {fmt(val, 0)}
      </div>
      <div style={{fontSize: 9.5, color: 'var(--fg-3)', marginTop: 2, fontFamily: 'var(--f-mono)'}}>{sub}</div>
    </div>
  );
  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 6, width: 260}}>
      <div className="row center" style={{fontSize: 10, color: 'var(--fg-2)', fontFamily: 'var(--f-mono)', gap: 100}}>
        <span>PRED: NEG</span><span>PRED: POS</span>
      </div>
      <div style={{display: 'grid', gridTemplateColumns: '46px 1fr 1fr', gap: 6, alignItems: 'center'}}>
        <div className="label-sm" style={{writingMode: 'vertical-rl', transform: 'rotate(180deg)', textAlign: 'center'}}>ACTUAL POS</div>
        {cell(fn, 'FN', 'miss', 'bad')}
        {cell(tp, 'TP', 'correct +', null, true)}
      </div>
      <div style={{display: 'grid', gridTemplateColumns: '46px 1fr 1fr', gap: 6, alignItems: 'center'}}>
        <div className="label-sm" style={{writingMode: 'vertical-rl', transform: 'rotate(180deg)', textAlign: 'center'}}>ACTUAL NEG</div>
        {cell(tn, 'TN', 'correct -', null, true)}
        {cell(fp, 'FP', 'false alarm', 'bad')}
      </div>
    </div>
  );
}

function CalibrationChart({ data, width, height }) {
  const padL = 36, padT = 12, padR = 12, padB = 28;
  const iw = width - padL - padR, ih = height - padT - padB;
  const x = v => padL + v * iw;
  const y = v => padT + ih - v * ih;
  const curveD = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(d.pred)},${y(d.obs)}`).join(' ');
  return (
    <svg width={width} height={height} style={{display: 'block'}}>
      {/* grid */}
      {[0, 0.25, 0.5, 0.75, 1].map(t => (
        <g key={t}>
          <line x1={padL} y1={y(t)} x2={padL + iw} y2={y(t)} stroke="var(--line)" strokeDasharray="2 3"/>
          <line x1={x(t)} y1={padT} x2={x(t)} y2={padT + ih} stroke="var(--line)" strokeDasharray="2 3"/>
          <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fontFamily="var(--f-mono)" fill="var(--fg-2)">{(t*100).toFixed(0)}</text>
          <text x={x(t)} y={padT + ih + 14} textAnchor="middle" fontSize="9" fontFamily="var(--f-mono)" fill="var(--fg-2)">{(t*100).toFixed(0)}</text>
        </g>
      ))}
      {/* ideal diagonal */}
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--fg-2)" strokeDasharray="4 4" opacity="0.6"/>
      {/* curve */}
      <path d={curveD} fill="none" stroke="var(--accent)" strokeWidth="2" style={{filter: 'drop-shadow(0 0 4px var(--accent-glow))'}}/>
      {data.map((d, i) => (
        <circle key={i} cx={x(d.pred)} cy={y(d.obs)} r="3.5" fill="var(--accent)"/>
      ))}
      {/* axis labels */}
      <text x={padL + iw/2} y={height - 4} textAnchor="middle" fontSize="10" fontFamily="var(--f-mono)" fill="var(--fg-2)">PREDICTED %</text>
      <text x={8} y={padT + ih/2} textAnchor="middle" fontSize="10" fontFamily="var(--f-mono)" fill="var(--fg-2)" transform={`rotate(-90, 8, ${padT + ih/2})`}>OBSERVED %</text>
    </svg>
  );
}

Object.assign(window, { ModelPage });
