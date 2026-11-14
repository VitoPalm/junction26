import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Served by the API at /glasses/ (same origin as /v1). In dev, /v1 is proxied.
export default defineConfig({
  base: '/glasses/',
  plugins: [react()],
  resolve: { conditions: ['junction26-source', 'module', 'browser', 'development|production'] },
  server: { proxy: { '/v1': 'http://127.0.0.1:8080' } },
  build: { target: 'es2022', chunkSizeWarningLimit: 600 },
});
