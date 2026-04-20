// ============================================================
// Apex Automata — shell: sidebar + topbar + ticker + command
// ============================================================

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'grid', kbd: 'D' },
  { id: 'orders',    label: 'Orders',    icon: 'orders', kbd: 'O' },
  { id: 'signals',   label: 'Signals',   icon: 'trend', kbd: 'S' },
  { id: 'risk',      label: 'Risk',      icon: 'shield', kbd: 'R' },
  { id: 'model',     label: 'Model',     icon: 'brain',  kbd: 'M' },
  { id: 'backtest',  label: 'Backtest',  icon: 'flask',  kbd: 'B' },
  { id: 'journal',   label: 'Journal',   icon: 'book',   kbd: 'J' },
  { id: 'alerts',    label: 'Alerts',    icon: 'bell',   kbd: 'A' },
  { id: 'settings',  label: 'Settings',  icon: 'settings', kbd: ',' },
];
const NAV_DISABLED = [];

function Logo({ collapsed = false }) {
  return (
    <div className="row center gap-8" style={{ padding: collapsed ? 0 : '0 4px' }}>
      <div style={{
        width: 28, height: 28, borderRadius: 7, position: 'relative',
        background: 'radial-gradient(circle at 30% 30%, var(--accent-2), var(--accent))',
        display:'grid', placeItems:'center',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.08), 0 6px 16px -4px var(--accent-glow)'
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M4 20L12 4L20 20" stroke="white" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round"/>
          <path d="M8 14H16" stroke="white" strokeWidth="2.2" strokeLinecap="round" opacity="0.8"/>
        </svg>
      </div>
      {!collapsed && (
        <div className="col" style={{ gap: 0, lineHeight: 1.1 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, letterSpacing: '-0.01em' }}>Apex Automata</div>
          <div className="label" style={{ fontSize: 9 }}>EXECUTION TERMINAL</div>
        </div>
      )}
    </div>
  );
}

function Sidebar({ route, onRoute }) {
  return (
    <aside className="col" style={{
      width: 224, minWidth: 224,
      background: 'var(--bg-1)',
      borderRight: '1px solid var(--line)',
      padding: '14px 14px 16px',
      gap: 18, height: '100vh', position: 'sticky', top: 0,
    }}>
      <div style={{ padding: '4px 4px 2px' }}><Logo /></div>

      <div className="col" style={{ gap: 2 }}>
        <div className="label" style={{ padding: '0 10px 6px' }}>Terminal</div>
        {NAV.map(n => (
          <div key={n.id} className="nav-item" data-active={route === n.id} onClick={() => onRoute(n.id)}>
            <Icon name={n.icon} size={15} stroke={1.5} />
            <span>{n.label}</span>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
              <kbd>{n.kbd}</kbd>
            </span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 'auto' }} className="col gap-8">
        <div className="inset" style={{ padding: 10 }}>
          <div className="row between center" style={{ marginBottom: 6 }}>
            <div className="label">SESSION</div>
            <span className="dot dot-live" />
          </div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 500 }}>{SESSION.uptime}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-2)', marginTop: 2 }}>opened {SESSION.openedAt} UTC</div>
        </div>
        <div className="row between center" style={{ padding: '0 4px' }}>
          <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>v2.4.1 · main</div>
          <div className="row gap-6 center">
            <div className="dot" style={{ background: 'var(--up)' }} />
            <span style={{ fontSize: 11, color: 'var(--fg-2)' }}>all systems</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function BotStatePill({ mode, onChange }) {
  const modes = [
    { v: 'paper',  l: 'PAPER',  tone: 'accent' },
    { v: 'live',   l: 'LIVE',   tone: 'up' },
    { v: 'paused', l: 'PAUSED', tone: 'warn' },
  ];
  return (
    <div className="seg" style={{ padding: 3 }}>
      {modes.map(m => (
        <button key={m.v} data-active={mode === m.v} onClick={() => onChange(m.v)} style={{
          color: mode === m.v ? (m.v === 'live' ? 'var(--up)' : m.v === 'paused' ? 'var(--warn)' : 'var(--accent-2)') : undefined,
        }}>
          {mode === m.v && <span className="dot" style={{
            background: m.v === 'live' ? 'var(--up)' : m.v === 'paused' ? 'var(--warn)' : 'var(--accent)',
            boxShadow: `0 0 8px currentColor`,
            marginRight: 6, display: 'inline-block'
          }} />}
          {m.l}
        </button>
      ))}
    </div>
  );
}

function TopBar({ mode, onMode, onOpenCommand, onOpenTweaks, tweaksVisible, route }) {
  const routeTitle = {
    dashboard: 'Overview',
    orders: 'Orders & Positions',
    signals: 'Signals',
    risk: 'Risk Control',
    model: 'Meta Model',
    backtest: 'Backtest Lab',
    journal: 'Trade Journal',
    alerts: 'Alerts & Rules',
    settings: 'Settings',
  }[route] || 'Overview';
  return (
    <header style={{
      height: 56, borderBottom: '1px solid var(--line)',
      background: 'rgba(10,13,20,0.82)',
      backdropFilter: 'blur(12px)',
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '0 20px', position: 'sticky', top: 0, zIndex: 30,
    }}>
      <div className="row center gap-8">
        <span className="label-sm" style={{ fontSize: 10 }}>APEX</span>
        <Icon name="chevRight" size={12} style={{ color: 'var(--fg-3)' }} />
        <span style={{ fontWeight: 500, fontSize: 13 }}>{routeTitle}</span>
      </div>

      <button className="btn btn-ghost" style={{
        marginLeft: 16, height: 32, padding: '0 10px',
        width: 320, justifyContent: 'flex-start',
        background: 'var(--bg-2)', border: '1px solid var(--line)'
      }} onClick={onOpenCommand}>
        <Icon name="search" size={14} />
        <span style={{ color: 'var(--fg-2)', fontSize: 12.5 }}>Command or search…</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
          <kbd>⌘</kbd><kbd>K</kbd>
        </span>
      </button>

      <div style={{ marginLeft: 'auto' }} className="row center gap-12">
        <LiveClock />
        <div className="vdivider" style={{ height: 20 }} />
        <BotStatePill mode={mode} onChange={onMode} />
        <button className="btn btn-danger btn-sm" title="Kill switch — flattens all positions">
          <Icon name="power" size={13} /> KILL
        </button>
        <div className="vdivider" style={{ height: 20 }} />
        {tweaksVisible && (
          <button className="btn btn-ghost btn-sm" onClick={onOpenTweaks} title="Tweaks">
            <Icon name="sliders" size={14} />
          </button>
        )}
        <div style={{
          width: 28, height: 28, borderRadius: '50%',
          background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
          display: 'grid', placeItems: 'center',
          fontSize: 11, fontWeight: 600, color: 'white'
        }}>JD</div>
      </div>
    </header>
  );
}

function TickerTape() {
  const [state, setState] = useState(FEED.snapshot());
  useEffect(() => FEED.subscribe(setState), []);
  const items = [...state, ...state]; // duplicate for seamless scroll
  return (
    <div style={{
      height: 34, borderBottom: '1px solid var(--line)',
      background: 'var(--bg-1)', overflow: 'hidden',
      position: 'relative'
    }} className="mask-x">
      <div className="ticker-track" style={{ alignItems: 'center', height: '100%', paddingLeft: 20 }}>
        {items.map((t, i) => (
          <div key={i} className="row center gap-8" style={{ fontSize: 12 }}>
            <span style={{ color: 'var(--fg-2)', fontFamily: 'var(--f-mono)', letterSpacing: '0.04em', fontSize: 11 }}>{t.s}</span>
            <span className="mono" style={{ color: 'var(--fg-0)', fontWeight: 500 }}>
              {t.last.toLocaleString(undefined, { minimumFractionDigits: t.dec, maximumFractionDigits: t.dec })}
            </span>
            <span className="mono" style={{ color: t.chgPct >= 0 ? 'var(--up)' : 'var(--down)', fontSize: 11 }}>
              {t.chgPct >= 0 ? '▲' : '▼'} {Math.abs(t.chgPct).toFixed(2)}%
            </span>
            <Sparkline data={t.spark} width={46} height={16} fill={false} strokeW={1.2}
              color={t.chgPct >= 0 ? 'var(--up)' : 'var(--down)'} />
          </div>
        ))}
      </div>
    </div>
  );
}

// -------- Command palette --------
function CommandPalette({ open, onClose, onRoute, onMode }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current && inputRef.current.focus(), 30);
    else setQ('');
  }, [open]);

  const actions = [
    { k: 'Go to Dashboard',  tag: 'nav',     act: () => onRoute('dashboard') },
    { k: 'Go to Orders',     tag: 'nav',     act: () => onRoute('orders') },
    { k: 'Go to Signals',    tag: 'nav',     act: () => onRoute('signals') },
    { k: 'Switch to LIVE',   tag: 'mode',    act: () => onMode('live') },
    { k: 'Switch to PAPER',  tag: 'mode',    act: () => onMode('paper') },
    { k: 'Pause bot',        tag: 'mode',    act: () => onMode('paused') },
    { k: 'Flatten all positions (kill-switch)', tag: 'danger', act: () => alert('⚠️  Kill-switch engaged (demo)') },
    { k: 'Open strategy: Breakout',  tag: 'strategy', act: () => onRoute('signals') },
    { k: 'Open strategy: VWAP MR',   tag: 'strategy', act: () => onRoute('signals') },
    { k: 'Export session P&L CSV',   tag: 'export', act: () => alert('Exported.') },
  ];
  const filtered = actions.filter(a => a.k.toLowerCase().includes(q.toLowerCase()));

  if (!open) return null;
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 80,
      background: 'rgba(4,6,10,0.72)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh'
    }}>
      <div onClick={e => e.stopPropagation()} className="panel" style={{
        width: 560, background: 'var(--bg-1)',
        borderColor: 'var(--line-2)',
        boxShadow: '0 30px 60px -20px rgba(0,0,0,0.8), 0 0 0 1px var(--line-2)'
      }}>
        <div className="row center gap-8" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
          <Icon name="search" size={16} style={{ color: 'var(--fg-2)' }} />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search commands or symbols…"
            style={{ flex: 1, background: 'transparent', border: 'none', padding: 0, fontSize: 14, outline: 'none' }}
          />
          <kbd>ESC</kbd>
        </div>
        <div style={{ maxHeight: 360, overflowY: 'auto', padding: 6 }}>
          {filtered.map((a, i) => (
            <div key={i} onClick={() => { a.act(); onClose(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 10px', borderRadius: 6, cursor: 'pointer',
                fontSize: 13,
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <Icon name={a.tag === 'nav' ? 'arrowRight' : a.tag === 'danger' ? 'power' : a.tag === 'mode' ? 'play' : a.tag === 'export' ? 'download' : 'command'} size={14} />
              <span>{a.k}</span>
              <span className="pill" style={{ marginLeft: 'auto', fontSize: 9 }}>{a.tag}</span>
            </div>
          ))}
          {filtered.length === 0 && <div style={{ padding: 20, color: 'var(--fg-2)', fontSize: 13, textAlign: 'center' }}>No matches.</div>}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Sidebar, TopBar, TickerTape, CommandPalette, Logo });
