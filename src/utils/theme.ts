// Light/dark theme. The initial theme is applied by an inline script in
// index.html (before first paint, no flash); this module reads/flips it at
// runtime and persists the choice. Once the user picks a theme it sticks; with
// no stored choice we follow the OS `prefers-color-scheme`.
//
// The saved choice lives in localStorage and is re-applied on app mount too
// (see applyStoredTheme), so persistence survives even if a stale cached
// index.html ever loads without the inline script.

const KEY = 'pdf_pager_theme';
export type Theme = 'light' | 'dark';

function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  try {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** The theme that should be in effect: the saved choice, else the OS setting. */
export function resolveTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

export function getTheme(): Theme {
  // Prefer the applied attribute (set by the inline script before paint); fall
  // back to the stored/OS value if it's missing (e.g. a cached index.html
  // without the inline script).
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  return resolveTheme();
}

export function setTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(KEY, t); } catch { /* private mode — applies for this session only */ }
  // Keep the mobile browser chrome colour in step with the theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#1C1C1E' : '#007AFF');
}

/** Re-apply the saved (or OS) theme to the document. Idempotent; called on app
 *  mount so the remembered choice is honoured even without the inline script. */
export function applyStoredTheme(): Theme {
  const t = resolveTheme();
  document.documentElement.setAttribute('data-theme', t);
  return t;
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
