// ============================================================
// Apex Automata — App root
// ============================================================

function App() {
  const defaults = window.TWEAK_DEFAULTS || { accent: 'electric', density: 'comfortable', layout: 'focus', mode: 'paper' };
  const [tweaks, setTweaks] = useState(defaults);
  const [route, setRoute] = useState(() => localStorage.getItem('apex:route') || 'dashboard');
  const [commandOpen, setCommandOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [editModeAvailable, setEditModeAvailable] = useState(false);

  // Apply theme tokens on mount / change
  useEffect(() => { applyTweaks(tweaks); }, [tweaks.accent, tweaks.density]);

  // Persist route + expose for screenshot automation
  useEffect(() => { localStorage.setItem('apex:route', route); }, [route]);
  useEffect(() => { window.__setRoute = setRoute; }, []);

  const setTweakPatch = useCallback((patch) => {
    setTweaks(prev => {
      const next = { ...prev, ...patch };
      // persist to host
      try {
        window.parent.postMessage({ type: '__edit_mode_set_keys', edits: patch }, '*');
      } catch {}
      return next;
    });
  }, []);

  // Edit-mode host integration
  useEffect(() => {
    const onMsg = (e) => {
      const d = e.data || {};
      if (d.type === '__activate_edit_mode') setTweaksOpen(true);
      else if (d.type === '__deactivate_edit_mode') setTweaksOpen(false);
    };
    window.addEventListener('message', onMsg);
    setEditModeAvailable(true);
    try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch {}
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); setCommandOpen(v => !v); return; }
      if (e.key === 'Escape') { setCommandOpen(false); return; }
      // Bare-letter nav, skip if typing in input
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key.toLowerCase() === 'd') setRoute('dashboard');
      else if (e.key.toLowerCase() === 'o') setRoute('orders');
      else if (e.key.toLowerCase() === 's') setRoute('signals');
      else if (e.key.toLowerCase() === 'r') setRoute('risk');
      else if (e.key.toLowerCase() === 'm') setRoute('model');
      else if (e.key.toLowerCase() === 'b') setRoute('backtest');
      else if (e.key.toLowerCase() === 'j') setRoute('journal');
      else if (e.key.toLowerCase() === 'a') setRoute('alerts');
      else if (e.key === ',') setRoute('settings');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-0)', color: 'var(--fg-0)' }}>
      <Sidebar route={route} onRoute={setRoute} />
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <TopBar
          mode={tweaks.mode}
          onMode={(m) => setTweakPatch({ mode: m })}
          onOpenCommand={() => setCommandOpen(true)}
          onOpenTweaks={() => setTweaksOpen(v => !v)}
          tweaksVisible={true}
          route={route}
        />
        <TickerTape />

        <div style={{ flex: 1, minWidth: 0 }}>
          {route === 'dashboard' && <Dashboard mode={tweaks.mode} layout={tweaks.layout} />}
          {route === 'orders'    && <OrdersPositions />}
          {route === 'signals'   && <SignalsPage />}
          {route === 'risk'      && <RiskPage />}
          {route === 'model'     && <ModelPage />}
          {route === 'backtest'  && <BacktestPage />}
          {route === 'journal'   && <JournalPage />}
          {route === 'alerts'    && <AlertsPage />}
          {route === 'settings'  && <SettingsPage />}
        </div>

        <footer style={{
          borderTop: '1px solid var(--line)', padding: '10px 20px',
          display: 'flex', gap: 20, alignItems: 'center', fontSize: 11, color: 'var(--fg-2)',
          background: 'var(--bg-1)', fontFamily: 'var(--f-mono)', letterSpacing: '0.04em',
        }}>
          <span><span className="dot" style={{ background: 'var(--up)', marginRight: 6 }}/>MD_STREAM · 43ms</span>
          <span><span className="dot" style={{ background: 'var(--up)', marginRight: 6 }}/>BROKER · 112ms</span>
          <span><span className="dot" style={{ background: 'var(--up)', marginRight: 6 }}/>META_MODEL · READY</span>
          <span style={{ marginLeft: 'auto' }}>PID 48291 · build 2.4.1-main-a9f3c · {new Date().getUTCFullYear()}</span>
        </footer>
      </main>

      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)}
        onRoute={setRoute} onMode={(m) => setTweakPatch({ mode: m })} />

      {tweaksOpen && <TweaksPanel tweaks={tweaks} onChange={setTweakPatch} onClose={() => setTweaksOpen(false)} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
