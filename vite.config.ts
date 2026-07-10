import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true, // keep console errors readable for future bug reports — no secrets in a client-only app
  },
  server: {
    port: 5173,
    strictPort: true,
  }
});
