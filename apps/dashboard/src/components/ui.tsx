import { useEffect, useRef, useState, type ReactNode } from 'react';

export function StatCard({ label, value, sub, tone = 'default', icon }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'default' | 'green' | 'red' | 'amber'; icon?: ReactNode }) {
  const color = tone === 'green' ? 'var(--green)' : tone === 'red' ? 'var(--red)' : tone === 'amber' ? 'var(--amber)' : 'var(--text)';
  return (
    <div className="card">
      <div className="row-between">
        <div className="stat-label">{label}</div>
        {icon ? <div style={{ opacity: 0.7 }}>{icon}</div> : null}
      </div>
      <div className="stat-value" style={{ color }}>{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

const BADGE_TONES: Record<string, string> = {
  succeeded: 'badge-green',
  running: 'badge-blue',
  queued: 'badge-amber',
  failed: 'badge-red',
  cancelled: 'badge-gray',
  rolled_back: 'badge-violet',
  healthy: 'badge-green',
  stopped: 'badge-gray',
  crashed: 'badge-red',
  unhealthy: 'badge-amber',
  starting: 'badge-blue',
  unknown: 'badge-gray',
  online: 'badge-green',
  offline: 'badge-red',
  running_app: 'badge-green',
  resolvable_local: 'badge-green',
  resolvable_public: 'badge-green',
  unreachable_local: 'badge-red',
  reachable_local: 'badge-green',
  reachable_external: 'badge-green',
  unreachable_external: 'badge-red',
  not_checked: 'badge-gray',
  configured: 'badge-blue',
  unresolvable: 'badge-red',
  possible: 'badge-amber',
  unlikely: 'badge-red',
  inconclusive: 'badge-gray',
  likely: 'badge-amber',
  direct_possible: 'badge-green',
  relay_required: 'badge-amber',
  local_only: 'badge-blue',
  disabled: 'badge-gray',
  stopped_svc: 'badge-gray',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = BADGE_TONES[status] ?? 'badge-gray';
  return <span className={`badge ${tone}`}>{label ?? status.replace(/_/g, ' ')}</span>;
}

export function Spinner() {
  return <span className="spinner" aria-label="loading" />;
}

export function LogViewer({ lines, height = 420 }: { lines: string[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, follow]);
  return (
    <div>
      <div className="row-between mb">
        <span className="muted" style={{ fontSize: '0.8rem' }}>{lines.length} lines</span>
        <label className="row" style={{ fontSize: '0.8rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow tail
        </label>
      </div>
      <div className="log-viewer" ref={ref} style={{ maxHeight: height }}>
        {lines.length === 0 ? <span className="muted">No log output yet.</span> : lines.map((l, i) => {
          const cls = l.includes('[stderr]') ? 'log-line-stderr' : l.includes('[system]') ? 'log-line-system' : 'log-line-stdout';
          return <div key={i} className={cls}>{l}</div>;
        })}
      </div>
    </div>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'danger'; children: ReactNode }) {
  return <div className={`notice notice-${kind}`}>{children}</div>;
}

export function PhaseChips({ phase, status }: { phase: string; status: string }) {
  const phases = ['checkout', 'detect', 'install', 'build', 'artifact', 'port_allocation', 'startup', 'health_check', 'done'];
  const labels: Record<string, string> = {
    checkout: 'checkout', detect: 'detect', install: 'install', build: 'build', artifact: 'artifact',
    port_allocation: 'port', startup: 'startup', health_check: 'health', done: 'done',
  };
  const currentIdx = phases.indexOf(phase);
  return (
    <div className="phase-steps">
      {phases.map((p, i) => {
        let cls = 'phase-chip';
        if (status === 'succeeded' || i < currentIdx) cls += ' done';
        else if (i === currentIdx) cls += status === 'failed' ? ' failed' : ' current';
        if (status === 'failed' && i === currentIdx) cls = 'phase-chip failed';
        return <span key={p} className={cls}>{labels[p]}</span>;
      })}
    </div>
  );
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return iso;
  const s = Math.floor(diff / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn-sm"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'copied!' : 'copy'}
    </button>
  );
}
