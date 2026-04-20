// ============================================================
// Apex Automata — Journal page
// ============================================================

function JournalPage() {
  const [filter, setFilter] = useState('ALL');
  const [openId, setOpenId] = useState(null);

  const filtered = JOURNAL.filter(j => filter === 'ALL' || j.outcome === filter);

  const wins = JOURNAL.filter(j => j.outcome === 'WIN').length;
  const losses = JOURNAL.filter(j => j.outcome === 'LOSS').length;
  const totalPnl = JOURNAL.reduce((s, j) => s + j.pnl, 0);
  const avgR = JOURNAL.reduce((s, j) => s + j.r, 0) / JOURNAL.length;

  // Tag cloud
  const tagCounts = {};
  JOURNAL.forEach(j => j.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const tags = Object.entries(tagCounts).sort((a,b) => b[1] - a[1]);

  return (
    <div className="col" style={{gap: 16, padding: 20}}>
      {/* HERO */}
      <Panel header={false} pad={0} className="scanlines" style={{
        background: 'linear-gradient(135deg, var(--bg-1) 0%, #13100d 60%, var(--bg-1) 100%)',
        borderColor: 'rgba(255,196,87,0.18)', position: 'relative', overflow: 'hidden'
      }}>
        <div className="gridbg" style={{position: 'absolute', inset: 0, opacity: 0.4, pointerEvents: 'none'}}/>
        <div style={{
          position: 'absolute', top: -100, left: '40%', width: 320, height: 320, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,196,87,0.12) 0%, transparent 70%)', pointerEvents: 'none'
        }}/>
        <div style={{padding: 28, display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: 28, position: 'relative'}}>
          <div className="col gap-12">
            <div className="row center gap-8">
              <Pill tone="warn"><Icon name="book" size={10} stroke={2}/> TRADE JOURNAL</Pill>
              <span className="pill">{JOURNAL.length} ENTRIES</span>
            </div>
            <div style={{
              fontFamily: 'var(--f-serif)', fontStyle: 'italic',
              fontSize: 38, lineHeight: 1.05, fontWeight: 500, letterSpacing: '-0.02em'
            }}>
              Every trade<br/>tells a <span style={{color: 'var(--warn)'}}>story.</span>
            </div>
            <div style={{fontSize: 12.5, color: 'var(--fg-1)', maxWidth: 420, lineHeight: 1.55}}>
              Automated logs pair each execution with your thesis and post-mortem. Pattern recognition across winners and losers compounds faster than equity.
            </div>
          </div>

          <div className="col gap-12" style={{borderLeft: '1px solid var(--line)', paddingLeft: 24}}>
            <div className="eyebrow">OUTCOME BREAKDOWN</div>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
              <div>
                <div className="mono" style={{fontSize: 32, color: 'var(--up)', fontWeight: 500}}>{wins}</div>
                <div className="label-sm">WINS</div>
              </div>
              <div>
                <div className="mono" style={{fontSize: 32, color: 'var(--down)', fontWeight: 500}}>{losses}</div>
                <div className="label-sm">LOSSES</div>
              </div>
            </div>
            <div style={{height: 6, background: 'var(--bg-2)', borderRadius: 3, overflow: 'hidden', display: 'flex'}}>
              <div style={{flex: wins, background: 'var(--up)', boxShadow: '0 0 6px var(--up-glow)'}}/>
              <div style={{flex: losses, background: 'var(--down)'}}/>
            </div>
            <div className="row between">
              <div><div className="label-sm">TOTAL P&L</div><div className="mono" style={{fontSize: 18, color: totalPnl >= 0 ? 'var(--up)' : 'var(--down)'}}>{totalPnl >= 0 ? '+' : ''}${fmt(Math.abs(totalPnl), 0)}</div></div>
              <div><div className="label-sm">AVG R</div><div className="mono" style={{fontSize: 18, color: 'var(--accent-2)'}}>{avgR >= 0 ? '+' : ''}{avgR.toFixed(2)}R</div></div>
            </div>
          </div>

          <div className="col gap-8" style={{borderLeft: '1px solid var(--line)', paddingLeft: 24}}>
            <div className="eyebrow">TAG DISTRIBUTION</div>
            <div className="row" style={{flexWrap: 'wrap', gap: 6}}>
              {tags.map(([t, n]) => (
                <span key={t} style={{
                  padding: '4px 8px',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line)',
                  borderRadius: 3,
                  fontSize: 10.5, fontFamily: 'var(--f-mono)',
                  color: 'var(--fg-1)',
                  letterSpacing: '0.02em'
                }}>
                  #{t} <span style={{color: 'var(--accent-2)', marginLeft: 4}}>{n}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      {/* Filter bar */}
      <Panel header={false} pad={0}>
        <div className="row between center" style={{padding: '10px 16px'}}>
          <div className="row gap-4">
            {['ALL', 'WIN', 'LOSS'].map(f => (
              <button key={f}
                className={filter === f ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
                onClick={() => setFilter(f)}>
                {f === 'ALL' ? <>All <span className="mono" style={{opacity: 0.6, marginLeft: 6}}>{JOURNAL.length}</span></>
                 : f === 'WIN' ? <>Wins <span className="mono" style={{opacity: 0.6, marginLeft: 6}}>{wins}</span></>
                 : <>Losses <span className="mono" style={{opacity: 0.6, marginLeft: 6}}>{losses}</span></>}
              </button>
            ))}
          </div>
          <div className="row center gap-6">
            <button className="btn btn-sm"><Icon name="download" size={12}/> Export</button>
            <button className="btn btn-primary btn-sm"><Icon name="plus" size={12}/> New entry</button>
          </div>
        </div>
      </Panel>

      {/* Journal cards */}
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16}}>
        {filtered.map(j => (
          <JournalCard key={j.id} j={j} open={openId === j.id} onToggle={() => setOpenId(openId === j.id ? null : j.id)}/>
        ))}
      </div>
    </div>
  );
}

function JournalCard({ j, open, onToggle }) {
  const winTone = j.outcome === 'WIN';
  return (
    <Panel header={false} pad={0} style={{
      borderColor: winTone ? 'rgba(57,217,138,0.25)' : 'rgba(255,90,106,0.25)',
      boxShadow: winTone ? '0 0 0 1px rgba(57,217,138,0.1) inset' : '0 0 0 1px rgba(255,90,106,0.08) inset'
    }}>
      {/* Header */}
      <div style={{padding: '14px 16px', borderBottom: '1px solid var(--line)'}}>
        <div className="row between" style={{marginBottom: 8}}>
          <div className="row center gap-8">
            <div style={{
              width: 28, height: 28, borderRadius: 4,
              background: winTone ? 'rgba(57,217,138,0.15)' : 'rgba(255,90,106,0.15)',
              border: `1px solid ${winTone ? 'var(--up)' : 'var(--down)'}`,
              display: 'grid', placeItems: 'center'
            }}>
              <Icon name={winTone ? 'trend' : 'trendDown'} size={14} style={{color: winTone ? 'var(--up)' : 'var(--down)'}}/>
            </div>
            <div>
              <div style={{fontSize: 14, fontWeight: 500}}>{j.sym} · <span style={{color: j.side === 'LONG' ? 'var(--up)' : 'var(--down)'}}>{j.side}</span></div>
              <div className="mono" style={{fontSize: 10.5, color: 'var(--fg-2)'}}>#{j.id} · {j.date} · {j.time}</div>
            </div>
          </div>
          <Pill tone={winTone ? 'up' : 'down'}>{j.outcome}</Pill>
        </div>

        <div className="row between">
          <div className="row gap-16">
            <div>
              <div className="label-sm">R</div>
              <div className="mono" style={{fontSize: 16, color: winTone ? 'var(--up)' : 'var(--down)'}}>
                {j.r >= 0 ? '+' : ''}{j.r.toFixed(2)}R
              </div>
            </div>
            <div>
              <div className="label-sm">P&L</div>
              <div className="mono" style={{fontSize: 16, color: winTone ? 'var(--up)' : 'var(--down)'}}>
                {j.pnl >= 0 ? '+' : ''}${fmt(Math.abs(j.pnl), 0)}
              </div>
            </div>
          </div>
          <MiniTradeChart seed={j.seed} entry={j.entry} exit={j.exit} side={j.side} win={winTone}/>
        </div>
      </div>

      {/* Thesis */}
      <div style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
        <div className="label-sm" style={{marginBottom: 4}}>THESIS</div>
        <div style={{fontSize: 12.5, color: 'var(--fg-0)', lineHeight: 1.5}}>{j.thesis}</div>
      </div>

      {/* Levels */}
      <div style={{padding: '10px 16px', borderBottom: '1px solid var(--line)', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10}}>
        <LevelCell lbl="ENTRY"  v={j.entry}/>
        <LevelCell lbl="EXIT"   v={j.exit}   tone={winTone ? 'var(--up)' : 'var(--down)'}/>
        <LevelCell lbl="STOP"   v={j.stop}   tone="var(--down)"/>
        <LevelCell lbl="TARGET" v={j.target} tone="var(--up)"/>
      </div>

      {/* Tags */}
      <div style={{padding: '10px 16px', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center'}}>
        {j.tags.map(t => (
          <span key={t} style={{
            padding: '3px 7px', fontSize: 10, fontFamily: 'var(--f-mono)',
            background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 3,
            color: 'var(--fg-1)', letterSpacing: '0.03em'
          }}>#{t}</span>
        ))}
        <button className="btn btn-xs btn-ghost" style={{marginLeft: 'auto'}} onClick={onToggle}>
          {open ? 'Hide lessons' : 'Show lessons'} <Icon name={open ? 'chevDown' : 'chevRight'} size={10}/>
        </button>
      </div>

      {open && (
        <div style={{padding: '12px 16px', borderTop: '1px solid var(--line)', background: 'rgba(255,196,87,0.03)'}}>
          <div className="label-sm" style={{marginBottom: 4, color: 'var(--warn)'}}>LESSONS · POST-MORTEM</div>
          <div style={{fontSize: 12.5, color: 'var(--fg-0)', lineHeight: 1.5, fontStyle: 'italic', fontFamily: 'var(--f-serif)'}}>
            {j.lessons}
          </div>
        </div>
      )}
    </Panel>
  );
}

function LevelCell({ lbl, v, tone }) {
  return (
    <div>
      <div className="label-sm">{lbl}</div>
      <div className="mono" style={{fontSize: 13, color: tone || 'var(--fg-0)'}}>{fmt(v, v >= 1000 ? 0 : 2)}</div>
    </div>
  );
}

function MiniTradeChart({ seed, entry, exit, side, win }) {
  // procedural mini candle-like line from seed
  const rnd = mulberry32(seed);
  const pts = [];
  const range = entry * 0.04;
  let v = entry - range * 0.3;
  const target = exit;
  const steps = 30;
  for (let i = 0; i < steps; i++) {
    const progress = i / (steps - 1);
    const drift = (target - entry) * progress * 0.9;
    v = entry + drift + (rnd() - 0.5) * range * 0.6;
    pts.push(v);
  }
  const min = Math.min(...pts, entry, exit);
  const max = Math.max(...pts, entry, exit);
  const span = max - min || 1;
  const W = 120, H = 38;
  const x = i => (i / (steps - 1)) * W;
  const y = v => H - ((v - min) / span) * H;
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p)}`).join(' ');
  const entryY = y(entry);
  const exitY = y(exit);
  const color = win ? 'var(--up)' : 'var(--down)';
  return (
    <svg width={W} height={H} style={{display: 'block'}}>
      <line x1="0" x2={W} y1={entryY} y2={entryY} stroke="var(--fg-3)" strokeDasharray="2 2" opacity="0.6"/>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" style={{filter: win ? 'drop-shadow(0 0 3px var(--up-glow))' : 'none'}}/>
      <circle cx={0} cy={entryY} r="2.5" fill="var(--fg-1)"/>
      <circle cx={W} cy={exitY} r="2.5" fill={color}/>
    </svg>
  );
}

Object.assign(window, { JournalPage });
