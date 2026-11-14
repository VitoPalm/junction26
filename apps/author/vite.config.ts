import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * One codebase, three targets:
 * - web: served by the API at /author/ (same origin as /v1)
 * - native (`--mode native`): bundled into the Capacitor iOS/Android shells,
 *   relative base, API at VITE_API_BASE or the server chosen at sign-in.
 * preview.html is the glasses renderer at 600×600, loaded in an iframe.
 */
export default defineConfig(({ mode }) => ({
  base: mode === 'native' ? './' : '/author/',
  plugins: [react()],
  resolve: { conditions: ['junction26-source', 'module', 'browser', 'development|production'] },
  server: { proxy: { '/v1': 'http://127.0.0.1:8080' } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 800,
    rolldownOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), preview: resolve(import.meta.dirname, 'preview.html') } },
  },
}));
