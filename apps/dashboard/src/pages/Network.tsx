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

interface DomainCheck {
  domain: string;
  verdict: 'works' | 'reachable_not_ours' | 'name_only' | 'not_reachable' | 'not_configured';
  resolvedAddresses: string[];
  cnameTarget: string | null;
  links: {
    name: { state: string; detail: string };
    target: { state: string; detail: string };
    port: { state: string; detail: string };
    app: { state: string; detail: string };
  };
  possibleHairpinFalseNegative: boolean;
  nextSteps: string[];
}
interface DnsRecord {
  name: string; type: string; address: string; ttl: number; hint: string;
}
interface DnsGuidance {
  rootDomain: string | null; publicIp: string | null; records: DnsRecord[]; note: string;
}

const VERDICT_LABEL: Record<DomainCheck['verdict'], { text: string; kind: 'info' | 'warn' | 'danger' }> = {
  works: { text: 'Working end to end', kind: 'info' },
  reachable_not_ours: { text: 'Reachable, but not served by PortPilot', kind: 'warn' },
  name_only: { text: 'Name resolves, nothing answers', kind: 'warn' },
  not_reachable: { text: 'Name resolves, nothing answers', kind: 'warn' },
  not_configured: { text: 'No DNS record found', kind: 'danger' },
};

export default function Network() {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [overall, setOverall] = useState<string>('unknown');
  const [honesty, setHonesty] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relayEndpoint, setRelayEndpoint] = useState('');
  const [relayMsg, setRelayMsg] = useState<string | null>(null);
  const [domain, setDomain] = useState('');
  const [domainCheck, setDomainCheck] = useState<DomainCheck | null>(null);
  const [domainBusy, setDomainBusy] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [dnsGuidance, setDnsGuidance] = useState<DnsGuidance | null>(null);
  const [verifyAllResults, setVerifyAllResults] = useState<Array<{ hostname: string; projectId: string | null; verdict: string }> | null>(null);
  const [verifyAllBusy, setVerifyAllBusy] = useState(false);

  const verifyDomain = async () => {
    setDomainBusy(true);
    setDomainError(null);
    setDomainCheck(null);
    try {
      const res = await api<DomainCheck>('/api/public-access/verify', { method: 'POST', body: { domain } });
      setDomainCheck(res);
    } catch (e) {
      setDomainError(e instanceof Error ? e.message : String(e));
    } finally {
      setDomainBusy(false);
    }
  };

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const [d, p, g] = await Promise.all([
        api<{ diagnostics: Diagnostics }>('/api/network/diagnostics'),
        api<{ overall: string; strategies: Strategy[]; honesty: string[] }>('/api/public-access/status'),
        api<DnsGuidance>('/api/public-access/dns-guidance'),
      ]);
      setDiag(d.diagnostics);
      setStrategies(p.strategies);
      setOverall(p.overall);
      setHonesty(p.honesty);
      setDnsGuidance(g);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const verifyAll = async () => {
    setVerifyAllBusy(true);
    setVerifyAllResults(null);
    try {
      const res = await api<{ rootDomain: string | null; results: Array<{ hostname: string; projectId: string | null; verdict: string }> }>('/api/public-access/verify-all', { method: 'POST', body: {} });
      setVerifyAllResults(res.results);
    } catch (e) {
      setDomainError(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifyAllBusy(false);
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

      <div className="card mt">
        <h3>Verify a public domain</h3>
        <p className="muted">
          Bought or pointed a domain at this PC? Check the whole chain: name → target → port → app.
          A DNS lookup alone does not prove the site works.
        </p>
        <div className="row mb">
          <input
            className="input"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="app.yourdomain.com"
          />
          <button className="btn btn-primary" disabled={domainBusy || domain.trim().length < 3} onClick={verifyDomain}>
            {domainBusy ? 'Checking…' : 'Verify'}
          </button>
        </div>
        {domainError ? <Notice kind="danger">{domainError}</Notice> : null}
        {domainCheck ? (
          <div className="mt">
            <Notice kind={VERDICT_LABEL[domainCheck.verdict].kind}>
              <b>{VERDICT_LABEL[domainCheck.verdict].text}</b> — {domainCheck.domain}
            </Notice>
            <ul className="check-list">
              <li>{domainCheck.links.name.state === 'ok' ? '✓' : '✗'} <b>Name:</b> {domainCheck.links.name.detail}</li>
              <li>{domainCheck.links.target.state === 'ok' ? '✓' : '•'} <b>Target:</b> {domainCheck.links.target.detail}</li>
              <li>{domainCheck.links.port.state === 'ok' ? '✓' : '✗'} <b>Port:</b> {domainCheck.links.port.detail}</li>
              <li>{domainCheck.links.app.state === 'ok' ? '✓' : '✗'} <b>App:</b> {domainCheck.links.app.detail}</li>
            </ul>
            {domainCheck.possibleHairpinFalseNegative ? (
              <div className="notice notice-warn">
                This PC cannot reach its own public IP (NAT hairpin). It may still work from outside — test from a phone on mobile data.
              </div>
            ) : null}
            <ul className="check-list mt">
              {domainCheck.nextSteps.map((s, i) => <li key={i}>→ {s}</li>)}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="card mt">
        <h3>Automated public subdomains</h3>
        <p className="muted">
          When a root domain is configured (Settings), every project is auto-registered as
          <code>anatainfratech.{dnsGuidance?.rootDomain ?? ''}</code> and routed by the reverse proxy. Add the DNS A records
          below at your registrar, then verify.
        </p>
        {dnsGuidance?.rootDomain ? (
          <>
            <div className="row mb">
              <button
                className="btn btn-primary"
                disabled={verifyAllBusy || !dnsGuidance.publicIp}
                onClick={verifyAll}
              >
                {verifyAllBusy ? 'Verifying all…' : 'Auto-verify all public hostnames'}
              </button>
              <span className="stat-sub" style={{ marginLeft: '0.75rem' }}>
                Root domain: <code>{dnsGuidance.rootDomain}</code> · public IP: {dnsGuidance.publicIp ?? 'not detected'}
              </span>
            </div>
            <div className="table-wrap mb">
              <table className="data">
                <thead>
                  <tr>
                    <th>Record</th><th>Type</th><th>Points to</th><th>TTL</th><th>Purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {(dnsGuidance.records ?? []).map((r, i) => (
                    <tr key={i}>
                      <td className="mono">{r.name}</td>
                      <td>{r.type}</td>
                      <td className="mono">{r.address}</td>
                      <td>{r.ttl}</td>
                      <td>{r.hint}</td>
                    </tr>
                  ))}
                  {(dnsGuidance.records ?? []).length === 0 && (
                    <tr><td colSpan={5} className="muted">No public hostnames yet. Create a project to auto-generate one.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="stat-sub">{dnsGuidance.note}</div>
            {verifyAllResults ? (
              <div className="mt">
                <div className="stat-label">Verification results</div>
                {(verifyAllResults ?? []).map((r, i) => (
                  <div key={i} className="row" style={{ gap: '1rem' }}>
                    <span className="mono">{r.hostname}</span>
                    <span>{r.projectId ?? '—'}</span>
                    <StatusBadge
                      status={r.verdict === 'works' ? 'succeeded' : r.verdict === 'reachable_not_ours' || r.verdict === 'name_only' ? 'unlikely' : 'failed'}
                      label={r.verdict}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="notice notice-warn">
            No root domain configured. Go to Settings to set one (e.g. <code>portpilot.com</code>), then new projects
            get automatic public subdomains.
          </div>
        )}
      </div>

      <Notice kind="warn">
        <ul className="check-list">
          {honesty.map((h, i) => <li key={i}>• {h}</li>)}
        </ul>
      </Notice>
    </div>
  );
}
