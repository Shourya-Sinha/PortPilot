import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, subscribeSse } from '../api';
import { StatCard, StatusBadge, timeAgo, fmtDuration } from '../components/ui';

interface OverviewData {
  stats: {
    projects: number; runningApps: number; failedDeployments: number; successfulDeployments: number;
    currentBuilds: number; queuedBuilds: number; cpuPercent: number | null; totalMemMb: number; freeMemMb: number;
    apiStatus: string; dnsStatus: string; proxyStatus: string; publicAccessStatus: string;
    uptimeSeconds: number; nodeVersion: string; platform: string;
  };
  recentActivity: { id: string; type: string; message: string; createdAt: string }[];
  recentDeployments: { id: string; projectId: string; projectName: string; status: string; phase: string; createdAt: string; durationMs: number | null }[];
}

export default function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<OverviewData>('/api/overview')
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
    const unsub = subscribeSse('/api/events', {
      'deployment:status': () => load(),
      'activity': () => load(),
      'runtime:status': () => load(),
    });
    const t = setInterval(load, 20000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, []);

  if (error) return <div className="notice notice-danger">Failed to load overview: {error}</div>;
  if (!data) return <div className="muted">Loading overview…</div>;

  const { stats } = data;
  const memUsedPct = Math.round(((stats.totalMemMb - stats.freeMemMb) / stats.totalMemMb) * 100);

  return (
    <div>
      <div className="row-between mb">
        <div>
          <h2 style={{ margin: 0, fontSize: '1.35rem' }}>Overview</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Real-time status of your local deployment platform — all metrics come from the live API.
          </p>
        </div>
        <Link className="btn btn-primary" to="/create">+ New project</Link>
      </div>

      <div className="grid grid-4">
        <StatCard label="Projects" value={stats.projects} sub="registered websites" />
        <StatCard label="Running apps" value={stats.runningApps} tone={stats.runningApps > 0 ? 'green' : 'default'} sub="live application processes" />
        <StatCard label="Failed deployments" value={stats.failedDeployments} tone={stats.failedDeployments > 0 ? 'red' : 'green'} sub={`${stats.successfulDeployments} successful`} />
        <StatCard label="Build queue" value={stats.currentBuilds + stats.queuedBuilds} tone={stats.currentBuilds > 0 ? 'amber' : 'default'} sub={`${stats.currentBuilds} running · ${stats.queuedBuilds} queued`} />
      </div>

      <div className="grid grid-4 mt">
        <div className="card">
          <div className="stat-label">Local server (API)</div>
          <div style={{ marginTop: '0.55rem' }}><StatusBadge status={stats.apiStatus === 'online' ? 'online' : 'offline'} label={`API ${stats.apiStatus}`} /></div>
          <div className="stat-sub">Node {stats.nodeVersion} · uptime {fmtDuration(stats.uptimeSeconds * 1000)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Reverse proxy</div>
          <div style={{ marginTop: '0.55rem' }}><StatusBadge status={stats.proxyStatus === 'running' ? 'succeeded' : 'stopped'} label={`proxy ${stats.proxyStatus}`} /></div>
          <div className="stat-sub">hostname-based routing engine</div>
        </div>
        <div className="card">
          <div className="stat-label">DNS service</div>
          <div style={{ marginTop: '0.55rem' }}><StatusBadge status={stats.dnsStatus === 'running' ? 'succeeded' : 'disabled'} label={`dns ${stats.dnsStatus}`} /></div>
          <div className="stat-sub">optional local zone (off by default)</div>
        </div>
        <div className="card">
          <div className="stat-label">Public access</div>
          <div style={{ marginTop: '0.55rem' }}><StatusBadge status={stats.publicAccessStatus} /></div>
          <div className="stat-sub">local mode works without any public setup</div>
        </div>
      </div>

      <div className="grid grid-2 mt">
        <div className="card">
          <h3>System resources</h3>
          <div className="field">
            <div className="row-between">
              <span className="muted">CPU (load-based estimate)</span>
              <span className="mono">{stats.cpuPercent ?? '—'}%</span>
            </div>
            <div className="progress mt"><div style={{ width: `${Math.min(100, stats.cpuPercent ?? 0)}%` }} /></div>
          </div>
          <div className="field">
            <div className="row-between">
              <span className="muted">Memory</span>
              <span className="mono">{stats.totalMemMb - stats.freeMemMb} / {stats.totalMemMb} MB ({memUsedPct}%)</span>
            </div>
            <div className="progress mt"><div style={{ width: `${memUsedPct}%` }} /></div>
          </div>
          <div className="stat-sub">Platform: {stats.platform}</div>
        </div>

        <div className="card">
          <h3>Recent deployment activity</h3>
          {data.recentDeployments.length === 0 ? (
            <div className="empty">
              <p>No deployments yet.</p>
              <Link className="btn btn-primary" to="/create">Create your first project</Link>
            </div>
          ) : (
            <table className="data">
              <thead>
                <tr><th>Project</th><th>Status</th><th>Phase</th><th>When</th><th>Duration</th></tr>
              </thead>
              <tbody>
                {data.recentDeployments.map((d) => (
                  <tr key={d.id}>
                    <td><Link to={`/build-logs?deployment=${d.id}`}>{d.projectName}</Link></td>
                    <td><StatusBadge status={d.status} /></td>
                    <td className="mono" style={{ fontSize: '0.8rem' }}>{d.phase}</td>
                    <td>{timeAgo(d.createdAt)}</td>
                    <td>{fmtDuration(d.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card mt">
        <h3>Activity feed</h3>
        {data.recentActivity.length === 0 ? (
          <p className="muted">No activity yet.</p>
        ) : (
          <ul className="check-list">
            {data.recentActivity.map((a) => (
              <li key={a.id}>
                <span className="dot dot-ok" style={{ marginTop: '0.45rem' }} />
                <div>
                  <div>{a.message}</div>
                  <div className="stat-sub">{timeAgo(a.createdAt)} · {a.type}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
