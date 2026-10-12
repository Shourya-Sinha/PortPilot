import { useEffect, useState } from 'react';
import { api } from '../api';
import { Notice, StatusBadge, timeAgo } from '../components/ui';

interface DnsStatus {
  enabled: boolean; running: boolean; port: number; host: string; zone: string; ttl: number;
  records: { name: string; address: string; ttl: number }[];
  recentQueries: { ts: string; name: string; type: string; client: string; rcode: number }[];
  disclaimer: string[];
}

export default function DnsSettings() {
  const [status, setStatus] = useState<DnsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recName, setRecName] = useState('');
  const [recAddr, setRecAddr] = useState('127.0.0.1');
  const [lookupName, setLookupName] = useState('');
  const [lookupResult, setLookupResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<DnsStatus>('/api/dns/status').then(setStatus).catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ ok: boolean; port?: number; error?: string }>('/api/dns/start', { method: 'POST', body: {} });
      if (res.ok) setNotice(`DNS server started on ${status?.host ?? '127.0.0.1'}:${res.port}. Only clients configured to use this resolver will see these names.`);
      else setError(res.error ?? 'Failed to start');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await api('/api/dns/stop', { method: 'POST', body: {} });
      setNotice('DNS server stopped.');
      load();
    } finally {
      setBusy(false);
    }
  };

  const addRecord = async () => {
    setError(null);
    try {
      await api('/api/dns/records', { method: 'POST', body: { name: recName, address: recAddr } });
      setRecName('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const lookup = async () => {
    setLookupResult('querying…');
    try {
      const res = await api<{ ok: boolean; address: string | null; error?: string; via: string }>(`/api/dns/lookup`, { method: 'POST', body: { name: lookupName } });
      setLookupResult(res.ok ? `${lookupName} → ${res.address} (via ${res.via})` : `lookup failed: ${res.error ?? 'unknown'} (via ${res.via})`);
    } catch (e) {
      setLookupResult(String(e));
    }
  };

  return (
    <div>
      <div className="row-between mb">
        <div>
          <h2 style={{ margin: 0, fontSize: '1.35rem' }}>DNS Settings</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Optional local DNS zone — an educational, functional module. <b>Off by default</b>; local hostnames work without it.
          </p>
        </div>
        {status?.running ? (
          <button className="btn btn-danger" disabled={busy} onClick={stop}>Stop DNS server</button>
        ) : (
          <button className="btn btn-primary" disabled={busy || !status?.enabled} onClick={start}>Start DNS server</button>
        )}
      </div>

      {error ? <Notice kind="danger">{error}</Notice> : null}
      {notice ? <Notice kind="info">{notice}</Notice> : null}
      {status && !status.enabled ? (
        <Notice kind="warn">
          The DNS module is disabled. Set <code>DNS_ENABLED=true</code> in <code>.env</code> and restart PortPilot to enable it.
        </Notice>
      ) : null}

      <div className="grid grid-3 mb">
        <div className="card">
          <div className="stat-label">Status</div>
          <div style={{ marginTop: '0.5rem' }}>
            <StatusBadge status={status?.running ? 'succeeded' : 'stopped'} label={status?.running ? 'running' : 'stopped'} />
          </div>
          <div className="stat-sub">listener {status?.host}:{status?.port}</div>
        </div>
        <div className="card">
          <div className="stat-label">Zone</div>
          <div className="stat-value" style={{ fontSize: '1.15rem' }}><code>{status?.zone ?? '—'}</code></div>
          <div className="stat-sub">default TTL {status?.ttl}s</div>
        </div>
        <div className="card">
          <div className="stat-label">Test lookup</div>
          <div className="row" style={{ marginTop: '0.45rem' }}>
            <input className="input" value={lookupName} onChange={(e) => setLookupName(e.target.value)} placeholder={`app.${status?.zone ?? 'zone'}`} />
            <button className="btn btn-sm" onClick={lookup}>dig</button>
          </div>
          {lookupResult ? <div className="stat-sub mono">{lookupResult}</div> : null}
        </div>
      </div>

      <Notice kind="warn">
        <ul className="check-list">
          {(status?.disclaimer ?? []).map((d, i) => <li key={i}>• {d}</li>)}
        </ul>
      </Notice>

      <div className="grid grid-2">
        <div className="card">
          <h3>Zone records</h3>
          <div className="row mb">
            <input className="input" value={recName} onChange={(e) => setRecName(e.target.value)} placeholder={`name.${status?.zone ?? ''}`} />
            <input className="input" style={{ maxWidth: 150 }} value={recAddr} onChange={(e) => setRecAddr(e.target.value)} placeholder="127.0.0.1" />
            <button className="btn btn-primary btn-sm" disabled={!recName} onClick={addRecord}>Add A record</button>
          </div>
          <table className="data">
            <thead><tr><th>Name</th><th>Address</th><th>TTL</th><th></th></tr></thead>
            <tbody>
              {(status?.records ?? []).map((r) => (
                <tr key={r.name}>
                  <td><code>{r.name}</code></td>
                  <td className="mono">{r.address}</td>
                  <td>{r.ttl}</td>
                  <td>
                    <button className="btn btn-sm btn-danger" onClick={async () => {
                      await api(`/api/dns/records/${encodeURIComponent(r.name)}`, { method: 'DELETE' });
                      load();
                    }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(status?.records ?? []).length === 0 ? <p className="muted">No records. Registered hostnames are added when the server starts.</p> : null}
        </div>

        <div className="card">
          <h3>Recent queries</h3>
          <table className="data">
            <thead><tr><th>Time</th><th>Query</th><th>Client</th><th>Rcode</th></tr></thead>
            <tbody>
              {(status?.recentQueries ?? []).slice(0, 15).map((q, i) => (
                <tr key={i}>
                  <td>{timeAgo(q.ts)}</td>
                  <td className="mono" style={{ fontSize: '0.78rem' }}>{q.type} {q.name}</td>
                  <td className="mono" style={{ fontSize: '0.75rem' }}>{q.client}</td>
                  <td>{q.rcode === 0 ? <span className="badge badge-green">NOERROR</span> : q.rcode === 3 ? <span className="badge badge-amber">NXDOMAIN</span> : <span className="badge badge-gray">rcode {q.rcode}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(status?.recentQueries ?? []).length === 0 ? <p className="muted">No queries yet. This server refuses recursion and out-of-zone queries.</p> : null}
        </div>
      </div>

      <div className="card mt">
        <h3>Windows configuration (optional)</h3>
        <p className="muted">
          Point a client at this resolver only if you need names outside <code>*.localhost</code>. Windows Settings → Network
          &amp; Internet → your adapter → Edit DNS → Manual → <code>127.0.0.1</code> (port must be 53, which requires running
          PortPilot elevated, or use a port-forwarding shim). PortPilot will <b>never</b> change these settings for you.
        </p>
        <p className="muted">
          Test from PowerShell: <code>Resolve-DnsName -Name app.{status?.zone ?? 'zone'} -Server 127.0.0.1 -DnsOnly</code> or{' '}
          <code>nslookup app.{status?.zone ?? 'zone'} 127.0.0.1:{status?.port ?? 5353}</code> (nslookup needs the standard port).
        </p>
      </div>
    </div>
  );
}
