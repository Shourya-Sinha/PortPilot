import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Notice, CopyButton, PhaseChips } from '../components/ui';

interface Branch { name: string; sha: string }
interface DetectedConfig {
  framework: string; deploymentMode: string; packageManager: string;
  installCommand: string | null; buildCommand: string | null; startCommand: string | null;
  outputDir: string | null; healthCheckPath: string | null; confidence: string; notes: string[];
}

const STEPS = ['Repository', 'Website name', 'Build configuration', 'Review & deploy'];

export default function CreateProject() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // form state
  const [name, setName] = useState('');
  const [websiteName, setWebsiteName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [projectRoot, setProjectRoot] = useState('.');
  const [framework, setFramework] = useState('unknown');
  const [deploymentMode, setDeploymentMode] = useState('node');
  const [packageManager, setPackageManager] = useState('npm');
  const [installCommand, setInstallCommand] = useState('npm ci');
  const [buildCommand, setBuildCommand] = useState('npm run build');
  const [startCommand, setStartCommand] = useState('npm start');
  const [outputDir, setOutputDir] = useState('dist');
  const [preferredPort, setPreferredPort] = useState('');
  const [healthCheckPath, setHealthCheckPath] = useState('/');
  const [publicHostname, setPublicHostname] = useState('');
  const [envText, setEnvText] = useState('');

  const [detected, setDetected] = useState<DetectedConfig | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [created, setCreated] = useState<{ localUrl: string; websiteName: string } | null>(null);

  // Auto-generate website name from project name.
  useEffect(() => {
    if (!websiteName || websiteName === slugify(name.slice(0, -1))) {
      setWebsiteName(slugify(name));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const slugify = (s: string) =>
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

  const loadBranches = async () => {
    setBusy('branches');
    setError(null);
    try {
      const res = await api<{ ok: boolean; branches: Branch[]; error?: string }>(`/api/github/branches?url=${encodeURIComponent(repoUrl)}`);
      if (res.ok && res.branches.length > 0) {
        setBranches(res.branches);
        if (res.branches.some((b) => b.name === 'main')) setBranch('main');
        else if (res.branches.some((b) => b.name === 'master')) setBranch('master');
        else setBranch(res.branches[0].name);
      } else if (!res.ok) {
        setError(`Could not list branches: ${res.error ?? 'unknown error'}. You can still type a branch name manually.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const createProject = async (): Promise<boolean> => {
    setBusy('create');
    setError(null);
    try {
      const res = await api<{ project: { id: string }; localUrl: string }>('/api/projects', {
        method: 'POST',
        body: {
          name,
          websiteName,
          repoUrl,
          branch,
          projectRoot,
          framework,
          deploymentMode,
          packageManager,
          installCommand: installCommand || null,
          buildCommand: buildCommand || null,
          startCommand: startCommand || null,
          outputDir: outputDir || null,
          preferredPort: preferredPort ? Number(preferredPort) : null,
          healthCheckPath,
          publicHostname: publicHostname || null,
        },
      });
      setProjectId(res.project.id);
      // env vars
      for (const line of envText.split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (m) {
          await api(`/api/projects/${res.project.id}/env`, { method: 'POST', body: { key: m[1], value: m[2] } });
        }
      }
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') {
        setError(e.message);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      return false;
    } finally {
      setBusy(null);
    }
  };

  const detectConfig = async (pid: string) => {
    setBusy('detect');
    setError(null);
    try {
      const res = await api<{ ok: boolean; detected?: DetectedConfig; error?: string }>(`/api/projects/${pid}/detect`, { method: 'POST', body: {} });
      if (res.detected) {
        setDetected(res.detected);
        if (res.detected.installCommand) setInstallCommand(res.detected.installCommand);
        if (res.detected.buildCommand) setBuildCommand(res.detected.buildCommand);
        if (res.detected.startCommand) setStartCommand(res.detected.startCommand);
        if (res.detected.outputDir) setOutputDir(res.detected.outputDir);
        if (res.detected.framework !== 'unknown') setFramework(res.detected.framework);
        setDeploymentMode(res.detected.deploymentMode);
        setPackageManager(res.detected.packageManager);
        if (res.detected.healthCheckPath) setHealthCheckPath(res.detected.healthCheckPath);
      } else {
        setError(res.error ?? 'Detection failed — fill in the configuration manually.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const deploy = async (confirmed: boolean) => {
    if (!projectId) return;
    setBusy('deploy');
    setError(null);
    try {
      const res = await api<{ deployment?: { id: string }; localUrl?: string; code?: string; detected?: DetectedConfig }>(
        `/api/projects/${projectId}/deploy`,
        {
          method: 'POST',
          body: {
            confirm: confirmed,
            config: {
              framework, deploymentMode, packageManager,
              installCommand: installCommand || null,
              buildCommand: buildCommand || null,
              startCommand: startCommand || null,
              outputDir: outputDir || null,
              projectRoot,
              healthCheckPath,
            },
          },
        },
      );
      if (res.code === 'confirmation_required') {
        if (res.detected) setDetected(res.detected);
        setStep(3);
        setError('Review the detected configuration above and click "Confirm & Deploy".');
        return;
      }
      if (res.localUrl) {
        setCreated({ localUrl: res.localUrl, websiteName });
      }
      if (res.deployment) navigate(`/build-logs?deployment=${res.deployment.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirmation_required') {
        setStep(3);
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const canNext = () => {
    if (step === 0) return repoUrl.trim().length > 3 && branch.trim().length > 0;
    if (step === 1) return name.trim().length > 0 && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(websiteName);
    return true;
  };

  return (
    <div style={{ maxWidth: 860 }}>
      <h2 style={{ fontSize: '1.35rem' }}>Create Project</h2>
      <p className="muted">Deploy from a GitHub repository in a few steps. Public repos need no GitHub account connection.</p>

      <div className="row mb" style={{ marginTop: '1rem' }}>
        {STEPS.map((s, i) => (
          <span key={s} className={`pill-tab${i === step ? ' active' : ''}`} style={{ cursor: 'default' }}>
            {i + 1}. {s}
          </span>
        ))}
      </div>

      {error ? <Notice kind={error.includes('Confirm') ? 'info' : 'danger'}>{error}</Notice> : null}

      {step === 0 && (
        <div className="card">
          <h3>GitHub repository</h3>
          <div className="field">
            <label>Repository URL *</label>
            <input className="input" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repo.git" />
            <div className="hint">https://, ssh:// or git@github.com:owner/repo.git — credentials in URLs are rejected.</div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Branch *</label>
              <div className="row">
                {branches.length > 0 ? (
                  <select value={branch} onChange={(e) => setBranch(e.target.value)}>
                    {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
                  </select>
                ) : (
                  <input className="input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
                )}
                <button className="btn" type="button" disabled={busy === 'branches' || !repoUrl} onClick={loadBranches}>
                  {busy === 'branches' ? 'Loading…' : 'List branches'}
                </button>
              </div>
            </div>
            <div className="field">
              <label>Project root (inside repo)</label>
              <input className="input" value={projectRoot} onChange={(e) => setProjectRoot(e.target.value)} placeholder="." />
            </div>
          </div>
          <div className="row-between">
            <span />
            <button className="btn btn-primary" disabled={!canNext()} onClick={() => setStep(1)}>Next: website name</button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <h3>Website name & local hostname</h3>
          <Notice kind="info">
            The website name is <b>required</b>. It is saved in the local database, generates your local hostname
            (e.g. <code>my-portfolio.localhost</code>) and creates the reverse-proxy route automatically.
            This is a <b>local registration only</b> — it is not a globally registered domain.
          </Notice>
          <div className="form-row">
            <div className="field">
              <label>Project name *</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Portfolio" />
            </div>
            <div className="field">
              <label>Website name * (lowercase, digits, hyphens)</label>
              <input className="input" value={websiteName} onChange={(e) => setWebsiteName(slugify(e.target.value))} placeholder="my-portfolio" />
              <div className="hint">
                Local URL after deployment: <code>http://{websiteName || 'my-portfolio'}.localhost:8080</code>
              </div>
            </div>
          </div>
          <div className="field">
            <label>Optional public hostname</label>
            <input className="input" value={publicHostname} onChange={(e) => setPublicHostname(e.target.value)} placeholder="myapp.example.com (optional)" />
            <div className="hint">
              Only used if you actually control this name and configure public DNS + networking. The dashboard never
              claims a made-up domain is publicly reachable.
            </div>
          </div>
          <div className="row-between">
            <button className="btn" onClick={() => setStep(0)}>Back</button>
            <button className="btn btn-primary" disabled={!canNext()} onClick={() => setStep(2)}>Next: build configuration</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h3>Build & run configuration</h3>
          <div className="notice notice-info">
            <div className="row-between">
              <div>
                Commands are <b>never guessed silently</b>. Click “Detect from repository” to let PortPilot analyze
                <code> package.json</code> and framework files, then review every command below before deploying.
              </div>
              <button className="btn" disabled={!repoUrl || busy === 'detect'} onClick={async () => {
                if (!projectId) {
                  const ok = await createProject();
                  if (ok && projectId === null) { /* id set in state */ }
                }
                const pid = projectId ?? (await api<{ projects: { id: string; websiteName: string }[] }>('/api/projects')).projects.find((p) => p.websiteName === websiteName)?.id;
                if (pid) {
                  setProjectId(pid);
                  await detectConfig(pid);
                }
              }}>
                {busy === 'detect' ? 'Detecting…' : 'Detect from repository'}
              </button>
            </div>
          </div>
          {detected ? (
            <div className="card" style={{ background: 'rgba(56,189,248,0.06)' }}>
              <div className="row-between">
                <h3 style={{ margin: 0 }}>Detected configuration ({detected.confidence} confidence)</h3>
                <span className="badge badge-blue">{detected.framework}</span>
              </div>
              {detected.notes.length > 0 && (
                <ul className="check-list">
                  {detected.notes.map((n, i) => <li key={i}>• {n}</li>)}
                </ul>
              )}
            </div>
          ) : null}
          <div className="form-row-3">
            <div className="field">
              <label>Framework</label>
              <select value={framework} onChange={(e) => setFramework(e.target.value)}>
                {['unknown', 'static', 'vite', 'react', 'next', 'node', 'express', 'fastify', 'java-maven', 'java-gradle'].map((f) => <option key={f}>{f}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Deployment mode</label>
              <select value={deploymentMode} onChange={(e) => setDeploymentMode(e.target.value)}>
                <option value="static">static (file server)</option>
                <option value="node">node (long-running process)</option>
                <option value="java-maven">java-maven</option>
                <option value="java-gradle">java-gradle</option>
              </select>
            </div>
            <div className="field">
              <label>Package manager</label>
              <select value={packageManager} onChange={(e) => setPackageManager(e.target.value)}>
                {['npm', 'pnpm', 'yarn', 'none'].map((f) => <option key={f}>{f}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Install command</label>
              <input className="input" value={installCommand} onChange={(e) => setInstallCommand(e.target.value)} placeholder="npm ci" />
            </div>
            <div className="field">
              <label>Build command</label>
              <input className="input" value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} placeholder="npm run build" />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Start command</label>
              <input className="input" value={startCommand} onChange={(e) => setStartCommand(e.target.value)} placeholder="npm start" />
              <div className="hint">Only used for process (node) deployments. Static sites get the built-in file server.</div>
            </div>
            <div className="field">
              <label>Output directory</label>
              <input className="input" value={outputDir} onChange={(e) => setOutputDir(e.target.value)} placeholder="dist" />
            </div>
          </div>
          <div className="form-row-3">
            <div className="field">
              <label>Preferred app port (optional)</label>
              <input className="input" value={preferredPort} onChange={(e) => setPreferredPort(e.target.value)} placeholder="auto" />
            </div>
            <div className="field">
              <label>Health-check path</label>
              <input className="input" value={healthCheckPath} onChange={(e) => setHealthCheckPath(e.target.value)} placeholder="/" />
            </div>
            <div className="field">
              <label>Environment variables</label>
              <textarea rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={'KEY=value\nOTHER=hello'} />
              <div className="hint">Stored encrypted, masked in the UI, injected at build/start.</div>
            </div>
          </div>
          <div className="row-between">
            <button className="btn" onClick={() => setStep(1)}>Back</button>
            <button className="btn btn-primary" disabled={busy !== null} onClick={async () => {
              const ok = projectId ? true : await createProject();
              if (ok) setStep(3);
            }}>
              {busy === 'create' ? 'Creating…' : 'Next: review & deploy'}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h3>Review & deploy</h3>
          <dl className="kv">
            <dt>Project</dt><dd>{name}</dd>
            <dt>Website name</dt><dd><code>{websiteName}</code> — local hostname <code>{websiteName}.localhost</code> (local registration only)</dd>
            <dt>Repository</dt><dd className="mono">{repoUrl} @ {branch}</dd>
            <dt>Mode</dt><dd>{deploymentMode} · {framework} · {packageManager}</dd>
            <dt>Commands</dt><dd className="mono">install: {installCommand || '—'} · build: {buildCommand || '—'} · start: {startCommand || '—'}</dd>
          </dl>
          <Notice kind="warn">
            Build scripts run as your user account and can execute arbitrary code — treat unknown repositories as
            untrusted. PortPilot validates command syntax but is <b>not</b> a security sandbox (see docs/security.md).
          </Notice>
          {created ? (
            <Notice kind="info">
              <div style={{ fontWeight: 600 }}>Project registered.</div>
              <div className="row mt">
                <a href={created.localUrl} target="_blank" rel="noreferrer" className="btn btn-primary">{created.localUrl}</a>
                <CopyButton text={created.localUrl} />
              </div>
            </Notice>
          ) : null}
          <div className="row-between">
            <button className="btn" onClick={() => setStep(2)}>Back</button>
            <div className="row">
              <button className="btn btn-primary" disabled={busy !== null || !projectId} onClick={() => deploy(true)}>
                {busy === 'deploy' ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Deploying…</> : 'Confirm & Deploy'}
              </button>
            </div>
          </div>
          <div className="mt">
            <PhaseChips phase="checkout" status="queued" />
          </div>
        </div>
      )}
    </div>
  );
}
