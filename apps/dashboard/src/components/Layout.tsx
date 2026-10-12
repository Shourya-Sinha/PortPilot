import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api, me } from '../api';

const NAV: { section: string; items: { to: string; label: string; icon: string }[] }[] = [
  {
    section: 'Platform',
    items: [
      { to: '/', label: 'Overview', icon: '◈' },
      { to: '/projects', label: 'Projects', icon: '▣' },
      { to: '/create', label: 'Create Project', icon: '＋' },
      { to: '/deployments', label: 'Deployments', icon: '▲' },
    ],
  },
  {
    section: 'Observability',
    items: [
      { to: '/build-logs', label: 'Build Logs', icon: '≣' },
      { to: '/runtime-logs', label: 'Runtime Logs', icon: '≣' },
    ],
  },
  {
    section: 'Networking',
    items: [
      { to: '/hostnames', label: 'Domains & Hostnames', icon: '◎' },
      { to: '/dns', label: 'DNS Settings', icon: '⇄' },
      { to: '/network', label: 'Network & Public Access', icon: '⌾' },
    ],
  },
  {
    section: 'Configuration',
    items: [
      { to: '/env', label: 'Environment Variables', icon: '⌘' },
      { to: '/github', label: 'GitHub Integration', icon: '⎇' },
      { to: '/settings', label: 'System Settings', icon: '⚙' },
    ],
  },
];

export default function Layout() {
  const navigate = useNavigate();
  const [health, setHealth] = useState<{ api: string; proxy: string; dns: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ api: string; proxy: string; dns: string }>('/api/system/health')
        .then((h) => alive && setHealth(h))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">P</div>
          <div>
            <div className="brand-name">PortPilot</div>
            <div className="brand-sub">HomeDeploy Dashboard</div>
          </div>
        </div>
        {NAV.map((group) => (
          <div key={group.section}>
            <div className="nav-section">{group.section}</div>
            {group.items.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                <span className="nav-icon">{item.icon}</span>
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
        <div style={{ marginTop: '1.6rem', padding: '0.6rem', fontSize: '0.75rem', color: 'var(--text-faint)' }}>
          <div className="row" style={{ gap: '0.4rem' }}>
            <span className={`dot ${health?.api === 'online' ? 'dot-ok' : 'dot-err'}`} /> API {health?.api ?? '…'}
          </div>
          <div className="row" style={{ gap: '0.4rem' }}>
            <span className={`dot ${health?.proxy === 'running' ? 'dot-ok' : 'dot-off'}`} /> Proxy {health?.proxy ?? '…'}
          </div>
          <div className="row" style={{ gap: '0.4rem' }}>
            <span className={`dot ${health?.dns === 'running' ? 'dot-ok' : 'dot-off'}`} /> DNS {health?.dns ?? '…'}
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <h1>Local-first deployment platform</h1>
          <div className="topbar-actions">
            <span className="badge badge-blue">local mode</span>
            <button
              className="btn btn-sm"
              onClick={async () => {
                await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
                me().then(() => navigate('/login'));
              }}
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
