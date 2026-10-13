import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Node engine (src/server/**) owns every piece of audio processing.
 * The UI only ever talks to it over HTTP, so the dev server proxies /api there.
 */
const ENGINE_TARGET = process.env.AUS_ENGINE_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: ENGINE_TARGET,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    emptyOutDir: true,
  },
});
