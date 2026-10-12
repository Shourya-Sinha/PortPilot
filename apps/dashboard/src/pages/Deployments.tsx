import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, subscribeSse } from '../api';
import { StatusBadge, PhaseChips, timeAgo, fmtDuration, Notice } from '../components/ui';

interface Deployment {
  id: string; projectId: string; projectName: string; websiteName: string | null;
  status: string; phase: string; createdAt: string; startedAt: string | null; finishedAt: string | null;
  durationMs: number | null; error: string | null; commitSha: string | null; commitMessage: string | null;
  port: number | null; isRollbackOf: string | null;
}

export default function Deployments() {
  const [params] = useSearchParams();
  const projectFilter = params.get('project') ?? undefined;
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api<{ deployments: Deployment[] }>(`/api/deployments?limit=60${projectFilter ? `&projectId=${projectFilter}` : ''}`)
      .then((r) => setDeployments(r.deployments))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
    const unsub = subscribeSse('/api/events', { 'deployment:status': load });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectFilter]);

  const cancel = async (id: string) => {
    setBusy(id);
    try {
      await api(`/api/deployments/${id}/cancel`, { method: 'POST', body: {} });
      load();
    } finally {
      setBusy(null);
    }
  };

  const rollback = async (d: Deployment) => {
    setBusy(d.id);
    setError(null);
    try {
      await api(`/api/projects/${d.projectId}/rollback`, { method: 'POST', body: { deploymentId: d.id } });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="row-between mb">
        <div>
          <h2 style={{ margin: 0, fontSize: '1.35rem' }}>Deployments</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Full history with status, phases and rollback. A failed build never overwrites the last working version.
          </p>
        </div>
      </div>
      {error ? <Notice kind="danger">{error}</Notice> : null}
      {deployments.length === 0 ? (
        <div className="card empty"><h3>No deployments yet</h3><p>Deploy a project to see its history here.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Deployment</th><th>Project</th><th>Status</th><th>Phases</th><th>Commit</th><th>Timing</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link to={`/build-logs?deployment=${d.id}`} className="mono" style={{ fontSize: '0.8rem' }}>{d.id.slice(0, 16)}…</Link>
                    {d.isRollbackOf ? <div><span className="badge badge-violet">rollback</span></div> : null}
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{d.projectName}</div>
                    {d.websiteName ? <div className="stat-sub">{d.websiteName}.localhost</div> : null}
                  </td>
                  <td>
                    <StatusBadge status={d.status} />
                    {d.error ? <div className="stat-sub" style={{ color: 'var(--red)', maxWidth: 240 }}>{d.error}</div> : null}
                  </td>
                  <td><PhaseChips phase={d.phase} status={d.status} /></td>
                  <td>
                    {d.commitSha ? <code style={{ fontSize: '0.75rem' }}>{d.commitSha.slice(0, 8)}</code> : '—'}
                    {d.commitMessage ? <div className="stat-sub" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.commitMessage}</div> : null}
                  </td>
                  <td>
                    <div>{timeAgo(d.createdAt)}</div>
                    <div className="stat-sub">{fmtDuration(d.durationMs)}{d.port ? ` · port ${d.port}` : ''}</div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: '0.35rem' }}>
                      {(d.status === 'queued' || d.status === 'running') && (
                        <button className="btn btn-sm btn-danger" disabled={busy === d.id} onClick={() => cancel(d.id)}>Cancel</button>
                      )}
                      {d.status === 'succeeded' && (
                        <button className="btn btn-sm" disabled={busy === d.id} onClick={() => rollback(d)}>Rollback to here</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
