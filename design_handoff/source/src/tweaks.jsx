// ============================================================
// Apex Automata — Tweaks panel
// ============================================================

const ACCENTS = {
  electric: { name: 'Electric Blue',  accent: '#3b82f6', accent2: '#60a5fa', glow: 'rgba(59,130,246,0.35)', ink: '#ffffff' },
  phosphor: { name: 'Phosphor Green', accent: '#39d98a', accent2: '#6ee7a8', glow: 'rgba(57,217,138,0.35)',  ink: '#041a0d' },
  amber:    { name: 'Terminal Amber', accent: '#ffb020', accent2: '#ffc94d', glow: 'rgba(255,176,32,0.35)',  ink: '#1a1000' },
  magenta:  { name: 'Magenta Signal', accent: '#e879f9', accent2: '#f0abfc', glow: 'rgba(232,121,249,0.38)', ink: '#1a0d1d' },
  white:    { name: 'Paper White',    accent: '#f4f4f5', accent2: '#ffffff', glow: 'rgba(244,244,245,0.25)', ink: '#0a0d14' },
};

const DENSITIES = {
  compact:     { name: 'Compact',     scale: 0.92 },
  comfortable: { name: 'Comfortable', scale: 1.00 },
  spacious:    { name: 'Spacious',    scale: 1.08 },
};

function applyTweaks({ accent, density }) {
  const root = document.documentElement;
  const a = ACCENTS[accent] || ACCENTS.electric;
  root.style.setProperty('--accent', a.accent);
  root.style.setProperty('--accent-2', a.accent2);
  root.style.setProperty('--accent-glow', a.glow);
  root.style.setProperty('--accent-ink', a.ink);
  root.style.setProperty('--accent-soft', a.accent + '22');
  const d = DENSITIES[density] || DENSITIES.comfortable;
  root.style.setProperty('--density', d.scale);
  root.dataset.density = density;
}

function TweaksPanel({ tweaks, onChange, onClose }) {
  return (
    <div style={{
      position: 'fixed', right: 20, bottom: 20, zIndex: 70,
      width: 320, background: 'var(--bg-1)',
      border: '1px solid var(--line-2)',
      borderRadius: 10,
      boxShadow: '0 24px 48px -12px rgba(0,0,0,0.7), 0 0 0 1px var(--line-2)',
    }}>
      <div className="row between center" style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
        <div className="row center gap-8">
          <Icon name="sliders" size={14} style={{ color: 'var(--accent-2)' }}/>
          <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: '0.04em' }}>TWEAKS</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="x" size={13}/></button>
      </div>

      <div className="col" style={{ padding: 14, gap: 16 }}>
        {/* Accent */}
        <div>
          <div className="label" style={{ marginBottom: 8 }}>ACCENT COLOR</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
            {Object.entries(ACCENTS).map(([k, a]) => (
              <button key={k} onClick={() => onChange({ accent: k })}
                style={{
                  position: 'relative',
                  aspectRatio: '1',
                  borderRadius: 7,
                  border: tweaks.accent === k ? `1.5px solid ${a.accent}` : '1px solid var(--line)',
                  background: `linear-gradient(135deg, ${a.accent}, ${a.accent2})`,
                  cursor: 'pointer',
                  boxShadow: tweaks.accent === k ? `0 0 0 3px ${a.glow}` : 'none',
                  padding: 0,
                }}
                title={a.name}
              >
                {tweaks.accent === k && (
                  <span style={{ position:'absolute', inset: 0, display:'grid', placeItems:'center', color: a.ink }}>
                    <Icon name="check" size={14} stroke={2.4}/>
                  </span>
                )}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-2)', marginTop: 6 }}>{ACCENTS[tweaks.accent]?.name}</div>
        </div>

        {/* Density */}
        <div>
          <div className="label" style={{ marginBottom: 8 }}>DENSITY</div>
          <Segmented value={tweaks.density} onChange={v => onChange({ density: v })} options={[
            { v: 'compact', l: 'Compact' },
            { v: 'comfortable', l: 'Comfortable' },
            { v: 'spacious', l: 'Spacious' },
          ]}/>
        </div>

        {/* Dashboard layout */}
        <div>
          <div className="label" style={{ marginBottom: 8 }}>DASHBOARD LAYOUT</div>
          <Segmented value={tweaks.layout} onChange={v => onChange({ layout: v })} options={[
            { v: 'focus', l: 'Focus' },
            { v: 'split', l: 'Split' },
          ]}/>
          <div style={{ fontSize: 11, color: 'var(--fg-2)', marginTop: 6 }}>
            {tweaks.layout === 'focus' ? 'Chart primary, rail of telemetry' : 'Chart + equity side-by-side'}
          </div>
        </div>

        {/* Mode shortcut */}
        <div>
          <div className="label" style={{ marginBottom: 8 }}>ENGINE MODE</div>
          <Segmented value={tweaks.mode} onChange={v => onChange({ mode: v })} options={[
            { v: 'paper', l: 'Paper' },
            { v: 'live', l: 'Live' },
            { v: 'paused', l: 'Paused' },
          ]}/>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { TweaksPanel, applyTweaks, ACCENTS, DENSITIES });
