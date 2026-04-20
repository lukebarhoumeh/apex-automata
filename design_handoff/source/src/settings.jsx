// ============================================================
// Apex Automata — Settings page
// ============================================================

function SettingsPage() {
  const [section, setSection] = useState('account');
  const [limits, setLimits] = useState(SETTINGS.riskLimits);
  const [notifs, setNotifs] = useState(SETTINGS.notifications);
  const [killArmed, setKillArmed] = useState(SETTINGS.riskLimits.killSwitchArmed);

  const sections = [
    { k: 'account',       label: 'Account',       icon: 'user' },
    { k: 'venues',        label: 'Venues · API keys', icon: 'plug' },
    { k: 'risk',          label: 'Risk limits',   icon: 'shield' },
    { k: 'notifications', label: 'Notifications', icon: 'bell' },
    { k: 'advanced',      label: 'Advanced',      icon: 'terminal' },
  ];

  return (
    <div style={{padding: 20, display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16}}>
      {/* Left rail */}
      <div className="col" style={{gap: 12}}>
        <Panel header={false} pad={0}>
          <div style={{padding: '14px 16px', borderBottom: '1px solid var(--line)'}}>
            <div className="eyebrow">WORKSPACE</div>
            <div style={{marginTop: 4, fontWeight: 500}}>{SETTINGS.account.name}</div>
            <div className="mono" style={{fontSize: 10.5, color: 'var(--fg-2)', marginTop: 2}}>{SETTINGS.account.plan}</div>
          </div>
          <div style={{padding: 4}}>
            {sections.map(s => (
              <button key={s.k} onClick={() => setSection(s.k)}
                style={{
                  width: '100%', textAlign: 'left', padding: '9px 12px',
                  background: section === s.k ? 'rgba(59,130,246,0.1)' : 'transparent',
                  border: 'none', borderRadius: 4, cursor: 'pointer',
                  color: section === s.k ? 'var(--accent-2)' : 'var(--fg-1)',
                  display: 'flex', alignItems: 'center', gap: 10,
                  fontSize: 12.5, fontFamily: 'inherit',
                  borderLeft: section === s.k ? '2px solid var(--accent-2)' : '2px solid transparent',
                  marginBottom: 2,
                }}>
                <Icon name={s.icon} size={13}/> {s.label}
              </button>
            ))}
          </div>
        </Panel>

        {/* Kill switch card */}
        <Panel header={false} pad={0} style={{borderColor: killArmed ? 'rgba(57,217,138,0.3)' : 'rgba(255,90,106,0.3)'}}>
          <div style={{padding: 14}}>
            <div className="eyebrow" style={{color: killArmed ? 'var(--up)' : 'var(--down)'}}>
              <span className="dot" style={{background: killArmed ? 'var(--up)' : 'var(--down)', marginRight: 6, boxShadow: killArmed ? '0 0 6px var(--up-glow)' : '0 0 6px var(--down-glow)'}}/>
              KILL SWITCH
            </div>
            <div style={{fontSize: 12, color: 'var(--fg-1)', marginTop: 8, lineHeight: 1.5}}>
              {killArmed ? 'Armed. Engine will auto-flatten if any trigger ladder fires at level 4.' : 'DISARMED. No automatic shutdown.'}
            </div>
            <button
              className={killArmed ? 'btn btn-sm' : 'btn btn-primary btn-sm'}
              style={{width: '100%', marginTop: 10}}
              onClick={() => setKillArmed(v => !v)}>
              {killArmed ? 'Disarm' : 'Arm kill switch'}
            </button>
          </div>
        </Panel>
      </div>

      {/* Right pane */}
      <div className="col" style={{gap: 16}}>
        {section === 'account' && <AccountSection/>}
        {section === 'venues' && <VenuesSection/>}
        {section === 'risk' && <RiskLimitsSection limits={limits} onChange={setLimits}/>}
        {section === 'notifications' && <NotificationsSection notifs={notifs} onChange={setNotifs}/>}
        {section === 'advanced' && <AdvancedSection/>}
      </div>
    </div>
  );
}

function SectionHeader({ title, subtitle, icon, tone }) {
  return (
    <div style={{padding: '16px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12}}>
      <div style={{
        width: 36, height: 36, borderRadius: 6,
        background: `color-mix(in srgb, ${tone || 'var(--accent-2)'} 14%, var(--bg-2))`,
        border: `1px solid color-mix(in srgb, ${tone || 'var(--accent-2)'} 35%, var(--line))`,
        display: 'grid', placeItems: 'center',
        color: tone || 'var(--accent-2)',
      }}>
        <Icon name={icon} size={18}/>
      </div>
      <div>
        <div style={{fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em'}}>{title}</div>
        <div style={{fontSize: 11.5, color: 'var(--fg-2)', marginTop: 2}}>{subtitle}</div>
      </div>
    </div>
  );
}

function FormRow({ label, hint, children }) {
  return (
    <div style={{padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20, alignItems: 'start'}}>
      <div>
        <div style={{fontSize: 12.5, fontWeight: 500, color: 'var(--fg-0)'}}>{label}</div>
        {hint && <div style={{fontSize: 11, color: 'var(--fg-2)', marginTop: 4, lineHeight: 1.4}}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function AccountSection() {
  const a = SETTINGS.account;
  return (
    <Panel header={false} pad={0}>
      <SectionHeader icon="user" title="Account" subtitle="Your identity across Apex Automata" tone="var(--accent-2)"/>
      <FormRow label="Display name">
        <input type="text" defaultValue={a.name} style={{width: 320}}/>
      </FormRow>
      <FormRow label="Email" hint="Used for account notifications and 2FA recovery.">
        <input type="text" defaultValue={a.email} style={{width: 320}}/>
      </FormRow>
      <FormRow label="Plan" hint="Billed annually. Renews 2027-01-04.">
        <div className="row center gap-8">
          <span className="mono" style={{fontSize: 13}}>{a.plan}</span>
          <Pill tone="accent">{a.seat}</Pill>
          <button className="btn btn-ghost btn-sm" style={{marginLeft: 'auto'}}>Manage billing →</button>
        </div>
      </FormRow>
      <FormRow label="Two-factor authentication" hint="TOTP via authenticator app.">
        <div className="row center gap-8">
          <Pill tone="up">ENABLED</Pill>
          <button className="btn btn-sm">Regenerate recovery codes</button>
        </div>
      </FormRow>
      <FormRow label="API key · personal" hint="Automation against your workspace. Treat like a password.">
        <div className="row center gap-8">
          <input type="text" readOnly value="apex_live_sk_4aF3x•••••••••••••9zQp" style={{width: 320, fontFamily: 'var(--f-mono)', fontSize: 11.5}}/>
          <button className="btn btn-sm"><Icon name="copy" size={12}/> Copy</button>
          <button className="btn btn-sm btn-ghost" style={{color: 'var(--down)'}}>Revoke</button>
        </div>
      </FormRow>
      <div style={{padding: '14px 20px', display: 'flex', justifyContent: 'flex-end', gap: 8}}>
        <button className="btn btn-ghost btn-sm">Cancel</button>
        <button className="btn btn-primary btn-sm">Save changes</button>
      </div>
    </Panel>
  );
}

function VenuesSection() {
  return (
    <Panel header={false} pad={0}>
      <SectionHeader icon="plug" title="Venues · API keys" subtitle="Exchanges and brokers the engine can route to" tone="var(--up)"/>
      <div style={{padding: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
        {SETTINGS.venues.map(v => (
          <div key={v.name} style={{
            padding: 16, border: '1px solid var(--line)', borderRadius: 6,
            background: v.status === 'connected' ? 'rgba(57,217,138,0.04)' : 'var(--bg-2)',
            borderColor: v.status === 'connected' ? 'rgba(57,217,138,0.25)' : 'var(--line)',
          }}>
            <div className="row between" style={{marginBottom: 10}}>
              <div>
                <div style={{fontSize: 14, fontWeight: 600}}>{v.name}</div>
                <div className="mono" style={{fontSize: 10.5, color: 'var(--fg-2)', marginTop: 2}}>{v.kind}</div>
              </div>
              {v.status === 'connected'
                ? <div className="row center gap-6"><span className="dot dot-live"/><span className="mono" style={{fontSize: 10.5, color: 'var(--up)'}}>LIVE · {v.latency}ms</span></div>
                : <Pill>DISABLED</Pill>}
            </div>
            {v.status === 'connected' ? (
              <>
                <div className="label-sm">API KEY</div>
                <div className="row center gap-6" style={{marginTop: 4}}>
                  <input type="text" readOnly value={v.key} style={{flex: 1, fontFamily: 'var(--f-mono)', fontSize: 11}}/>
                  <button className="btn btn-xs">Rotate</button>
                </div>
                <div className="row gap-6" style={{marginTop: 10}}>
                  <button className="btn btn-sm btn-ghost" style={{color: 'var(--down)'}}>Disconnect</button>
                  <button className="btn btn-sm" style={{marginLeft: 'auto'}}>Permissions</button>
                </div>
              </>
            ) : (
              <button className="btn btn-primary btn-sm" style={{width: '100%', marginTop: 8}}>
                <Icon name="plus" size={12}/> Connect
              </button>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}

function RiskLimitsSection({ limits, onChange }) {
  const set = (k, v) => onChange({ ...limits, [k]: v });
  return (
    <Panel header={false} pad={0}>
      <SectionHeader icon="shield" title="Risk limits" subtitle="Hard ceilings the engine will not cross" tone="var(--down)"/>
      <div style={{padding: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20}}>
        <RiskSlider label="MAX PORTFOLIO HEAT" unit="%" min={0.5} max={5} step={0.1}
          value={limits.maxPortfolioHeatPct} onChange={v => set('maxPortfolioHeatPct', v)}
          hint="Sum of open-risk across all positions."/>
        <RiskSlider label="MAX DRAWDOWN" unit="%" min={2} max={20} step={0.5}
          value={limits.maxDrawdownPct} onChange={v => set('maxDrawdownPct', v)}
          hint="Flatten all when exceeded."/>
        <RiskSlider label="MAX POSITION SIZE" unit="%" min={5} max={80} step={1}
          value={limits.maxPositionPct} onChange={v => set('maxPositionPct', v)}
          hint="% of portfolio per single symbol."/>
        <RiskSlider label="MAX CONSEC LOSSES" unit="" min={2} max={10} step={1}
          value={limits.maxConsecLosses} onChange={v => set('maxConsecLosses', v)}
          hint="Pause strategy on threshold."/>
        <RiskSlider label="MAX DAILY LOSS" unit="$" min={500} max={10_000} step={100}
          value={limits.maxDailyLoss} onChange={v => set('maxDailyLoss', v)}
          hint="Stop trading for the day."/>
      </div>
      <div style={{padding: '12px 20px', borderTop: '1px solid var(--line)'}}>
        <ToggleRow label="Allow short selling" hint="If off, engine will only take long positions." on={limits.allowShort} onChange={v => set('allowShort', v)}/>
        <ToggleRow label="Allow overnight positions" hint="If off, engine will flatten positions before session close." on={limits.allowOvernight} onChange={v => set('allowOvernight', v)}/>
      </div>
    </Panel>
  );
}

function RiskSlider({ label, value, min, max, step, unit, hint, onChange }) {
  const display = unit === '$' ? `$${fmt(value, 0)}` : `${value}${unit}`;
  return (
    <div>
      <div className="row between" style={{marginBottom: 4}}>
        <span className="label-sm">{label}</span>
        <span className="mono" style={{fontSize: 13, color: 'var(--down)', fontWeight: 500}}>{display}</span>
      </div>
      <input type="range" className="slider" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}/>
      {hint && <div style={{fontSize: 11, color: 'var(--fg-2)', marginTop: 4, lineHeight: 1.4}}>{hint}</div>}
    </div>
  );
}

function ToggleRow({ label, hint, on, onChange }) {
  return (
    <div style={{padding: '10px 0', display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'center', borderBottom: '1px solid var(--line)'}}>
      <div>
        <div style={{fontSize: 12.5, fontWeight: 500}}>{label}</div>
        {hint && <div style={{fontSize: 11, color: 'var(--fg-2)', marginTop: 2}}>{hint}</div>}
      </div>
      <Switch on={on} onChange={() => onChange(!on)}/>
    </div>
  );
}

function NotificationsSection({ notifs, onChange }) {
  const toggle = (i) => onChange(notifs.map((n, j) => i === j ? { ...n, enabled: !n.enabled } : n));
  return (
    <Panel header={false} pad={0}>
      <SectionHeader icon="bell" title="Notifications" subtitle="Where the system reaches you" tone="var(--warn)"/>
      <table className="t">
        <thead>
          <tr><th>CHANNEL</th><th>TARGET</th><th>TEST</th><th>ENABLED</th></tr>
        </thead>
        <tbody>
          {notifs.map((n, i) => (
            <tr key={n.channel}>
              <td>
                <div className="row center gap-8">
                  <div style={{
                    width: 28, height: 28, borderRadius: 4,
                    background: 'var(--bg-2)', display: 'grid', placeItems: 'center',
                    color: n.enabled ? 'var(--accent-2)' : 'var(--fg-3)',
                    border: '1px solid var(--line)'
                  }}>
                    <Icon name={n.channel === 'Slack' ? 'slack' : n.channel === 'Email' ? 'mail' : n.channel === 'SMS' ? 'phone' : n.channel === 'Webhook' ? 'terminal' : 'bell'} size={14}/>
                  </div>
                  <span style={{fontWeight: 500}}>{n.channel}</span>
                </div>
              </td>
              <td className="mono" style={{fontSize: 11.5, color: 'var(--fg-1)'}}>{n.target}</td>
              <td><button className="btn btn-xs">Send test</button></td>
              <td><Switch on={n.enabled} onChange={() => toggle(i)}/></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function AdvancedSection() {
  return (
    <Panel header={false} pad={0}>
      <SectionHeader icon="terminal" title="Advanced" subtitle="Power-user knobs. Proceed carefully." tone="var(--fg-1)"/>
      <FormRow label="Log level" hint="DEBUG will fill disk quickly.">
        <select defaultValue="INFO" style={{width: 200}}>
          <option>DEBUG</option><option>INFO</option><option>WARN</option><option>ERROR</option>
        </select>
      </FormRow>
      <FormRow label="Order timeout" hint="Cancel after no fill in N seconds.">
        <input type="number" defaultValue="30" style={{width: 120}} className="mono"/>
      </FormRow>
      <FormRow label="Paper-trade mode" hint="Route all orders to the simulator. No real capital at risk.">
        <Switch on={false} onChange={() => {}}/>
      </FormRow>
      <FormRow label="Export workspace" hint="Download all rules, models, and journal entries.">
        <button className="btn btn-sm"><Icon name="download" size={12}/> Export as .tar.gz</button>
      </FormRow>
      <FormRow label="Danger zone" hint="Irreversible. We cannot recover the data.">
        <div className="col gap-6">
          <button className="btn btn-sm btn-ghost" style={{color: 'var(--down)', justifyContent: 'start', width: 260}}>Reset all positions → paper</button>
          <button className="btn btn-sm btn-ghost" style={{color: 'var(--down)', justifyContent: 'start', width: 260}}>Delete workspace</button>
        </div>
      </FormRow>
    </Panel>
  );
}

Object.assign(window, { SettingsPage });
