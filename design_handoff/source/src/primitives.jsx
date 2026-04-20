// ============================================================
// Apex Automata — shared primitives
// ============================================================
const { useState, useEffect, useRef, useMemo, useCallback } = React;

// -------- Icon set (hand-rolled for a cohesive weight) --------
const Icon = ({ name, size = 16, stroke = 1.6, ...rest }) => {
  const s = size;
  const P = (d) => <path d={d} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />;
  const paths = {
    grid: <>{P("M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z")}</>,
    activity: <>{P("M3 12h4l3-8 4 16 3-8h4")}</>,
    pulse: <>{P("M3 12h4l2-5 3 10 2-5h9")}</>,
    chart: <>{P("M3 3v18h18")}{P("M7 15l4-5 3 3 5-7")}</>,
    shield: <>{P("M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z")}</>,
    book: <>{P("M4 4h12a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM4 4v14")}</>,
    bell: <>{P("M18 16V11a6 6 0 1 0-12 0v5l-2 3h16zM10 20a2 2 0 0 0 4 0")}</>,
    brain: <>{P("M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3V3zM15 3a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3V3z")}</>,
    flask: <>{P("M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3")}</>,
    settings: <>{P("M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z")}{P("M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z")}</>,
    orders: <>{P("M3 6h18M3 12h18M3 18h18")}{P("M6 6v0M6 12v0M6 18v0")}</>,
    trend: <>{P("M3 17l6-6 4 4 8-8")}{P("M14 7h7v7")}</>,
    play: <>{P("M6 4v16l14-8z")}</>,
    pause: <>{P("M7 4v16M17 4v16")}</>,
    power: <>{P("M12 3v9")}{P("M7 6a7 7 0 1 0 10 0")}</>,
    zap: <>{P("M13 2L4 14h7l-1 8 9-12h-7z")}</>,
    check: <>{P("M4 12l5 5L20 6")}</>,
    x: <>{P("M6 6l12 12M18 6L6 18")}</>,
    arrowUp: <>{P("M12 19V5M5 12l7-7 7 7")}</>,
    arrowDown: <>{P("M12 5v14M19 12l-7 7-7-7")}</>,
    arrowRight: <>{P("M5 12h14M13 5l7 7-7 7")}</>,
    plus: <>{P("M12 5v14M5 12h14")}</>,
    minus: <>{P("M5 12h14")}</>,
    search: <>{P("M11 3a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM21 21l-4-4")}</>,
    command: <>{P("M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z")}</>,
    filter: <>{P("M3 5h18l-7 9v5l-4 2v-7z")}</>,
    info: <>{P("M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z")}{P("M12 8v0M12 11v6")}</>,
    alert: <>{P("M12 3l10 18H2z")}{P("M12 10v5M12 18v0")}</>,
    download: <>{P("M12 3v12M7 10l5 5 5-5")}{P("M4 21h16")}</>,
    refresh: <>{P("M4 4v6h6M20 20v-6h-6")}{P("M20 10a8 8 0 0 0-14-4M4 14a8 8 0 0 0 14 4")}</>,
    sliders: <>{P("M4 6h10M18 6h2M4 12h4M12 12h8M4 18h14M18 18h2")}{P("M16 4v4M10 10v4M16 16v4")}</>,
    eye: <>{P("M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z")}{P("M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z")}</>,
    lock: <>{P("M6 11h12v10H6zM8 11V7a4 4 0 1 1 8 0v4")}</>,
    layers: <>{P("M12 2l10 6-10 6L2 8zM2 14l10 6 10-6")}</>,
    dots: <>{P("M5 12h0M12 12h0M19 12h0")}</>,
    chevRight: <>{P("M9 6l6 6-6 6")}</>,
    chevDown: <>{P("M6 9l6 6 6-6")}</>,
    external: <>{P("M14 4h6v6M10 14L20 4M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6")}</>,
    flag: <>{P("M5 21V4M5 4h12l-2 4 2 4H5")}</>,
    target: <>{P("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 11v2")}</>,
    heart: <>{P("M12 21s-8-5-8-11a5 5 0 0 1 8-4 5 5 0 0 1 8 4c0 6-8 11-8 11z")}</>,
    user: <>{P("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0")}</>,
    plug: <>{P("M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6z M12 18v4")}</>,
    mail: <>{P("M3 6h18v12H3zM3 6l9 7 9-7")}</>,
    phone: <>{P("M4 4h4l2 5-3 2a12 12 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 2 6a2 2 0 0 1 2-2z")}</>,
    terminal: <>{P("M4 5h16v14H4zM7 10l3 2-3 2M13 14h4")}</>,
    slack: <>{P("M5 14h4v4a2 2 0 1 1-4 0zM10 19v-4h4a2 2 0 1 1 0 4zM19 10h-4V6a2 2 0 1 1 4 0zM14 5v4h-4a2 2 0 1 1 0-4z")}</>,
    copy: <>{P("M8 8h10v12H8zM4 4h10v4")}</>,
    trendDown: <>{P("M3 7l6 6 4-4 8 8")}{P("M14 17h7v-7")}</>,
  };
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" {...rest} style={{flexShrink:0,display:'block',...rest.style}}>
      {paths[name] || null}
    </svg>
  );
};

// -------- Animated number (short interp on change) -------
function AnimatedNumber({ value, dec = 2, prefix = "", suffix = "", className = "", flash = true }) {
  const [prev, setPrev] = useState(value);
  const [dir, setDir] = useState(0);
  useEffect(() => {
    if (value !== prev) {
      setDir(value > prev ? 1 : -1);
      const t = setTimeout(() => setDir(0), 500);
      setPrev(value);
      return () => clearTimeout(t);
    }
  }, [value]);
  const color = flash && dir === 1 ? 'var(--up)' : flash && dir === -1 ? 'var(--down)' : undefined;
  return (
    <span className={`mono count ${className}`} style={{ color }}>
      {prefix}{fmt(value, dec)}{suffix}
    </span>
  );
}

// -------- Sparkline --------
function Sparkline({ data, width = 80, height = 22, color, fill = true, strokeW = 1.4 }) {
  if (!data || data.length === 0) return null;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => [i * step, height - ((v - min) / span) * height]);
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const col = color || (data[data.length - 1] >= data[0] ? 'var(--up)' : 'var(--down)');
  const fillD = `${d} L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} className="spark" style={{display:'block'}}>
      {fill && <path d={fillD} fill={col} opacity="0.1" />}
      <path d={d} fill="none" stroke={col} strokeWidth={strokeW} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// -------- Area chart (equity curve etc) --------
function AreaChart({ data, width, height, color = 'var(--accent)', showAxis = true, compact = false, highlightLast = true }) {
  const w = width, h = height;
  const padL = compact ? 0 : 44, padR = compact ? 0 : 12, padT = 16, padB = compact ? 0 : 22;
  const iw = w - padL - padR, ih = h - padT - padB;
  const values = data.map(d => d.v);
  const min = Math.min(...values), max = Math.max(...values);
  const pad = (max - min) * 0.08;
  const yMin = min - pad, yMax = max + pad, span = yMax - yMin || 1;
  const step = iw / (data.length - 1);
  const pts = data.map((d, i) => [padL + i * step, padT + ih - ((d.v - yMin) / span) * ih]);
  const dPath = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const fillPath = `${dPath} L${padL + iw},${padT + ih} L${padL},${padT + ih} Z`;
  const last = pts[pts.length - 1];

  const gridLines = showAxis ? [0, 0.25, 0.5, 0.75, 1].map(t => padT + ih * t) : [];
  const gridVals = showAxis ? [0, 0.25, 0.5, 0.75, 1].map(t => yMax - span * t) : [];

  return (
    <svg width={w} height={h} style={{display:'block'}}>
      <defs>
        <linearGradient id={`ag-${color.replace(/[^a-z0-9]/gi,'')}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {showAxis && gridLines.map((y, i) => (
        <g key={i}>
          <line x1={padL} x2={padL + iw} y1={y} y2={y} stroke="var(--line)" strokeDasharray="2 3" />
          <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="9" fontFamily="var(--f-mono)" fill="var(--fg-2)">
            {gridVals[i] >= 1000 ? `${(gridVals[i]/1000).toFixed(1)}k` : gridVals[i].toFixed(1)}
          </text>
        </g>
      ))}
      <path d={fillPath} fill={`url(#ag-${color.replace(/[^a-z0-9]/gi,'')})`} />
      <path d={dPath} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
      {highlightLast && last && (
        <>
          <circle cx={last[0]} cy={last[1]} r="3.5" fill={color} />
          <circle cx={last[0]} cy={last[1]} r="7" fill={color} opacity="0.18" />
        </>
      )}
    </svg>
  );
}

// -------- Candlestick chart --------
function CandleChart({ candles, width, height, liveLast }) {
  const w = width, h = height;
  const padL = 48, padR = 56, padT = 10, padB = 22;
  const iw = w - padL - padR, ih = h - padT - padB;
  const highs = candles.map(c => c.h), lows = candles.map(c => c.l);
  let yMin = Math.min(...lows), yMax = Math.max(...highs);
  const pad = (yMax - yMin) * 0.05;
  yMin -= pad; yMax += pad;
  const span = yMax - yMin || 1;
  const cw = iw / candles.length;
  const bw = Math.max(2, cw * 0.62);
  const y = (v) => padT + ih - ((v - yMin) / span) * ih;

  const gridN = 5;
  const last = candles[candles.length - 1];
  const lastPx = liveLast != null ? liveLast : last.c;

  return (
    <svg width={w} height={h} style={{display:'block'}}>
      {[...Array(gridN)].map((_, i) => {
        const t = i / (gridN - 1);
        const yy = padT + ih * t;
        const v = yMax - span * t;
        return (
          <g key={i}>
            <line x1={padL} x2={padL + iw} y1={yy} y2={yy} stroke="var(--line)" strokeDasharray="2 4" />
            <text x={padL - 6} y={yy + 3} textAnchor="end" fontSize="9.5" fontFamily="var(--f-mono)" fill="var(--fg-2)">
              {v >= 1000 ? v.toLocaleString(undefined,{maximumFractionDigits:0}) : v.toFixed(2)}
            </text>
          </g>
        );
      })}
      {candles.map((c, i) => {
        const up = c.c >= c.o;
        const col = up ? 'var(--up)' : 'var(--down)';
        const x = padL + i * cw + cw / 2;
        const bx = x - bw / 2;
        const by = y(Math.max(c.o, c.c));
        const bh = Math.max(1, Math.abs(y(c.o) - y(c.c)));
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="1" opacity="0.7" />
            <rect x={bx} y={by} width={bw} height={bh} fill={col} opacity={up ? 0.85 : 0.9} rx="1" />
          </g>
        );
      })}
      {/* Live price line */}
      <g>
        <line x1={padL} x2={padL + iw} y1={y(lastPx)} y2={y(lastPx)}
              stroke="var(--accent)" strokeDasharray="3 3" strokeWidth="1" opacity="0.7" />
        <rect x={padL + iw + 4} y={y(lastPx) - 10} width={padR - 8} height={20} fill="var(--accent)" rx="3" />
        <text x={padL + iw + padR/2} y={y(lastPx) + 4} textAnchor="middle" fontSize="10.5" fontFamily="var(--f-mono)" fontWeight="600" fill="var(--accent-ink)">
          {lastPx >= 1000 ? lastPx.toLocaleString(undefined,{maximumFractionDigits:0}) : lastPx.toFixed(2)}
        </text>
      </g>
    </svg>
  );
}

// -------- Reusable components --------
function Panel({ title, subtitle, right, className = "", children, tone, pad = 16, header = true }) {
  return (
    <div className={`panel ${className}`} style={tone === 'accent' ? { borderColor: 'rgba(59,130,246,0.25)' } : {}}>
      {header && (title || right) && (
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', borderBottom:'1px solid var(--line)' }}>
          <div className="col" style={{ gap: 2 }}>
            {title && <div className="label">{title}</div>}
            {subtitle && <div style={{ fontSize: 12, color: 'var(--fg-1)' }}>{subtitle}</div>}
          </div>
          {right}
        </div>
      )}
      <div style={{ padding: pad }}>{children}</div>
    </div>
  );
}

function Stat({ label, value, delta, hint, tone, mono = true, large = false }) {
  const sz = large ? 26 : 20;
  const col = tone === 'up' ? 'var(--up)' : tone === 'down' ? 'var(--down)' : tone === 'accent' ? 'var(--accent-2)' : 'var(--fg-0)';
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="label">{label}</div>
      <div className={mono ? 'display' : ''} style={{ fontSize: sz, color: col, lineHeight: 1.05 }}>{value}</div>
      {delta && <div style={{ fontSize: 11, color: 'var(--fg-2)' }}>{delta}</div>}
      {hint && <div style={{ fontSize: 11, color: 'var(--fg-2)' }}>{hint}</div>}
    </div>
  );
}

function Pill({ children, tone, className = "", style }) {
  return <span className={`pill ${tone ? `pill-${tone}`:''} ${className}`} style={style}>{children}</span>;
}

function Switch({ on, onChange, size = 'md' }) {
  return (
    <div className="switch" data-on={on ? 'true' : 'false'}
         onClick={() => onChange && onChange(!on)}
         role="switch" aria-checked={on} tabIndex={0}
         onKeyDown={e => { if(e.key===' '||e.key==='Enter') { e.preventDefault(); onChange && onChange(!on); } }}
    />
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="seg">
      {options.map(o => (
        <button key={o.v} data-active={value === o.v} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

// -------- Live clock --------
function LiveClock({ compact = false }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const hh = String(now.getUTCHours()).padStart(2,'0');
  const mm = String(now.getUTCMinutes()).padStart(2,'0');
  const ss = String(now.getUTCSeconds()).padStart(2,'0');
  if (compact) return <span className="mono fg-1" style={{fontSize:11}}>{hh}:{mm}:{ss} UTC</span>;
  return (
    <div className="row center gap-8">
      <span className="dot dot-live" />
      <span className="mono" style={{fontSize:12, letterSpacing:'0.04em'}}>{hh}:{mm}:{ss}</span>
      <span className="label">UTC</span>
    </div>
  );
}

// -------- Heat bar --------
function HeatBar({ value, cap, warn = 0.7, color }) {
  const pct = Math.min(100, (value / cap) * 100);
  const isWarn = value / cap > warn;
  const bg = color || (isWarn ? 'var(--warn)' : 'var(--up)');
  return (
    <div className="bar">
      <div style={{ width: `${pct}%`, background: bg, boxShadow: `0 0 8px ${bg}` }} />
    </div>
  );
}

Object.assign(window, {
  Icon, AnimatedNumber, Sparkline, AreaChart, CandleChart,
  Panel, Stat, Pill, Switch, Segmented, LiveClock, HeatBar,
});
