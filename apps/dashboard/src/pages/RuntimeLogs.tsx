import { useEffect, useState } from 'react';
import { api, subscribeSse } from '../api';
import { LogViewer, StatusBadge, Notice, timeAgo } from '../components/ui';

interface Project {
  id: string; name: string; websiteName: string;
  runtime: { status: string; pid: number | null; port: number | null; startedAt: string | null } | null;
}

export default function RuntimeLogs() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = () =>
    api<{ projects: Project[] }>('/api/projects')
      .then((r) => {
        setProjects(r.projects);
        if (!selected && r.projects.length > 0) setSelected(r.projects[0].id);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    loadProjects();
    const unsub = subscribeSse('/api/events', { 'runtime:status': loadProjects });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    // Runtime logs are the deployment log of the active deployment + runtime process output.
    api<{ projects: { id: string; activeDeploymentId: string | null }[] }>('/api/projects').then(async (r) => {
      const p = r.projects.find((x) => x.id === selected);
      if (!p?.activeDeploymentId) {
        if (alive) setLines(['(no successful deployment yet — runtime logs appear after the first successful deploy)']);
        return;
      }
      const logs = await api<{ lines: string[] }>(`/api/deployments/${p.activeDeploymentId}/logs`);
      if (alive) setLines(logs.lines.filter((l) => l.includes('[stdout]') || l.includes('[stderr]') || l.includes('Application started') || l.includes('Process exited')));
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [selected]);

  const proj = projects.find((p) => p.id === selected);
  const rt = proj?.runtime;

  return (
    <div>
      <div className="row-between mb">
        <div>
          <h2 style={{ margin: 0, fontSize: '1.35rem' }}>Runtime Logs</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>Application process output (stdout/stderr) with timestamps.</p>
        </div>
        <select style={{ maxWidth: 320 }} value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.websiteName}.localhost)</option>)}
        </select>
      </div>
      {error ? <Notice kind="danger">{error}</Notice> : null}
      {proj ? (
        <div className="card mb">
          <div className="row">
            <StatusBadge status={rt?.status ?? 'stopped'} />
            {rt?.port ? <code>127.0.0.1:{rt.port}</code> : null}
            {rt?.pid ? <span className="muted">pid {rt.pid}</span> : null}
            {rt?.startedAt ? <span className="muted">started {timeAgo(rt.startedAt)}</span> : null}
          </div>
        </div>
      ) : null}
      <LogViewer lines={lines} height={520} />
    </div>
  );
}
