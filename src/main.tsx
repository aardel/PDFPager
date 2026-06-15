import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { AuthGate } from './components/AuthGate.tsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);

// PWA: web only — Electron loads from file:// and has no use for a SW.
if (!(window as any).electronAPI && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Fetch any new version in the background, but DON'T force-reload — a
      // surprise reload mid-task (tagging, cropping, scanning) would interrupt
      // work. The update applies on the user's next normal page load.
      reg.update();
    }).catch(() => { /* offline support is best-effort */ });
  });
}
