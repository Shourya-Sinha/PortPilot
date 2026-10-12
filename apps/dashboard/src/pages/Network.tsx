import { useEffect, useState } from 'react';
import { api } from '../api';
import { Notice, StatusBadge, timeAgo, StatCard } from '../components/ui';

interface Diagnostics {
  localAddresses: { name: string; address: string; family: string }[];
  defaultGateway: string | null; internetConnectivity: string; publicIp: string | null;
  routerWanIp: string | null; behindNat: boolean | null; cgnatSuspected: boolean | null;
  cgnatConfidence: string; inboundPossible: string;
  listeningPorts: { port: number; label: string }[];
  portForwardingConfigured: boolean | null; publicHostnameConfigured: boolean;
  notes: string[]; checkedAt: string;
}

interface Strategy {
  id: string; name: string; description: string; viable: boolean; reason: string; guidance: string[];
}

export default function Network() {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [overall, setOverall] = useState<string>('unknown');
  const [honesty, setHonesty] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relayEndpoint, setRelayEndpoint] = useState('');
  const [relayMsg, setRelayMsg] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const [d, p] = await Promise.all([
        api<{ diagnostics: Diagnostics }>('/api/network/diagnostics'),
        api<{ overall: string; strategies: Strategy[]; honesty: string[] }>('/api/public-access/status'),
      ]);
      setDiag(d.diagnostics);
      setStrategies(p.strategies);
      setOverall(p.overall);
      setHonesty(p.honesty);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const saveRelay = async () => {
    setRelayMsg(null);
    try {
      const res = await api<{ ok: boolean; message: string }>('/api/public-access/relay/configure', {
        method: 'POST',
        body: { endpoint: relayEndpoint },
      });
      setRelayMsg(res.message);
    } catch (e) {
      setRelayMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="row-between mb">
        <div>
          <h2 style={{ margin: 0, fontSize: '1.35rem' }}>Network & Public Access</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Honest diagnostics: local availability vs. public availability are reported separately, and nothing is
            claimed as public without external verification.
          </p>
        </div>
        <button className="btn btn-primary" disabled={busy} onClick={load}>{busy ? 'Running diagnostics…' : 'Run diagnostics'}</button>
      </div>

      {error ? <Notice kind="danger">{error}</Notice> : null}

      <div className="grid grid-4 mb">
        <StatCard label="Internet" value={diag?.internetConnectivity ?? '…'} tone={diag?.internetConnectivity === 'online' ? 'green' : 'red'} sub="outbound connectivity check" />
        <StatCard label="Public IP (observed)" value={diag?.publicIp ?? 'unknown'} sub={diag?.publicIp ? 'from an external echo service' : 'could not be verified'} />
        <StatCard label="CGNAT assessment" value={diag?.cgnatConfidence ?? '…'} tone={diag?.cgnatConfidence === 'likely' ? 'amber' : 'default'} sub={diag?.cgnatConfidence === 'inconclusive' ? 'router WAN IP unavailable — NOT conclusive' : `WAN IP: ${diag?.routerWanIp ?? 'unknown'}`} />
        <StatCard label="Public access mode" value={overall.replace(/_/g, ' ')} sub="local deployments work regardless" />
      </div>

      <div className="grid grid-2 mb">
        <div className="card">
          <h3>Machine & routes</h3>
          <dl className="kv">
            <dt>Local addresses</dt>
            <dd>
              {diag?.localAddresses.length ? diag.localAddresses.map((a) => (
                <div key={a.address} className="mono">{a.name}: {a.address} ({a.family})</div>
              )) : '—'}
            </dd>
            <dt>Default gateway</dt><dd className="mono">{diag?.defaultGateway ?? 'not detected'}</dd>
            <dt>Router WAN IP</dt><dd className="mono">{diag?.routerWanIp ?? 'not obtainable (UPnP often disabled)'}</dd>
            <dt>Behind NAT</dt><dd>{diag?.behindNat == null ? 'unknown' : diag.behindNat ? 'yes' : 'no'}</dd>
            <dt>Inbound possible</dt><dd><StatusBadge status={diag?.inboundPossible ?? 'unknown'} /></dd>
            <dt>Port forwarding</dt><dd>{diag?.portForwardingConfigured == null ? 'not verified — test from an external network' : diag.portForwardingConfigured ? 'reported configured' : 'not configured'}</dd>
            <dt>Public hostname</dt><dd>{diag?.publicHostnameConfigured ? 'configured (still needs external verification)' : 'none configured'}</dd>
          </dl>
          {diag?.listeningPorts.length ? (
            <div className="mt">
              <div className="stat-label">Occupied platform ports</div>
              {diag.listeningPorts.map((p) => <div key={p.port} className="mono stat-sub">{p.label}: {p.port}</div>)}
            </div>
          ) : null}
          <div className="stat-sub mt">Last checked: {diag ? timeAgo(diag.checkedAt) : 'never'}</div>
        </div>

        <div className="card">
          <h3>What the numbers mean</h3>
          <ul className="check-list">
            {(diag?.notes ?? ['Run diagnostics to see network notes.']).map((n, i) => (
              <li key={i}><span className="dot dot-warn" style={{ marginTop: '0.45rem' }} /><span>{n}</span></li>
            ))}
          </ul>
          <Notice kind="info">
            <b>Local vs public.</b> A working <code>*.localhost</code> URL proves local availability only. Public
            availability requires an external client to complete an HTTP request to your public IP/hostname — the
            dashboard shows a public URL only after that check succeeds.
          </Notice>
        </div>
      </div>

      <h3 style={{ marginTop: '1.6rem' }}>Public access strategies</h3>
      <div className="grid grid-2">
        {strategies.map((s) => (
          <div className="card" key={s.id}>
            <div className="row-between">
              <h3 style={{ margin: 0 }}>{s.name}</h3>
              <StatusBadge status={s.viable ? 'succeeded' : 'unlikely'} label={s.viable ? 'viable now' : 'not currently viable'} />
            </div>
            <p className="muted">{s.description}</p>
            <div className={`notice ${s.viable ? 'notice-info' : 'notice-warn'}`}>{s.reason}</div>
            <ul className="check-list">
              {s.guidance.map((g, i) => <li key={i}><span>{g}</span></li>)}
            </ul>
            {s.id === 'relay' ? (
              <div className="mt">
                <div className="field">
                  <label>Relay endpoint (your own public relay — optional)</label>
                  <div className="row">
                    <input className="input" value={relayEndpoint} onChange={(e) => setRelayEndpoint(e.target.value)} placeholder="https://relay.example.net" />
                    <button className="btn btn-sm" onClick={saveRelay}>Save</button>
                  </div>
                </div>
                {relayMsg ? <div className="stat-sub">{relayMsg}</div> : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <Notice kind="warn">
        <ul className="check-list">
          {honesty.map((h, i) => <li key={i}>• {h}</li>)}
        </ul>
      </Notice>
    </div>
  );
}
