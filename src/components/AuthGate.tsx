import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { authRequired, verifyToken, login, clearToken } from '../utils/auth';

// Lets the app's own UI (e.g. the header logout button) trigger a sign-out.
const AuthContext = createContext<{ logout: () => void }>({ logout: () => {} });
export const useAuth = () => useContext(AuthContext);

/**
 * Wraps the app in a login gate (web only). While checking a stored token it
 * shows nothing; if unauthenticated it shows the login screen; once in, it
 * renders the app and exposes logout via AuthContext.
 */
export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<'checking' | 'in' | 'out'>(
    authRequired() ? 'checking' : 'in'
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
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
    const err = await login(username.trim(), password, remember);
    setBusy(false);
    if (err) {
      setError(err);
      setPassword('');
    } else {
      setPassword('');
      // Force a fresh boot on sign-in so every user lands on the latest
      // deployed bundle (no stale SW/HTML lingering from a previous session).
      // The token is already persisted by login(), so the reload re-verifies
      // cleanly into the app rather than looping back to this screen.
      window.location.reload();
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
        background: 'radial-gradient(120% 120% at 50% 0%, #2A93FF 0%, #0A6CFF 38%, #0047C2 100%)',
        padding: 20,
      }}>
        <form onSubmit={submit} style={{
          background: '#fff', borderRadius: 20, padding: '38px 34px 32px', width: 'min(400px, 100%)',
          boxShadow: '0 30px 80px rgba(0, 40, 120, 0.35), 0 2px 8px rgba(0,0,0,0.12)',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, marginBottom: 8, textAlign: 'center' }}>
            <div style={{
              width: 60, height: 60, borderRadius: 16,
              background: 'linear-gradient(150deg, #2A93FF 0%, #0A6CFF 100%)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 30,
              fontFamily: 'Outfit, sans-serif', boxShadow: '0 8px 22px rgba(10, 108, 255, 0.45)',
            }}>P</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 24, fontFamily: 'Outfit, sans-serif', letterSpacing: '-0.02em', color: '#1C1C1E' }}>
                PDF&nbsp;Splitter
              </div>
              <div style={{ fontSize: 13, color: '#6E6E73', marginTop: 4, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>
                Scan · Tag · Split
              </div>
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

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#1C1C1E', cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={e => setRemember(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: '#007AFF', cursor: 'pointer' }}
            />
            Remember me on this device
          </label>

          {error && <div style={{ color: '#FF3B30', fontSize: 13 }}>{error}</div>}

          <button
            type="submit"
            disabled={busy || !username || !password}
            style={{
              marginTop: 6, padding: '13px', borderRadius: 12, border: 'none', cursor: 'pointer',
              background: 'linear-gradient(150deg, #2A93FF 0%, #0A6CFF 100%)', color: '#fff',
              fontWeight: 600, fontSize: 15, fontFamily: 'inherit',
              boxShadow: '0 8px 20px rgba(10, 108, 255, 0.35)',
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
    <AuthContext.Provider value={{ logout }}>
      {children}
    </AuthContext.Provider>
  );
};

const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', marginTop: 5, padding: '10px 12px',
  border: '1px solid #d2d2d7', borderRadius: 10, fontSize: 15, fontFamily: 'inherit',
  outline: 'none', boxSizing: 'border-box',
};
