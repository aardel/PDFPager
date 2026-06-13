// Main-app login gate (web only). The password is never in the bundle —
// credentials are verified by the pdfpager-api backend, which hands back a
// signed token stored here. The scan page (separate HTML) is intentionally
// not gated.

const TOKEN_KEY = 'pdfpager_auth_token';

/** Electron loads from file:// with no backend — no gate there. */
export function authRequired(): boolean {
  return !(window as any).electronAPI;
}

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function setToken(token: string): void {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode — stays logged in for the tab's life only */ }
}

export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

/** True if a stored token is still accepted by the backend. */
export async function verifyToken(): Promise<boolean> {
  const token = getToken();
  if (!token) return false;
  try {
    const r = await fetch('/api/auth/verify', { headers: { Authorization: `Bearer ${token}` } });
    return r.ok;
  } catch {
    return false; // backend unreachable → treat as logged out
  }
}

/** Attempts login; on success stores the token and returns null, else an error message. */
export async function login(username: string, password: string): Promise<string | null> {
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success || !j.token) return j.error || 'Login failed';
    setToken(j.token);
    return null;
  } catch {
    return 'Could not reach the server. Check your connection and try again.';
  }
}
