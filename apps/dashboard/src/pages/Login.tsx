import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../api';

export default function Login() {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(token.trim());
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand" style={{ justifyContent: 'center', paddingBottom: '1.4rem' }}>
          <div className="brand-logo">P</div>
          <div>
            <div className="brand-name">PortPilot</div>
            <div className="brand-sub">HomeDeploy Dashboard</div>
          </div>
        </div>
        <p className="muted" style={{ textAlign: 'center', fontSize: '0.88rem' }}>
          Enter the access token printed by <code>npm run start</code> (also stored in
          <code> data/.session-token</code>).
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <label>Access token</label>
            <input
              className="input"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="paste the PortPilot access token"
              autoFocus
            />
          </div>
          {error ? <div className="notice notice-danger">{error}</div> : null}
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || token.trim().length < 8}>
            {busy ? 'Verifying…' : 'Sign in'}
          </button>
        </form>
        <p className="muted" style={{ fontSize: '0.76rem', marginTop: '1.1rem', textAlign: 'center' }}>
          The dashboard is bound to localhost by default. The token protects LAN exposure and browser-based CSRF.
        </p>
      </div>
    </div>
  );
}
