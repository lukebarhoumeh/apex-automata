// ============================================================
// Apex Automata — Risk page
// ============================================================

function RiskPage() {
  const R = RISK;
  const [armed, setArmed] = useState(true);
  const [selectedCell, setSelectedCell] = useState(null);

  return (
    <div className="col" style={{ gap: 16, padding: 20 }}>
      {/* HERO */}
      <Panel header={false} pad={0} className="scanlines" style={{
        background: 'linear-gradient(135deg, var(--bg-1) 0%, #0d121c 60%, var(--bg-1) 100%)',
        borderColor: 'rgba(255,90,106,0.18)', overflow: 'hidden', position: 'relative'
      }}>
        <div className="gridbg" style={{ position: 'absolute', inset: 0, opacity: 0.5, pointerEvents: 'none' }} />
        <div style={{
          position: 'absolute', top: -120, right: -120, width: 360, height: 360, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,90,106,0.16) 0%, transparent 70%)',
          pointerEvents: 'none'
        }} />
        <div style={{ padding: 28, display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr', gap: 28, position: 'relative' }}>
          <div className="col gap-12">
            <div className="row center gap-8">
              <Pill tone="down"><span className="dot" style={{background:'var(--down)', marginRight:4}}/>RISK DESK</Pill>
              <span className="pill">ARMED · {R.killLadder.filter(l => l.tripped).length}/5 TRIPPED</span>
            </div>
            <div style={{
              fontSize: 42, lineHeight: 1.05, fontWeight: 500,
              fontFamily: 'var(--f-serif)', fontStyle: 'italic',
              letterSpacing: '-0.02em'
            }}>
              <span style={{color: 'var(--down)'}}>Risk is what</span><br/>
              we <span style={{color: 'var(--fg-1)'}}>refuse to take.</span>
            </div>
            <div style={{fontSize: 12.5, color: 'var(--fg-1)', lineHeight: 1.55, maxWidth: 380}}>
              Exposure <span className="mono" style={{color:'var(--fg-0)'}}>${fmt(R.portfolio.exposure, 0)}</span> on 
              <span className="mono" style={{color:'var(--fg-0)'}}> ${fmt(R.portfolio.equity, 0)}</span> equity.
              Heat at <span className="mono" style={{color:'var(--accent-2)'}}>{R.portfolio.heat.toFixed(2)}%</span>, 
              drawdown <span className="mono" style={{color:'var(--up)'}}>{R.portfolio.dd.toFixed(1)}%</span>.
            </div>
            <div className="row gap-8">
              <button className="btn btn-danger btn-sm"><Icon name="power" size={12}/> KILL ALL</button>
              <button className="btn btn-sm">Edit limits</button>
            </div>
          </div>

          <div className="col gap-12" style={{borderLeft: '1px solid var(--line)', paddingLeft: 24}}>
            <div className="row between center">
              <div className="eyebrow">VaR · 95% · 99%</div>
            </div>
            <div>
              <div className="display" style={{fontSize: 36, color: 'var(--down)', textShadow: '0 0 24px rgba(255,90,106,0.25)'}}>
                -${fmt(R.portfolio.var95, 0)}
              </div>
              <div className="label-sm" style={{marginTop: 2}}>1-DAY 95% VaR</div>
            </div>
            <div className="row gap-20">
              <div className="col gap-2">
                <span className="label-sm">99% VaR</span>
                <span className="mono" style={{fontSize: 16, color: 'var(--down)'}}>-${fmt(R.portfolio.var99, 0)}</span>
              </div>
              <div className="col gap-2">
                <span className="label-sm">EXP. SHORTFALL</span>
                <span className="mono" style={{fontSize: 16, color: 'var(--down)'}}>-${fmt(R.portfolio.expectedShortfall, 0)}</span>
              </div>
              <div className="col gap-2">
                <span className="label-sm">NET BETA</span>
                <span className="mono" style={{fontSize: 16}}>{R.portfolio.netBeta.toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div className="col gap-8" style={{borderLeft: '1px solid var(--line)', paddingLeft: 24}}>
            <div className="eyebrow">CIRCUIT BREAKERS</div>
            <CircuitBar label="Portfolio Heat" v={R.portfolio.heat}       cap={R.portfolio.heatCap} unit="%" tone="var(--accent)" />
            <CircuitBar label="Drawdown"        v={R.portfolio.dd}         cap={R.portfolio.ddCap}   unit="%" tone="var(--warn)" />
            <CircuitBar label="Consec Losses"   v={R.portfolio.consecLosses} cap={R.portfolio.consecCap} unit=""  tone="var(--down)" />
            <div className="row between center" style={{marginTop: 6}}>
              <div className="label">KILL SWITCH</div>
              <div className="row center gap-8">
                <span className="mono" style={{fontSize: 11, color: armed ? 'var(--down)': 'var(--fg-2)'}}>
                  {armed ? 'ARMED' : 'DISARMED'}
                </span>
                <Switch on={armed} onChange={setArmed}/>
              </div>
            </div>
          </div>
        </div>
      </Panel>

      {/* Risk radar + correlation heatmap side-by-side */}
      <div style={{display: 'grid', gridTemplateColumns: '1fr 1.1fr', gap: 16}}>
        <Panel header={false} pad={0}>
          <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="row center gap-8">
              <Icon name="target" size={14} style={{color: 'var(--down)'}}/>
              <div className="label">RISK RADAR</div>
            </div>
            <span className="pill pill-warn">COMPOSITE {Math.round(R.radar.reduce((s,r)=>s+r.v,0)/R.radar.length)}</span>
          </div>
          <div style={{padding: 20, display: 'grid', gridTemplateColumns: '1fr auto', gap: 20, alignItems: 'center'}}>
            <RadarChart axes={R.radar} size={280} />
            <div className="col gap-8" style={{minWidth: 160}}>
              {R.radar.map(a => (
                <div key={a.k}>
                  <div className="row between" style={{marginBottom: 3}}>
                    <span className="label-sm">{a.k}</span>
                    <span className="mono" style={{fontSize: 11, color: a.v > 60 ? 'var(--warn)' : a.v > 40 ? 'var(--accent-2)' : 'var(--up)'}}>
                      {a.v}
                    </span>
                  </div>
                  <div className="bar"><div style={{
                    width: `${a.v}%`,
                    background: a.v > 60 ? 'var(--warn)' : a.v > 40 ? 'var(--accent)' : 'var(--up)',
                    boxShadow: `0 0 6px ${a.v > 60 ? 'var(--warn)' : a.v > 40 ? 'var(--accent-glow)' : 'var(--up-glow)'}`
                  }}/></div>
                </div>
              ))}
            </div>
          </div>
        </Panel>

        <Panel header={false} pad={0}>
          <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="row center gap-8">
              <Icon name="layers" size={14} style={{color: 'var(--accent-2)'}}/>
              <div className="label">CORRELATION · 7D RETURNS</div>
            </div>
            {selectedCell && (
              <span className="mono" style={{fontSize: 11, color: 'var(--fg-2)'}}>
                {R.corrLabels[selectedCell.i]} × {R.corrLabels[selectedCell.j]} = {R.corr[selectedCell.i][selectedCell.j].toFixed(2)}
              </span>
            )}
          </div>
          <div style={{padding: 20}}>
            <CorrelationHeatmap labels={R.corrLabels} matrix={R.corr} onHover={setSelectedCell}/>
            <div className="row between" style={{marginTop: 12, fontSize: 10.5, fontFamily: 'var(--f-mono)', color: 'var(--fg-2)'}}>
              <span>-1.0 anti-correlated</span>
              <span style={{display: 'flex', alignItems: 'center', gap: 4}}>
                <span style={{width: 120, height: 6, background: 'linear-gradient(to right, #3b82f6, #0a0d14, #ff5a6a)', borderRadius: 999}}/>
              </span>
              <span>+1.0 correlated</span>
            </div>
          </div>
        </Panel>
      </div>

      {/* Exposure tree + kill ladder */}
      <div style={{display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16}}>
        <Panel header={false} pad={0}>
          <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="row center gap-8">
              <Icon name="layers" size={14} style={{color: 'var(--accent-2)'}}/>
              <div className="label">EXPOSURE TREE</div>
            </div>
            <span className="pill">TOTAL ${fmt(R.tree.value + 86_162, 0)}</span>
          </div>
          <div style={{padding: 20}}>
            <ExposureTree node={R.tree} depth={0} maxVal={R.tree.value}/>
          </div>
        </Panel>

        <Panel header={false} pad={0}>
          <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="row center gap-8">
              <Icon name="alert" size={14} style={{color: 'var(--warn)'}}/>
              <div className="label">KILL-SWITCH LADDER</div>
            </div>
            <span className="pill">{R.killLadder.length} RULES</span>
          </div>
          <div>
            {R.killLadder.map((k, i) => (
              <div key={k.lvl} style={{
                display: 'grid', gridTemplateColumns: '32px 1fr auto',
                gap: 12, padding: '14px 16px',
                borderBottom: i < R.killLadder.length - 1 ? '1px solid var(--line)' : 'none',
                alignItems: 'center',
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: k.tripped ? 'rgba(255,90,106,0.15)' : 'var(--bg-2)',
                  border: `1px solid ${k.tripped ? 'var(--down)' : 'var(--line-2)'}`,
                  display: 'grid', placeItems: 'center',
                  fontFamily: 'var(--f-mono)', fontWeight: 600, fontSize: 12,
                  color: k.tripped ? 'var(--down)' : 'var(--fg-1)',
                }}>
                  {k.lvl}
                </div>
                <div className="col" style={{gap: 2}}>
                  <div style={{fontSize: 13, fontWeight: 500}}>{k.action}</div>
                  <div className="mono" style={{fontSize: 11, color: 'var(--fg-2)'}}>{k.at}</div>
                </div>
                <Pill tone={k.tripped ? 'down' : null}>{k.tripped ? 'TRIPPED' : 'ARMED'}</Pill>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* Per-symbol exposure caps */}
      <Panel header={false} pad={0}>
        <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
          <div className="row center gap-8">
            <Icon name="shield" size={14} style={{color: 'var(--up)'}}/>
            <div className="label">PER-SYMBOL EXPOSURE CAPS</div>
          </div>
          <button className="btn btn-ghost btn-sm">Configure <Icon name="chevRight" size={12}/></button>
        </div>
        <table className="t">
          <thead>
            <tr><th>SYMBOL</th><th className="num">NOTIONAL USED</th><th className="num">CAP</th><th>UTILIZATION</th><th className="num">%</th><th>STATUS</th></tr>
          </thead>
          <tbody>
            {R.symbolCaps.map(c => (
              <tr key={c.s}>
                <td style={{fontWeight: 500}}>{c.s}</td>
                <td className="num">${fmt(c.used, 0)}</td>
                <td className="num">${fmt(c.cap, 0)}</td>
                <td style={{width: '40%'}}>
                  <div className="bar" style={{height: 6}}>
                    <div style={{
                      width: `${c.pct}%`,
                      background: c.pct > 70 ? 'var(--warn)' : c.pct > 50 ? 'var(--accent)' : 'var(--up)',
                      boxShadow: `0 0 6px ${c.pct > 70 ? 'var(--warn)' : c.pct > 50 ? 'var(--accent-glow)' : 'var(--up-glow)'}`
                    }}/>
                  </div>
                </td>
                <td className="num" style={{color: c.pct > 70 ? 'var(--warn)' : 'var(--fg-0)'}}>{c.pct.toFixed(1)}%</td>
                <td><Pill tone={c.pct > 70 ? 'warn' : null}>{c.pct > 70 ? 'HIGH' : 'OK'}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function CircuitBar({ label, v, cap, unit, tone }) {
  const pct = Math.min(100, (v / cap) * 100);
  return (
    <div>
      <div className="row between" style={{marginBottom: 3, fontSize: 11}}>
        <span className="label-sm">{label}</span>
        <span className="mono" style={{fontSize: 11}}>
          <span style={{color: 'var(--fg-0)'}}>{v.toFixed(1)}{unit}</span>
          <span style={{color: 'var(--fg-3)'}}> / {cap}{unit}</span>
        </span>
      </div>
      <div className="bar" style={{height: 5}}>
        <div style={{width: `${pct}%`, background: tone, boxShadow: `0 0 6px ${tone}`}}/>
      </div>
    </div>
  );
}

function RadarChart({ axes, size }) {
  const n = axes.length;
  const cx = size / 2, cy = size / 2, rMax = size / 2 - 30;
  const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i, v) => [cx + Math.cos(angle(i)) * rMax * (v / 100), cy + Math.sin(angle(i)) * rMax * (v / 100)];
  const rings = [0.25, 0.5, 0.75, 1];
  const polyD = axes.map((a, i) => pt(i, a.v)).map(([x,y],i)=>`${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ') + ' Z';
  return (
    <svg width={size} height={size} style={{display: 'block'}}>
      {/* rings */}
      {rings.map(r => (
        <polygon key={r} points={
          axes.map((_,i)=>{const [x,y]=[cx+Math.cos(angle(i))*rMax*r, cy+Math.sin(angle(i))*rMax*r]; return `${x},${y}`;}).join(' ')
        } fill="none" stroke="var(--line)" strokeDasharray={r===1?'':'2 4'} />
      ))}
      {/* axis lines */}
      {axes.map((_, i) => {
        const [x, y] = pt(i, 100);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--line)" strokeWidth="0.8"/>;
      })}
      {/* data polygon */}
      <path d={polyD} fill="var(--down)" fillOpacity="0.13" stroke="var(--down)" strokeWidth="1.5"
        style={{filter: 'drop-shadow(0 0 6px var(--down-glow))'}}
      />
      {/* data points */}
      {axes.map((a, i) => {
        const [x, y] = pt(i, a.v);
        return <circle key={i} cx={x} cy={y} r="3" fill="var(--down)"/>;
      })}
      {/* labels */}
      {axes.map((a, i) => {
        const [x, y] = [cx + Math.cos(angle(i)) * (rMax + 18), cy + Math.sin(angle(i)) * (rMax + 18)];
        return (
          <text key={i} x={x} y={y} textAnchor="middle" dominantBaseline="middle"
            fontSize="10.5" fontFamily="var(--f-mono)" fill="var(--fg-1)">
            {a.k.toUpperCase()}
          </text>
        );
      })}
    </svg>
  );
}

function CorrelationHeatmap({ labels, matrix, onHover }) {
  const cellSize = 50;
  const padL = 46, padT = 18;
  const n = labels.length;
  const color = (v) => {
    // -1 blue ... 0 dark ... +1 red
    if (v > 0) {
      const t = v;
      return `rgba(255, 90, 106, ${0.15 + t*0.7})`;
    }
    const t = Math.abs(v);
    return `rgba(59, 130, 246, ${0.15 + t*0.7})`;
  };
  return (
    <svg width={padL + n * cellSize + 10} height={padT + n * cellSize + 10} style={{display: 'block'}}
         onMouseLeave={() => onHover(null)}>
      {/* col labels */}
      {labels.map((l, i) => (
        <text key={`c${i}`} x={padL + i*cellSize + cellSize/2} y={12}
          textAnchor="middle" fontSize="10" fontFamily="var(--f-mono)" fill="var(--fg-2)">{l}</text>
      ))}
      {/* row labels */}
      {labels.map((l, i) => (
        <text key={`r${i}`} x={padL - 6} y={padT + i*cellSize + cellSize/2 + 3}
          textAnchor="end" fontSize="10" fontFamily="var(--f-mono)" fill="var(--fg-2)">{l}</text>
      ))}
      {/* cells */}
      {matrix.map((row, i) => row.map((v, j) => (
        <g key={`${i}-${j}`} onMouseEnter={() => onHover({i, j, v})}>
          <rect x={padL + j*cellSize} y={padT + i*cellSize} width={cellSize-2} height={cellSize-2}
            fill={color(v)} rx="3"
            stroke={i===j ? 'var(--accent)' : 'transparent'}
            strokeWidth="1"
          />
          <text x={padL + j*cellSize + cellSize/2} y={padT + i*cellSize + cellSize/2 + 4}
            textAnchor="middle" fontSize="10.5" fontFamily="var(--f-mono)"
            fill={Math.abs(v) > 0.5 ? 'white' : 'var(--fg-1)'} fontWeight={i===j?600:500}>
            {v.toFixed(2)}
          </text>
        </g>
      )))}
    </svg>
  );
}

function ExposureTree({ node, depth, maxVal, parentVal }) {
  const pct = parentVal ? (node.value / parentVal) * 100 : (node.value / maxVal) * 100;
  const colors = ['var(--accent)', 'var(--accent-2)', 'var(--up)', 'var(--warn)'];
  const color = colors[depth % colors.length];
  return (
    <div>
      <div style={{
        display: 'grid', gridTemplateColumns: `${depth * 16 + 140}px 1fr 80px`,
        gap: 12, alignItems: 'center', padding: '6px 0',
      }}>
        <div style={{paddingLeft: depth * 16, fontSize: 12.5, fontWeight: depth === 0 ? 600 : 400, color: depth === 0 ? 'var(--fg-0)' : 'var(--fg-1)'}}>
          {depth > 0 && <span style={{color: 'var(--fg-3)', marginRight: 6}}>└</span>}
          {node.label}
        </div>
        <div className="bar" style={{height: 8}}>
          <div style={{
            width: `${pct}%`, background: color,
            boxShadow: depth < 2 ? `0 0 6px ${color}` : 'none', opacity: 0.4 + depth * 0.15
          }}/>
        </div>
        <div className="mono" style={{fontSize: 12, textAlign: 'right', color: 'var(--fg-0)'}}>
          ${fmt(node.value, 0)}
        </div>
      </div>
      {node.children && node.children.map((c, i) => (
        <ExposureTree key={c.label + i} node={c} depth={depth + 1} maxVal={maxVal} parentVal={node.value}/>
      ))}
    </div>
  );
}

Object.assign(window, { RiskPage });
