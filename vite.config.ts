import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true, // TEMP: resolve real stack traces while diagnosing the export bug
  },
  server: {
    port: 5173,
    strictPort: true,
  }
});
