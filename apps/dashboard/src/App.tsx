import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Layout from './components/Layout';
import { login, me } from './api';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Projects from './pages/Projects';
import CreateProject from './pages/CreateProject';
import Deployments from './pages/Deployments';
import BuildLogs from './pages/BuildLogs';
import RuntimeLogs from './pages/RuntimeLogs';
import Hostnames from './pages/Hostnames';
import DnsSettings from './pages/DnsSettings';
import Network from './pages/Network';
import EnvVars from './pages/EnvVars';
import Github from './pages/Github';
import Settings from './pages/Settings';

function TokenBootstrap({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'authed' | 'anon'>('checking');
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    const done = (ok: boolean) => {
      setState(ok ? 'authed' : 'anon');
      if (token) navigate(location.pathname, { replace: true });
    };
    if (token) {
      login(token).then(() => done(true)).catch(() => done(false));
    } else {
      me().then((r) => done(Boolean(r.authenticated))).catch(() => done(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === 'checking') {
    return (
      <div className="login-wrap">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <div className="brand" style={{ justifyContent: 'center' }}>
            <div className="brand-logo">P</div>
            <div>
              <div className="brand-name">PortPilot</div>
              <div className="brand-sub">HomeDeploy Dashboard</div>
            </div>
          </div>
          <p className="muted">Checking session…</p>
        </div>
      </div>
    );
  }
  if (state === 'anon' && location.pathname !== '/login') {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <TokenBootstrap>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Layout />}>
            <Route index element={<Overview />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/create" element={<CreateProject />} />
            <Route path="/deployments" element={<Deployments />} />
            <Route path="/build-logs" element={<BuildLogs />} />
            <Route path="/runtime-logs" element={<RuntimeLogs />} />
            <Route path="/hostnames" element={<Hostnames />} />
            <Route path="/dns" element={<DnsSettings />} />
            <Route path="/network" element={<Network />} />
            <Route path="/env" element={<EnvVars />} />
            <Route path="/github" element={<Github />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </TokenBootstrap>
    </BrowserRouter>
  );
}
