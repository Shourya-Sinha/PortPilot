import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, subscribeSse } from '../api';
import { StatusBadge, timeAgo, CopyButton, Notice } from '../components/ui';

interface ProjectRow {
  id: string; name: string; websiteName: string; repoUrl: string; branch: string; framework: string;
  deploymentMode: string; createdAt: string; activeDeploymentId: string | null; publicHostname: string | null;
  runtime: { status: string; pid: number | null; port: number | null } | null;
}

export default function Projects() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [proxyPort, setProxyPort] = useState(8080);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api<{ projects: ProjectRow[] }>('/api/projects').then((r) => setProjects(r.projects)).catch((e) => setError(e.message));
    api<{ config: { proxyPort: number } }>('/api/settings').then((r) => setProxyPort(r.config.proxyPort)).catch(() => undefined);
  };

  useEffect(() => {
    load();
    const unsub = subscribeSse('/api/events', { 'runtime:status': load, 'deployment:status': load });
    return unsub;
  }, []);

  const act = async (id: string, action: 'start' | 'stop' | 'restart' | 'redeploy') => {
    setBusy(id + action);
    setError(null);
    try {
      await api(`/api/projects/${id}/${action}`, { method: 'POST', body: {} });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p: ProjectRow) => {
    const confirmName = window.prompt(
      `Delete project "${p.name}" and its deployments?\n\nType the website name "${p.websiteName}" to confirm:`,
    );
    if (confirmName === null) return;
    try {
      await api(`/api/projects/${p.id}`, { method: 'DELETE', body: { confirm: confirmName } });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="row-between mb">
        <div>
          <h2 style={{ margin: 0, fontSize: '1.35rem' }}>Projects</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>Every project gets a website name and a local hostname automatically.</p>
        </div>
        <Link className="btn btn-primary" to="/create">+ Create project</Link>
      </div>

      {error ? <Notice kind="danger">{error}</Notice> : null}

      {projects.length === 0 ? (
        <div className="card empty">
          <h3>No projects yet</h3>
          <p>Create a project from a GitHub repository URL — no account connection required for public repos.</p>
          <Link className="btn btn-primary" to="/create">Create your first project</Link>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Project</th><th>Website / Local URL</th><th>Repository</th><th>Runtime</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const localUrl = `http://${p.websiteName}.localhost${proxyPort === 80 ? '' : `:${proxyPort}`}`;
                const rtStatus = p.runtime?.status ?? 'stopped';
                return (
                  <tr key={p.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{p.name}</div>
                      <div className="stat-sub">{p.framework} · {p.deploymentMode} · created {timeAgo(p.createdAt)}</div>
                    </td>
                    <td>
                      <div><code>{p.websiteName}.localhost</code></div>
                      <div className="row" style={{ gap: '0.45rem', marginTop: '0.3rem' }}>
                        <a href={localUrl} target="_blank" rel="noreferrer" className="btn btn-sm">{localUrl}</a>
                        <CopyButton text={localUrl} />
                      </div>
                      {p.publicHostname ? <div className="stat-sub">public name: {p.publicHostname} (verify externally)</div> : null}
                    </td>
                    <td>
                      <div className="mono" style={{ fontSize: '0.78rem', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.repoUrl}</div>
                      <div className="stat-sub">branch: {p.branch}</div>
                    </td>
                    <td>
                      <StatusBadge status={rtStatus} />
                      {p.runtime?.port ? <div className="stat-sub">127.0.0.1:{p.runtime.port}{p.runtime.pid ? ` · pid ${p.runtime.pid}` : ''}</div> : null}
                    </td>
                    <td>
                      <div className="row" style={{ gap: '0.35rem' }}>
                        <button className="btn btn-sm btn-success" disabled={busy !== null} onClick={() => act(p.id, 'start')}>
                          {busy === p.id + 'start' ? '…' : 'Start'}
                        </button>
                        <button className="btn btn-sm" disabled={busy !== null} onClick={() => act(p.id, 'stop')}>
                          {busy === p.id + 'stop' ? '…' : 'Stop'}
                        </button>
                        <button className="btn btn-sm" disabled={busy !== null} onClick={() => act(p.id, 'restart')}>
                          {busy === p.id + 'restart' ? '…' : 'Restart'}
                        </button>
                        <button className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => act(p.id, 'redeploy')}>
                          {busy === p.id + 'redeploy' ? '…' : 'Pull & Redeploy'}
                        </button>
                        <button className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => remove(p)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
