import { useEffect, useState } from 'react';
import { api } from '../api';
import { Notice, CopyButton } from '../components/ui';

export default function Github() {
  const [status, setStatus] = useState<{ configured: boolean; source: string } | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [webhookInfo, setWebhookInfo] = useState<string[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string; websiteName: string }[]>([]);

  const load = () => {
    api<{ configured: boolean; source: string }>('/api/github/token-status').then(setStatus).catch(() => undefined);
    api<{ note: string[] }>('/api/webhooks/info').then((r) => setWebhookInfo(r.note)).catch(() => undefined);
    api<{ projects: { id: string; name: string; websiteName: string }[] }>('/api/projects').then((r) => setProjects(r.projects)).catch(() => undefined);
  };

  useEffect(() => {
    load();
  }, []);

  const saveToken = async () => {
    setError(null);
    setNotice(null);
    try {
      await api('/api/github/token', { method: 'POST', body: { token } });
      setToken('');
      setNotice('GitHub token stored — encrypted at rest. It is never printed in logs or returned by the API.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeToken = async () => {
    await api('/api/github/token', { method: 'DELETE' });
    setNotice('GitHub token removed.');
    load();
  };

  return (
    <div>
      <div className="row-between mb">
        <div>
          <h2 style={{ margin: 0, fontSize: '1.35rem' }}>GitHub Integration</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Optional secure authentication for private repositories, plus webhook-based auto-redeploys.
            Public repositories work without any token or account connection.
          </p>
        </div>
      </div>
      {error ? <Notice kind="danger">{error}</Notice> : null}
      {notice ? <Notice kind="info">{notice}</Notice> : null}

      <div className="grid grid-2">
        <div className="card">
          <h3>Access token (optional)</h3>
          <p className="muted">
            Use a <b>fine-grained PAT with least privilege</b> (Contents: Read on the target repositories) or a GitHub App
            installation token. PortPilot never asks for your GitHub password. The token is passed to git via a temporary
            askpass helper — never embedded in remote URLs or logs.
          </p>
          <div className="row mb">
            <span className={`badge ${status?.configured ? 'badge-green' : 'badge-gray'}`}>
              {status?.configured ? `token configured (${status.source})` : 'no token configured'}
            </span>
            {status?.configured ? <button className="btn btn-sm btn-danger" onClick={removeToken}>Remove token</button> : null}
          </div>
          <div className="field">
            <label>GitHub token</label>
            <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_... or ghp_..." />
            <div className="hint">You can also set PORTPILOT_GITHUB_TOKEN in .env instead of storing it in the database.</div>
          </div>
          <button className="btn btn-primary" disabled={token.trim().length < 8} onClick={saveToken}>Store token (encrypted)</button>
        </div>

        <div className="card">
          <h3>Webhooks (auto-redeploy on push)</h3>
          <ul className="check-list">
            {webhookInfo.map((n, i) => <li key={i}>• {n}</li>)}
          </ul>
          <div className="mt">
            <div className="stat-label">Per-project webhook URL</div>
            {projects.length === 0 ? (
              <p className="muted">Create a project first — each project gets its own webhook URL and HMAC secret.</p>
            ) : (
              projects.map((p) => {
                const url = `${window.location.origin}/api/webhooks/github/${p.id}`;
                return (
                  <div key={p.id} className="row-between" style={{ marginTop: '0.55rem' }}>
                    <code style={{ fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 380 }}>{url}</code>
                    <CopyButton text={url} />
                  </div>
                );
              })
            )}
          </div>
          <Notice kind="info">
            Webhook payloads are validated with <code>X-Hub-Signature-256</code> (HMAC-SHA256). Configure the same secret
            in the GitHub repository webhook settings. If GitHub cannot reach this PC (CGNAT), use “Pull &amp; Redeploy”
            on the Projects page instead.
          </Notice>
        </div>
      </div>
    </div>
  );
}
