import { useEffect, useState } from 'react';
import { api } from '../api';
import { Notice, StatusBadge } from '../components/ui';

interface Health {
  ok: boolean; time: string; api: string; proxy: string; dns: string; queue: string; node: string; pid: number;
}
interface RootDomain {
  rootDomain: string | null; configured: boolean;
}

export default function Settings() {
  const [health, setHealth] = useState<Health | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [rootDomain, setRootDomain] = useState<RootDomain>({ rootDomain: null, configured: false });
  const [rootInput, setRootInput] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);

  const load = () => {
    api<Health>('/api/system/health').then(setHealth).catch(() => undefined);
    api<{ settings: Record<string, string>; config: Record<string, unknown> }>('/api/settings').then((r) => {
      setSettings(r.settings);
      setConfig(r.config);
    }).catch(() => undefined);
    api<RootDomain>('/api/public-access/root-domain').then(setRootDomain).catch(() => undefined);
    api<{ lines: string[] }>('/api/system/logs?name=api').then((r) => setLogLines(r.lines.slice(-60))).catch(() => undefined);
  };

  const saveRootDomain = async () => {
    const val = rootInput.trim() || null;
    try {
      const res = await api<RootDomain>('/api/public-access/root-domain', {
        method: 'PATCH',
        body: { rootDomain: val },
      });
      setRootDomain(res);
      setRootInput(res.rootDomain ?? '');
      setNotice(res.configured
        ? `Root domain set to ${res.rootDomain}. New projects will be auto-registered as <websiteName>.${res.rootDomain}.`
        : 'Root domain cleared.');
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Failed to save root domain.');
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  const addSetting = async () => {
    if (!newKey.trim()) return;
    await api('/api/settings', { method: 'PATCH', body: { [newKey]: newVal } });
    setNewKey('');
    setNewVal('');
    setNotice('Setting saved.');
    load();
  };

  return (
    <div>
      <div className="row-between mb">
        <div>
          <h2 style={{ margin: 0, fontSize: '1.35rem' }}>System Settings</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>Service status, configuration metadata and diagnostics.</p>
        </div>
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      {notice ? <Notice kind="info">{notice}</Notice> : null}

      <div className="grid grid-4 mb">
        <div className="card">
          <div className="stat-label">API</div>
          <div style={{ marginTop: '0.5rem' }}><StatusBadge status={health?.api === 'online' ? 'online' : 'offline'} /></div>
          <div className="stat-sub">pid {health?.pid} · node {health?.node}</div>
        </div>
        <div className="card">
          <div className="stat-label">Reverse proxy</div>
          <div style={{ marginTop: '0.5rem' }}><StatusBadge status={health?.proxy === 'running' ? 'succeeded' : 'stopped'} label={health?.proxy ?? '…'} /></div>
          <div className="stat-sub">port {config ? String(config.proxyPort) : '—'}</div>
        </div>
        <div className="card">
          <div className="stat-label">DNS</div>
          <div style={{ marginTop: '0.5rem' }}><StatusBadge status={health?.dns === 'running' ? 'succeeded' : 'disabled'} label={health?.dns ?? '…'} /></div>
          <div className="stat-sub">zone {config ? String(config.dnsZone) : '—'}</div>
        </div>
        <div className="card">
          <div className="stat-label">Build queue</div>
          <div style={{ marginTop: '0.5rem' }}><StatusBadge status={health?.queue === 'busy' ? 'running' : 'stopped'} label={health?.queue ?? '…'} /></div>
          <div className="stat-sub">deployment worker</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>Configuration</h3>
          <dl className="kv">
            <dt>Bind address</dt><dd className="mono">{config ? String(config.host) : '—'}:{config ? String(config.port) : '—'}</dd>
            <dt>Loopback only</dt><dd>{config && config.isLoopback ? 'yes (recommended)' : 'no — LAN exposure: ensure PORTPILOT_AUTH_TOKEN is set'}</dd>
            <dt>DNS enabled</dt><dd>{config && config.dnsEnabled ? `yes (${String(config.dnsPort)})` : 'no (optional)'}</dd>
            <dt>Node.js</dt><dd className="mono">{config ? String(config.node) : '—'}</dd>
          </dl>
          <Notice kind="info">
            Runtime configuration lives in <code>.env</code> (see <code>.env.example</code>). Values here are metadata
            stored in SQLite. The full access token is never sent to the browser.
          </Notice>
        </div>

        <div className="card mt">
          <h3>Automated public subdomains (root domain)</h3>
          <p className="muted" style={{ marginBottom: '0.6rem' }}>
            Set a domain you own (e.g. <code>portpilot.com</code>) once. Every new project is then automatically
            registered as <code>anatainfratech.portpilot.com</code> with mode <b>public</b> and routed by the reverse
            proxy — no manual hostname entry per project.
          </p>
          <div className="row mb">
            <input
              className="input"
              style={{ maxWidth: 340 }}
              value={rootInput}
              onChange={(e) => setRootInput(e.target.value)}
              placeholder="portpilot.com"
            />
            <button className="btn btn-primary btn-sm" onClick={saveRootDomain}>
              {rootDomain.configured ? 'Update root domain' : 'Set root domain'}
            </button>
            {rootDomain.configured ? (
              <button className="btn btn-sm" onClick={saveRootDomain} style={{ marginLeft: '0.4rem' }}>
                clear
              </button>
            ) : null}
          </div>
          {rootDomain.configured ? (
            <div className="notice notice-info">
              <div style={{ fontWeight: 600 }}>Active root domain: <code>{rootDomain.rootDomain}</code></div>
              <div className="stat-sub">
                New project <code>anatainfratech</code> &rarr; <code>anatainfratech.{rootDomain.rootDomain}</code>
              </div>
              <div className="stat-sub mt">
                Still required: add an A record (or wildcard <code>*.{rootDomain.rootDomain}</code>) at your registrar
                pointing at this PC&rsquo;s public IP, and expose the proxy (port forward 80/443 or a tunnel).
              </div>
            </div>
          ) : (
            <div className="notice notice-warn">
              No root domain configured. Projects use only local <code>*.localhost</code> hostnames until you set one.
            </div>
          )}
        </div>

        <div className="card">
          <h3>Key-value settings</h3>
          <div className="row mb">
            <input className="input" style={{ maxWidth: 180 }} value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="key" />
            <input className="input" style={{ maxWidth: 220 }} value={newVal} onChange={(e) => setNewVal(e.target.value)} placeholder="value" />
            <button className="btn btn-sm btn-primary" onClick={addSetting}>Save</button>
          </div>
          <table className="data">
            <thead><tr><th>Key</th><th>Value</th></tr></thead>
            <tbody>
              {Object.entries(settings).map(([k, v]) => (
                <tr key={k}><td className="mono">{k}</td><td className="mono" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card mt">
        <h3>Recent API log</h3>
        <div className="log-viewer" style={{ maxHeight: 300 }}>
          {logLines.length ? logLines.map((l, i) => <div key={i} className="log-line-stdout">{l}</div>) : <span className="muted">No log entries.</span>}
        </div>
      </div>
    </div>
  );
}
