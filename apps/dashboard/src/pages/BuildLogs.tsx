import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, subscribeSse } from '../api';
import { LogViewer, StatusBadge, PhaseChips, timeAgo, fmtDuration, Notice } from '../components/ui';

interface Deployment {
  id: string; projectId: string; status: string; phase: string; createdAt: string;
  durationMs: number | null; error: string | null; projectName?: string;
}

export default function BuildLogs() {
  const [params] = useSearchParams();
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [selected, setSelected] = useState<string | null>(params.get('deployment'));
  const [lines, setLines] = useState<string[]>([]);
  const [current, setCurrent] = useState<Deployment | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ deployments: Deployment[] }>('/api/deployments?limit=40')
      .then((r) => {
        setDeployments(r.deployments);
        if (!selected && r.deployments.length > 0) setSelected(r.deployments[0].id);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setLines([]);
    api<{ lines: string[] }>(`/api/deployments/${selected}/logs`).then((r) => alive && setLines(r.lines)).catch(() => undefined);
    api<{ deployment: Deployment }>(`/api/deployments/${selected}`).then((r) => alive && setCurrent(r.deployment)).catch(() => undefined);
    const unsub = subscribeSse(`/api/deployments/${selected}/stream`, {
      log: (data) => {
        const d = data as { text?: string };
        if (alive && d.text) setLines((prev) => [...prev, d.text!]);
      },
      status: () => {
        api<{ deployment: Deployment }>(`/api/deployments/${selected}`).then((r) => alive && setCurrent(r.deployment)).catch(() => undefined);
      },
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [selected]);

  return (
    <div>
      <div className="row-between mb">
        <div>
          <h2 style={{ margin: 0, fontSize: '1.35rem' }}>Build Logs</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Live build lifecycle output: checkout → detect → install → build → artifact → port → startup → health check.
          </p>
        </div>
        <select style={{ maxWidth: 380 }} value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
          {deployments.map((d) => (
            <option key={d.id} value={d.id}>
              {(d.projectName ?? d.projectId).slice(0, 20)} · {d.id.slice(0, 10)} · {d.status} · {timeAgo(d.createdAt)}
            </option>
          ))}
        </select>
      </div>
      {error ? <Notice kind="danger">{error}</Notice> : null}
      {current ? (
        <div className="card mb">
          <div className="row-between">
            <div className="row">
              <StatusBadge status={current.status} />
              <span className="mono muted">{current.id}</span>
            </div>
            <div className="row">
              <span className="muted">{timeAgo(current.createdAt)} · {fmtDuration(current.durationMs)}</span>
            </div>
          </div>
          <div className="mt"><PhaseChips phase={current.phase} status={current.status} /></div>
          {current.error ? <Notice kind="danger">{current.error}</Notice> : null}
        </div>
      ) : null}
      <LogViewer lines={lines} height={520} />
    </div>
  );
}
