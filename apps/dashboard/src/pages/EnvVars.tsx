import { useEffect, useState } from 'react';
import { api } from '../api';
import { Notice, timeAgo } from '../components/ui';

interface ProjectOption { id: string; name: string; websiteName: string }
interface EnvVar { id: string; projectId: string; key: string; maskedValue: string; createdAt: string }

export default function EnvVars() {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api<{ projects: ProjectOption[] }>('/api/projects').then((r) => {
      setProjects(r.projects);
      if (r.projects.length > 0) setProjectId(r.projects[0].id);
    }).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!projectId) return;
    api<{ envVars: EnvVar[] }>(`/api/projects/${projectId}/env`).then((r) => setVars(r.envVars)).catch(() => setVars([]));
  }, [projectId]);

  const add = async () => {
    setError(null);
    setNotice(null);
    try {
      await api(`/api/projects/${projectId}/env`, { method: 'POST', body: { key, value } });
      setKey('');
      setValue('');
      setNotice('Variable saved — value stored encrypted and shown masked.');
      const r = await api<{ envVars: EnvVar[] }>(`/api/projects/${projectId}/env`);
      setVars(r.envVars);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/api/projects/${projectId}/env/${id}`, { method: 'DELETE' });
      setVars((v) => v.filter((x) => x.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="row-between mb">
        <div>
          <h2 style={{ margin: 0, fontSize: '1.35rem' }}>Environment Variables</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Injected into builds and app processes. Values are stored encrypted (AES-256-GCM), masked in this UI and
            redacted from logs.
          </p>
        </div>
        <select style={{ maxWidth: 320 }} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      {error ? <Notice kind="danger">{error}</Notice> : null}
      {notice ? <Notice kind="info">{notice}</Notice> : null}

      <div className="card mb">
        <h3>Add or update variable</h3>
        <div className="row">
          <input className="input" style={{ maxWidth: 240 }} value={key} onChange={(e) => setKey(e.target.value)} placeholder="API_KEY" />
          <input className="input" style={{ maxWidth: 360 }} value={value} onChange={(e) => setValue(e.target.value)} placeholder="value (stored encrypted)" type="password" />
          <button className="btn btn-primary" disabled={!key.trim() || !projectId} onClick={add}>Save variable</button>
        </div>
        <div className="hint">Keys must match [A-Za-z_][A-Za-z0-9_]*. Secrets never appear in logs or API responses (masked only).</div>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Key</th><th>Value</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            {vars.map((v) => (
              <tr key={v.id}>
                <td className="mono">{v.key}</td>
                <td className="mono">{v.maskedValue}</td>
                <td>{timeAgo(v.createdAt)}</td>
                <td><button className="btn btn-sm btn-danger" onClick={() => remove(v.id)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {vars.length === 0 ? <div className="empty"><p>No variables for this project.</p></div> : null}
      </div>
    </div>
  );
}
