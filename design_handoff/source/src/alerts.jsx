// ============================================================
// Apex Automata — Alerts page (if/then/route rule builder)
// ============================================================

function AlertsPage() {
  const [rules, setRules] = useState(ALERT_RULES);
  const [selectedId, setSelectedId] = useState(ALERT_RULES[0].id);
  const selected = rules.find(r => r.id === selectedId);

  const toggleRule = (id) => setRules(rs => rs.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));

  const enabled = rules.filter(r => r.enabled).length;
  const totalFired = rules.reduce((s, r) => s + r.fired, 0);

  return (
    <div className="col" style={{gap: 16, padding: 20}}>
      {/* HERO */}
      <Panel header={false} pad={0} className="scanlines" style={{
        background: 'linear-gradient(135deg, var(--bg-1) 0%, #13100d 60%, var(--bg-1) 100%)',
        borderColor: 'rgba(255,90,106,0.2)', position: 'relative', overflow: 'hidden'
      }}>
        <div className="gridbg" style={{position: 'absolute', inset: 0, opacity: 0.45, pointerEvents: 'none'}}/>
        <div style={{
          position: 'absolute', top: -120, right: -80, width: 340, height: 340, borderRadius: '50%',
          background: 'radial-gradient(circle, var(--down-glow) 0%, transparent 70%)', opacity: 0.45, pointerEvents: 'none'
        }}/>
        <div style={{padding: 28, display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 28, position: 'relative'}}>
          <div className="col gap-10">
            <div className="row center gap-8">
              <Pill tone="down"><Icon name="bell" size={10} stroke={2}/> RULES ENGINE</Pill>
              <span className="pill">{rules.length} RULES · {enabled} ACTIVE</span>
            </div>
            <div style={{
              fontFamily: 'var(--f-serif)', fontStyle: 'italic',
              fontSize: 38, lineHeight: 1.05, fontWeight: 500, letterSpacing: '-0.02em'
            }}>
              <span style={{color: 'var(--down)'}}>When</span> X,<br/>then do Y.
            </div>
            <div style={{fontSize: 12.5, color: 'var(--fg-1)', maxWidth: 380, lineHeight: 1.55}}>
              Conditional rules run continuously against your portfolio, risk, system, and model streams. Configure actions; trust the kill switch.
            </div>
          </div>
          <div className="col gap-12" style={{borderLeft: '1px solid var(--line)', paddingLeft: 24}}>
            <div className="eyebrow">LAST 24H</div>
            <div>
              <div className="display" style={{fontSize: 48, color: 'var(--warn)', lineHeight: 1, textShadow: '0 0 20px rgba(255,196,87,0.3)'}}>
                {totalFired}
              </div>
              <div className="label-sm" style={{marginTop: 4}}>TRIGGERS</div>
            </div>
            <div className="row gap-20">
              <div><div className="label-sm">WARN</div><div className="mono" style={{fontSize: 18, color: 'var(--warn)'}}>{ALERT_FIRED.filter(a => a.level === 'warn').length}</div></div>
              <div><div className="label-sm">CRIT</div><div className="mono" style={{fontSize: 18, color: 'var(--down)'}}>{ALERT_FIRED.filter(a => a.level === 'danger').length}</div></div>
            </div>
          </div>
          <div className="col gap-8" style={{borderLeft: '1px solid var(--line)', paddingLeft: 24}}>
            <div className="eyebrow">CHANNELS</div>
            <FingerprintRow k="SLACK"     v="#trading-alerts"/>
            <FingerprintRow k="EMAIL"     v="jordan@..."/>
            <FingerprintRow k="PAGERDUTY" v="Primary"/>
            <FingerprintRow k="SMS"       v="disabled"/>
            <FingerprintRow k="WEBHOOK"   v="disabled"/>
          </div>
        </div>
      </Panel>

      {/* Main builder: rule list + editor */}
      <div style={{display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16}}>
        {/* Rule list */}
        <Panel header={false} pad={0}>
          <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="label">RULES</div>
            <button className="btn btn-primary btn-sm"><Icon name="plus" size={12}/> New rule</button>
          </div>
          <div>
            {rules.map(r => (
              <div key={r.id} onClick={() => setSelectedId(r.id)}
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid var(--line)',
                  borderLeft: selectedId === r.id ? '2px solid var(--accent-2)' : '2px solid transparent',
                  background: selectedId === r.id ? 'rgba(59,130,246,0.06)' : 'transparent',
                  cursor: 'pointer',
                }}>
                <div className="row between" style={{marginBottom: 4}}>
                  <div className="row center gap-8">
                    <Switch on={r.enabled} onChange={() => toggleRule(r.id)}/>
                    <span style={{fontSize: 13, fontWeight: 500, color: r.enabled ? 'var(--fg-0)' : 'var(--fg-2)'}}>{r.name}</span>
                  </div>
                  {r.fired > 0 && (
                    <Pill tone={r.fired >= 3 ? 'down' : 'warn'}>{r.fired}×</Pill>
                  )}
                </div>
                <div className="mono" style={{fontSize: 10.5, color: 'var(--fg-2)', marginLeft: 34}}>
                  {r.when.metric} {r.when.op} {r.when.value}{r.when.unit} · last fired {r.lastFired}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        {/* Editor */}
        {selected && <RuleEditor rule={selected}/>}
      </div>

      {/* Fired log */}
      <Panel header={false} pad={0}>
        <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
          <div className="row center gap-8">
            <Icon name="activity" size={14} style={{color: 'var(--warn)'}}/>
            <div className="label">TRIGGER LOG · LAST 24H</div>
          </div>
          <button className="btn btn-ghost btn-sm"><Icon name="download" size={12}/> Export</button>
        </div>
        <table className="t">
          <thead>
            <tr><th>TS</th><th>RULE</th><th>DETAIL</th><th>LEVEL</th><th></th></tr>
          </thead>
          <tbody>
            {ALERT_FIRED.map((a, i) => (
              <tr key={i}>
                <td className="mono" style={{fontSize: 11, color: 'var(--fg-2)'}}>{a.ts}</td>
                <td style={{fontWeight: 500}}>{a.rule}</td>
                <td className="mono" style={{fontSize: 11, color: 'var(--fg-1)'}}>{a.detail}</td>
                <td><Pill tone={a.level === 'danger' ? 'down' : 'warn'}>{a.level.toUpperCase()}</Pill></td>
                <td className="num"><button className="btn btn-xs btn-ghost">Inspect</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function RuleEditor({ rule }) {
  return (
    <Panel header={false} pad={0}>
      <div className="row between center" style={{padding: '12px 16px', borderBottom: '1px solid var(--line)'}}>
        <div className="row center gap-8">
          <Icon name="sliders" size={14} style={{color: 'var(--accent-2)'}}/>
          <div className="label">RULE BUILDER</div>
        </div>
        <div className="row center gap-6">
          <button className="btn btn-sm">Duplicate</button>
          <button className="btn btn-sm">Test fire</button>
          <button className="btn btn-primary btn-sm">Save</button>
        </div>
      </div>
      <div style={{padding: 24}}>
        <div className="label-sm" style={{marginBottom: 6}}>RULE NAME</div>
        <input type="text" value={rule.name} onChange={() => {}} style={{width: '100%', fontSize: 14, padding: '8px 10px'}}/>

        {/* Flow diagram */}
        <div style={{marginTop: 24, display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr', gap: 14, alignItems: 'stretch'}}>
          {/* WHEN block */}
          <FlowLabel tone="var(--warn)" label="WHEN"/>
          <FlowBlock tone="var(--warn)">
            <div className="col gap-8">
              <div className="row gap-6">
                <select value={rule.when.source} onChange={() => {}} style={{flex: 1}}>
                  <option value="portfolio">portfolio</option>
                  <option value="risk">risk</option>
                  <option value="model">model</option>
                  <option value="system">system</option>
                </select>
                <span className="mono" style={{color: 'var(--fg-2)', alignSelf: 'center'}}>.</span>
                <select value={rule.when.metric} onChange={() => {}} style={{flex: 2}}>
                  <option value={rule.when.metric}>{rule.when.metric}</option>
                </select>
              </div>
              <div className="row gap-6">
                <select value={rule.when.op} onChange={() => {}} style={{width: 80}}>
                  <option value=">">&gt;</option>
                  <option value="<">&lt;</option>
                  <option value=">=">&gt;=</option>
                  <option value="<=">&lt;=</option>
                  <option value="==">==</option>
                </select>
                <input type="text" defaultValue={rule.when.value} style={{flex: 1, fontFamily: 'var(--f-mono)'}}/>
                <span className="mono" style={{alignSelf: 'center', color: 'var(--fg-2)', fontSize: 11}}>{rule.when.unit || '—'}</span>
              </div>
              <div className="row gap-6" style={{marginTop: 4}}>
                <button className="btn btn-xs btn-ghost"><Icon name="plus" size={10}/> Add AND condition</button>
                <button className="btn btn-xs btn-ghost"><Icon name="plus" size={10}/> Add OR</button>
              </div>
            </div>
          </FlowBlock>

          <FlowArrow/>
          <FlowBlock tone="transparent" compact>
            <div className="label-sm">EVALUATION</div>
            <div className="mono" style={{fontSize: 11, color: 'var(--fg-0)', marginTop: 4}}>every 1s · 7d window</div>
            <div className="mono" style={{fontSize: 11, color: 'var(--fg-2)', marginTop: 2}}>cooldown: 5min</div>
          </FlowBlock>
        </div>

        <div style={{marginTop: 14, display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr', gap: 14, alignItems: 'stretch'}}>
          <FlowLabel tone="var(--down)" label="THEN"/>
          <FlowBlock tone="var(--down)">
            <div className="col gap-8">
              {rule.then.map((a, i) => (
                <div key={i} className="row between center" style={{
                  padding: '8px 10px', background: 'var(--bg-2)',
                  border: '1px solid var(--line)', borderRadius: 4
                }}>
                  <div className="row center gap-8">
                    <ActionIcon kind={a.kind}/>
                    <span style={{fontSize: 12, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em'}}>{a.kind}</span>
                    <span className="mono" style={{fontSize: 11, color: 'var(--fg-2)'}}>→ {a.target || a.channel}</span>
                  </div>
                  <button className="btn btn-xs btn-ghost"><Icon name="x" size={10}/></button>
                </div>
              ))}
              <button className="btn btn-xs btn-ghost" style={{alignSelf: 'start'}}><Icon name="plus" size={10}/> Add action</button>
            </div>
          </FlowBlock>

          <FlowArrow/>
          <FlowBlock tone="transparent" compact>
            <div className="label-sm">EXECUTION</div>
            <div className="mono" style={{fontSize: 11, color: 'var(--fg-0)', marginTop: 4}}>parallel · fire-and-forget</div>
            <div className="mono" style={{fontSize: 11, color: 'var(--fg-2)', marginTop: 2}}>retry: 3× · backoff 2s</div>
          </FlowBlock>
        </div>

        {/* Preview */}
        <div style={{marginTop: 24, padding: 14, background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 4, fontFamily: 'var(--f-mono)', fontSize: 12, lineHeight: 1.6}}>
          <div className="label-sm" style={{marginBottom: 6}}>COMPILED RULE</div>
          <div style={{color: 'var(--fg-1)'}}>
            <span style={{color: 'var(--warn)'}}>WHEN</span>{' '}
            <span style={{color: 'var(--accent-2)'}}>{rule.when.source}.{rule.when.metric}</span>{' '}
            <span style={{color: 'var(--fg-0)'}}>{rule.when.op} {rule.when.value}{rule.when.unit}</span>
          </div>
          <div style={{color: 'var(--fg-1)', marginTop: 3}}>
            <span style={{color: 'var(--down)'}}>THEN</span>{' '}
            {rule.then.map((a, i) => (
              <span key={i}>
                <span style={{color: 'var(--accent-2)'}}>{a.kind}</span>
                <span style={{color: 'var(--fg-0)'}}>({a.target || a.channel})</span>
                {i < rule.then.length - 1 && <span style={{color: 'var(--fg-2)'}}>, </span>}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function FlowLabel({ label, tone }) {
  return (
    <div style={{
      width: 64, display: 'grid', placeItems: 'center',
      background: `color-mix(in srgb, ${tone} 14%, transparent)`,
      border: `1px solid ${tone}`,
      borderRadius: 4,
      fontFamily: 'var(--f-mono)', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
      color: tone,
    }}>
      {label}
    </div>
  );
}

function FlowBlock({ tone, children, compact }) {
  return (
    <div style={{
      padding: compact ? 12 : 14,
      background: tone === 'transparent' ? 'transparent' : 'var(--bg-2)',
      border: tone === 'transparent' ? '1px dashed var(--line-2)' : `1px solid color-mix(in srgb, ${tone} 35%, var(--line))`,
      borderRadius: 4,
    }}>
      {children}
    </div>
  );
}

function FlowArrow() {
  return (
    <div style={{display: 'grid', placeItems: 'center', color: 'var(--fg-3)'}}>
      <Icon name="arrowRight" size={18}/>
    </div>
  );
}

function ActionIcon({ kind }) {
  const map = {
    pause:  { name: 'pause',  color: 'var(--warn)' },
    notify: { name: 'bell',   color: 'var(--accent-2)' },
    flag:   { name: 'flag',   color: 'var(--warn)' },
    block:  { name: 'shield', color: 'var(--down)' },
  };
  const c = map[kind] || map.notify;
  return (
    <div style={{
      width: 22, height: 22, borderRadius: 3,
      background: `color-mix(in srgb, ${c.color} 18%, var(--bg-1))`,
      display: 'grid', placeItems: 'center',
      color: c.color
    }}>
      <Icon name={c.name} size={12}/>
    </div>
  );
}

function Switch({ on, onChange }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onChange && onChange(); }}
      style={{
        width: 28, height: 16, borderRadius: 999,
        background: on ? 'var(--up)' : 'var(--bg-2)',
        border: `1px solid ${on ? 'var(--up)' : 'var(--line-2)'}`,
        position: 'relative', cursor: 'pointer', padding: 0,
        boxShadow: on ? '0 0 6px var(--up-glow)' : 'none',
        transition: 'all 120ms ease',
      }}>
      <div style={{
        position: 'absolute', top: 1, left: on ? 13 : 1,
        width: 12, height: 12, borderRadius: '50%',
        background: 'white',
        transition: 'left 120ms ease',
      }}/>
    </button>
  );
}

Object.assign(window, { AlertsPage });
