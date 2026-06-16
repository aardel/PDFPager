// Light/dark theme. The initial theme is applied by an inline script in
// index.html (before first paint, no flash); this module reads/flips it at
// runtime and persists the choice. Once the user picks a theme it sticks; with
// no stored choice the inline script follows the OS `prefers-color-scheme`.

const KEY = 'pdf_pager_theme';
export type Theme = 'light' | 'dark';

export function getTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function setTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(KEY, t); } catch { /* private mode — applies for this session only */ }
  // Keep the mobile browser chrome colour in step with the theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#1C1C1E' : '#007AFF');
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
