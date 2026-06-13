import React, { useEffect, useRef, useState } from 'react';
import { authRequired, verifyToken, login, clearToken } from '../utils/auth';
import { LogOut } from 'lucide-react';

/**
 * Wraps the app in a login gate (web only). While checking a stored token it
 * shows nothing; if unauthenticated it shows the login screen; once in, it
 * renders the app plus an unobtrusive sign-out control.
 */
export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<'checking' | 'in' | 'out'>(
    authRequired() ? 'checking' : 'in'
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state !== 'checking') return;
    let alive = true;
    verifyToken().then(ok => { if (alive) setState(ok ? 'in' : 'out'); });
    return () => { alive = false; };
  }, [state]);

  useEffect(() => {
    if (state === 'out') userRef.current?.focus();
  }, [state]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const err = await login(username.trim(), password);
    setBusy(false);
    if (err) {
      setError(err);
      setPassword('');
    } else {
      setPassword('');
      setState('in');
    }
  };

  const logout = () => {
    clearToken();
    setUsername('');
    setPassword('');
    setState('out');
  };

  if (state === 'checking') {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-app, #f2f2f7)' }}>
        <div className="spinner" />
      </div>
    );
  }

  if (state === 'out') {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(135deg, #007AFF 0%, #0051D5 100%)', padding: 20,
      }}>
        <form onSubmit={submit} style={{
          background: '#fff', borderRadius: 16, padding: '32px 28px', width: 'min(380px, 100%)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div style={{
              width: 38, height: 38, borderRadius: 10, background: '#007AFF', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 20,
              fontFamily: 'Outfit, sans-serif',
            }}>P</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 18, fontFamily: 'Outfit, sans-serif' }}>PDFPager</div>
              <div style={{ fontSize: 12, color: '#6E6E73' }}>Sign in to continue</div>
            </div>
          </div>

          <label style={{ fontSize: 12, fontWeight: 600, color: '#6E6E73' }}>
            Username
            <input
              ref={userRef}
              type="text"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              style={inputStyle}
            />
          </label>

          <label style={{ fontSize: 12, fontWeight: 600, color: '#6E6E73' }}>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={inputStyle}
            />
          </label>

          {error && <div style={{ color: '#FF3B30', fontSize: 13 }}>{error}</div>}

          <button
            type="submit"
            disabled={busy || !username || !password}
            style={{
              marginTop: 4, padding: '12px', borderRadius: 10, border: 'none', cursor: 'pointer',
              background: '#007AFF', color: '#fff', fontWeight: 600, fontSize: 15, fontFamily: 'inherit',
              opacity: busy || !username || !password ? 0.55 : 1,
            }}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <>
      {children}
      {authRequired() && (
        <button
          onClick={logout}
          title="Sign out"
          style={{
            position: 'fixed', bottom: 14, left: 14, zIndex: 400,
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
            background: 'var(--bg-card, #fff)', color: 'var(--text-secondary, #6E6E73)',
            border: '1px solid var(--separator, #e5e5ea)', fontSize: 12, fontWeight: 600,
            fontFamily: 'inherit', boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          }}
        >
          <LogOut size={13} /> Sign out
        </button>
      )}
    </>
  );
};

const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', marginTop: 5, padding: '10px 12px',
  border: '1px solid #d2d2d7', borderRadius: 10, fontSize: 15, fontFamily: 'inherit',
  outline: 'none', boxSizing: 'border-box',
};
