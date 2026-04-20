// ============================================================
// Apex Automata — Orders & Positions
// ============================================================

function OrdersPositions() {
  const [feed, setFeed] = useState(FEED.snapshot());
  const [tab, setTab] = useState('orders');
  const [sideFilter, setSideFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [symFilter, setSymFilter] = useState('ALL');
  const [selected, setSelected] = useState(null);
  const [liveOrders, setLiveOrders] = useState(ORDERS);

  useEffect(() => FEED.subscribe(setFeed), []);

  // Inject a fresh order every 14s for liveness
  useEffect(() => {
    const id = setInterval(() => {
      const sym = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
      const t = FEED.snapshot().find(x => x.s === sym.s);
      const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
      const qty = +(Math.random() * 2 + 0.1).toFixed(3);
      const now = new Date();
      const ts = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}:${String(now.getUTCSeconds()).padStart(2,'0')}`;
      const newOrder = {
        id: `o${109 + Math.floor(Math.random() * 200)}`,
        ts, sym: sym.s, side, type: Math.random() > 0.4 ? 'LMT' : 'MKT',
        qty, px: Math.random() > 0.4 ? +(t.last * (1 + (Math.random()-0.5)*0.001)).toFixed(sym.dec) : null,
        status: Math.random() > 0.2 ? 'FILLED' : 'PENDING',
        fillAvg: +(t.last * (1 + (Math.random()-0.5)*0.0004)).toFixed(sym.dec),
        strat: Math.random() > 0.5 ? 'breakout' : 'vwap_mr',
        venue: 'Coinbase'
      };
      setLiveOrders(prev => [newOrder, ...prev].slice(0, 40));
    }, 14000);
    return () => clearInterval(id);
  }, []);

  const filtered = liveOrders.filter(o =>
    (sideFilter === 'ALL' || o.side === sideFilter) &&
    (statusFilter === 'ALL' || o.status === statusFilter) &&
    (symFilter === 'ALL' || o.sym === symFilter)
  );

  // Order stats
  const filledToday = liveOrders.filter(o => o.status === 'FILLED').length;
  const cancelledToday = liveOrders.filter(o => o.status === 'CANCELLED').length;
  const rejectedToday = liveOrders.filter(o => o.status === 'REJECTED').length;
  const pendingCount = liveOrders.filter(o => o.status === 'PENDING').length;

  return (
    <div className="col" style={{ gap: 16, padding: 20 }}>
      {/* Header metrics strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16 }}>
        <MetricCard label="ORDERS TODAY" value={liveOrders.length} icon="orders" />
        <MetricCard label="FILLED" value={filledToday} tone="var(--up)" sub={`${((filledToday / Math.max(1, liveOrders.length))*100).toFixed(0)}%`} icon="check" />
        <MetricCard label="PENDING" value={pendingCount} tone="var(--accent-2)" icon="activity" />
        <MetricCard label="CANCELLED" value={cancelledToday} tone="var(--fg-1)" icon="x" />
        <MetricCard label="REJECTED" value={rejectedToday} tone="var(--down)" icon="alert" />
      </div>

      {/* Positions */}
      <PositionStrip />

      {/* Fills summary row */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        {/* Orders blotter */}
        <Panel header={false} pad={0}>
          <div className="row between center" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
            <div className="row center gap-12">
              <div className="row center gap-8">
                <Icon name="orders" size={14} style={{ color: 'var(--accent-2)' }} />
                <div className="label">ORDER BLOTTER</div>
              </div>
              <div className="row center gap-6">
                <span className="dot dot-live" />
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-2)' }}>STREAMING</span>
              </div>
            </div>
            <div className="row center gap-6">
              <Segmented value={sideFilter} onChange={setSideFilter} options={[
                { v: 'ALL', l: 'ALL' }, { v: 'BUY', l: 'BUY' }, { v: 'SELL', l: 'SELL' }
              ]}/>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ fontSize: 11.5, height: 28, padding: '0 8px' }}>
                <option value="ALL">All status</option>
                <option value="FILLED">Filled</option>
                <option value="PENDING">Pending</option>
                <option value="CANCELLED">Cancelled</option>
                <option value="REJECTED">Rejected</option>
              </select>
              <select value={symFilter} onChange={e => setSymFilter(e.target.value)} style={{ fontSize: 11.5, height: 28, padding: '0 8px' }}>
                <option value="ALL">All symbols</option>
                {SYMBOLS.map(s => <option key={s.s} value={s.s}>{s.s}</option>)}
              </select>
              <button className="btn btn-ghost btn-sm"><Icon name="download" size={13}/></button>
            </div>
          </div>

          <div style={{ maxHeight: 500, overflowY: 'auto' }}>
            <table className="t">
              <thead>
                <tr>
                  <th>TIME</th>
                  <th>ID</th>
                  <th>SYMBOL</th>
                  <th>SIDE</th>
                  <th>TYPE</th>
                  <th className="num">QTY</th>
                  <th className="num">PRICE</th>
                  <th className="num">FILL AVG</th>
                  <th>STATUS</th>
                  <th>STRATEGY</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o, i) => (
                  <tr key={o.id}
                      onClick={() => setSelected(o)}
                      style={{ cursor: 'pointer', background: selected?.id === o.id ? 'var(--bg-2)' : undefined }}
                  >
                    <td className="mono fg-2" style={{fontSize: 11}}>{o.ts}</td>
                    <td className="mono fg-2" style={{fontSize: 11}}>{o.id}</td>
                    <td style={{fontWeight: 500}}>{o.sym}</td>
                    <td>
                      <Pill tone={o.side === 'BUY' ? 'up' : 'down'}>
                        {o.side === 'BUY' ? <Icon name="arrowUp" size={8} stroke={2.5}/> : <Icon name="arrowDown" size={8} stroke={2.5}/>}
                        {o.side}
                      </Pill>
                    </td>
                    <td className="mono" style={{fontSize:11}}>{o.type}</td>
                    <td className="num">{fmt(o.qty, 3)}</td>
                    <td className="num">{o.px != null ? fmt(o.px, 2) : '—'}</td>
                    <td className="num">{o.fillAvg != null ? fmt(o.fillAvg, 2) : '—'}</td>
                    <td>
                      <StatusBadge status={o.status} />
                    </td>
                    <td className="mono" style={{fontSize: 11, color: 'var(--fg-1)'}}>{o.strat}</td>
                    <td className="num"><Icon name="chevRight" size={12} style={{color:'var(--fg-3)'}}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* Selected order / recent fills */}
        <div className="col gap-16">
          <Panel header={false} pad={0}>
            <div className="row between center" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
              <div className="label">ORDER DETAIL</div>
              {selected && <span className="mono" style={{fontSize: 11, color: 'var(--fg-2)'}}>{selected.id}</span>}
            </div>
            {selected ? <OrderDetail order={selected} onClose={() => setSelected(null)} /> : (
              <div className="col center" style={{ padding: 32, gap: 8 }}>
                <Icon name="orders" size={28} style={{color:'var(--fg-3)'}} stroke={1.3}/>
                <div style={{ fontSize: 12, color: 'var(--fg-2)' }}>Select an order to inspect</div>
              </div>
            )}
          </Panel>

          <Panel header={false} pad={0}>
            <div className="row between center" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
              <div className="label">RECENT FILLS</div>
              <span className="pill">{FILLS.length}</span>
            </div>
            <div style={{ maxHeight: 240, overflowY: 'auto' }}>
              {FILLS.map((f, i) => (
                <div key={i} style={{
                  padding: '8px 16px', borderBottom: '1px solid var(--line)',
                  display: 'grid', gridTemplateColumns: '70px 1fr auto', gap: 10, alignItems: 'center'
                }}>
                  <span className="mono" style={{fontSize: 10.5, color: 'var(--fg-2)'}}>{f.ts.slice(0,8)}</span>
                  <div className="col" style={{gap:1}}>
                    <div className="row center gap-6">
                      <span style={{ fontWeight: 500, fontSize: 12 }}>{f.sym}</span>
                      <Pill tone={f.side === 'BUY' ? 'up' : 'down'}>{f.side}</Pill>
                    </div>
                    <span className="mono" style={{fontSize: 10.5, color: 'var(--fg-2)'}}>
                      {fmt(f.qty, 3)} @ {fmt(f.px, 2)} · slip {fmtSign(f.slip, 2)}bp
                    </span>
                  </div>
                  <span className="mono" style={{fontSize: 11, color: 'var(--fg-1)'}}>
                    ${fmt(f.qty * f.px, 2)}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, tone, sub, icon }) {
  return (
    <div className="panel" style={{ padding: 14 }}>
      <div className="row between center">
        <div className="label">{label}</div>
        {icon && <Icon name={icon} size={14} style={{ color: tone || 'var(--fg-2)', opacity: 0.7 }} />}
      </div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 500, color: tone || 'var(--fg-0)', marginTop: 6 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--fg-2)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }) {
  const cfg = {
    FILLED:    { tone: 'up',   icon: 'check' },
    PENDING:   { tone: 'accent', icon: 'activity' },
    CANCELLED: { tone: null,  icon: 'x' },
    REJECTED:  { tone: 'down', icon: 'alert' },
  }[status] || { tone: null, icon: 'info' };
  return <Pill tone={cfg.tone}><Icon name={cfg.icon} size={9} stroke={2.5}/>{status}</Pill>;
}

function OrderDetail({ order, onClose }) {
  const notional = order.qty * (order.fillAvg || order.px || 0);
  return (
    <div style={{ padding: 16 }}>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div className="col gap-4">
          <div className="row center gap-8">
            <span style={{ fontWeight: 600, fontSize: 18 }}>{order.sym}</span>
            <Pill tone={order.side === 'BUY' ? 'up' : 'down'}>{order.side}</Pill>
            <StatusBadge status={order.status} />
          </div>
          <span className="mono fg-2" style={{fontSize: 11}}>{order.ts} · {order.id} · {order.venue}</span>
        </div>
      </div>
      <div className="inset" style={{ padding: 12, marginBottom: 12 }}>
        <div className="row between" style={{marginBottom: 8}}>
          <div className="col gap-2"><span className="label-sm">TYPE</span><span className="mono">{order.type}</span></div>
          <div className="col gap-2"><span className="label-sm">QTY</span><span className="mono">{fmt(order.qty, 3)}</span></div>
          <div className="col gap-2"><span className="label-sm">LMT PRICE</span><span className="mono">{order.px ? fmt(order.px, 2) : '—'}</span></div>
          <div className="col gap-2"><span className="label-sm">FILL AVG</span><span className="mono">{order.fillAvg ? fmt(order.fillAvg, 2) : '—'}</span></div>
        </div>
        <div className="divider" style={{margin: '8px 0'}}/>
        <div className="row between">
          <div className="col gap-2"><span className="label-sm">NOTIONAL</span><span className="mono" style={{fontSize:14}}>${fmt(notional, 2)}</span></div>
          <div className="col gap-2"><span className="label-sm">STRATEGY</span><span className="mono">{order.strat}</span></div>
          <div className="col gap-2"><span className="label-sm">VENUE</span><span className="mono">{order.venue}</span></div>
        </div>
      </div>
      {order.reason && (
        <div className="inset" style={{ padding: 10, borderColor: 'rgba(255,90,106,0.3)', background: 'rgba(255,90,106,0.05)' }}>
          <div className="row center gap-8"><Icon name="alert" size={12} style={{color: 'var(--down)'}}/><span className="label-sm" style={{color: 'var(--down)'}}>REJECT REASON</span></div>
          <div style={{fontSize: 12, marginTop: 4, color: 'var(--fg-1)'}}>{order.reason}</div>
        </div>
      )}
      <div className="row gap-6" style={{marginTop: 12}}>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
        <button className="btn btn-sm" style={{marginLeft:'auto'}}><Icon name="external" size={12}/> View trace</button>
      </div>
    </div>
  );
}

Object.assign(window, { OrdersPositions });
