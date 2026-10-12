import { useEffect, useState } from 'react';
import { api } from '../api';
import { StatusBadge, Notice, CopyButton, timeAgo } from '../components/ui';

interface HostnameRow {
  id: string; hostname: string; projectId: string | null; projectName: string | null; mode: string;
  targetPort: number | null; publicHostname: string | null; httpsEnabled: boolean;
  resolutionStatus: string; reachabilityStatus: string; lastChecked: string | null;
  localUrl: string; actualLocalUrl: string | null;
}

export default function Hostnames() {
  const [rows, setRows] = useState<HostnameRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newHostname, setNewHostname] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const load = () => api<{ hostnames: HostnameRow[] }>('/api/hostnames').then((r) => setRows(r.hostnames)).catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const check = async (id: string) => {
    setBusy(id);
    try {
      await api(`/api/hostnames/${id}/check`, { method: 'POST', body: {} });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const rename = async (id: string) => {
    setBusy(id);
    try {
      await api(`/api/hostnames/${id}`, { method: 'PATCH', body: { hostname: editValue } });
      setEditId(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Remove this hostname mapping? The reverse-proxy route will be deleted.')) return;
    try {
      await api(`/api/hostnames/${id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const add = async () => {
    setError(null);
    setNotice(null);
    try {
      await api('/api/hostnames', { method: 'POST', body: { hostname: newHostname, mode: 'local' } });
      setNewHostname('');
      setNotice('Hostname created. It is registered in the LOCAL database only — not as a public domain.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="row-between mb">
        <div>
          <h2 style={{ margin: 0, fontSize: '1.35rem' }}>Domains & Hostnames</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Website names, hostname ↔ project mappings, DNS status and connectivity tests. Names under{' '}
            <code>*.localhost</code> resolve to this PC via the OS (RFC 6761) — <b>no DNS server or admin rights needed</b>,
            and they are <b>not</b> globally registered domains.
          </p>
        </div>
      </div>
      {error ? <Notice kind="danger">{error}</Notice> : null}
      {notice ? <Notice kind="info">{notice}</Notice> : null}

      <div className="card mb">
        <h3>Add hostname</h3>
        <div className="row">
          <input className="input" style={{ maxWidth: 320 }} value={newHostname} onChange={(e) => setNewHostname(e.target.value)} placeholder="my-app.localhost" />
          <button className="btn btn-primary" disabled={!newHostname.trim()} onClick={add}>Create hostname</button>
        </div>
        <div className="hint">Custom local names (e.g. myapp.home.arpa) need the optional DNS module and manual resolver configuration on each client.</div>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Hostname</th><th>Project</th><th>Mode</th><th>Destination</th>
              <th>Resolution</th><th>Reachability</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.id}>
                <td>
                  {editId === h.id ? (
                    <div className="row">
                      <input className="input" style={{ maxWidth: 200 }} value={editValue} onChange={(e) => setEditValue(e.target.value)} />
                      <button className="btn btn-sm btn-primary" disabled={busy === h.id} onClick={() => rename(h.id)}>Save</button>
                      <button className="btn btn-sm" onClick={() => setEditId(null)}>Cancel</button>
                    </div>
                  ) : (
                    <>
                      <code>{h.hostname}</code>
                      {h.publicHostname ? <div className="stat-sub">public name: {h.publicHostname}</div> : null}
                    </>
                  )}
                </td>
                <td>{h.projectName ?? <span className="muted">unassigned</span>}</td>
                <td><span className={`badge ${h.mode === 'public' ? 'badge-violet' : h.mode === 'lan' ? 'badge-amber' : 'badge-blue'}`}>{h.mode}</span></td>
                <td>
                  {h.actualLocalUrl ? <code style={{ fontSize: '0.78rem' }}>{h.actualLocalUrl}</code> : <span className="muted">not deployed</span>}
                  <div className="row" style={{ gap: 0, marginTop: '0.25rem' }}>
                    <a href={h.localUrl} target="_blank" rel="noreferrer" className="btn btn-sm">open</a>
                    <CopyButton text={h.localUrl} />
                  </div>
                </td>
                <td>
                  <StatusBadge status={h.resolutionStatus} />
                  <div className="stat-sub">checked {h.lastChecked ? timeAgo(h.lastChecked) : 'never'}</div>
                </td>
                <td>
                  <StatusBadge status={h.reachabilityStatus} />
                  {h.reachabilityStatus === 'reachable_external' ? (
                    <div className="stat-sub" style={{ color: 'var(--green)' }}>externally verified</div>
                  ) : (
                    <div className="stat-sub">no public claim without external verification</div>
                  )}
                </td>
                <td>
                  <div className="row" style={{ gap: '0.35rem' }}>
                    <button className="btn btn-sm" disabled={busy === h.id} onClick={() => check(h.id)}>
                      {busy === h.id ? 'Checking…' : 'Test'}
                    </button>
                    <button className="btn btn-sm" onClick={() => { setEditId(h.id); setEditValue(h.hostname); }}>Rename</button>
                    <button className="btn btn-sm btn-danger" onClick={() => remove(h.id)}>Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <div className="empty">
            <h3>No hostnames registered</h3>
            <p>Create a project — its website name automatically becomes <code>name.localhost</code>.</p>
          </div>
        ) : null}
      </div>

      <Notice kind="info">
        <b>Status legend.</b> “Resolvable locally” means this PC (or a client using the PortPilot DNS resolver) can resolve the
        name. “Reachable externally” is only ever shown after a real external HTTP check succeeds — a local DNS lookup is{' '}
        <b>never</b> treated as proof of public availability.
      </Notice>
    </div>
  );
}
