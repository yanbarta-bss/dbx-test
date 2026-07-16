import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local dev only: the Databricks Apps OAuth proxy injects x-forwarded-* identity headers in
// production, but the browser can't send them locally. This proxy forwards /api to the local
// uvicorn server and stamps a dev identity so admin gating and the on-behalf-of-user token
// path work. Set DEV_DBX_EMAIL / DEV_DBX_TOKEN (e.g. `databricks auth token`) before `npm run dev`.
const devEmail = process.env.DEV_DBX_EMAIL || 'yan.barta@blindspot.ai';
const devToken = process.env.DEV_DBX_TOKEN || '';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('x-forwarded-email', devEmail);
            proxyReq.setHeader('x-forwarded-preferred-username', devEmail.split('@')[0]);
            proxyReq.setHeader('x-forwarded-groups', 'admins');
            if (devToken) {
              proxyReq.setHeader('x-forwarded-access-token', devToken);
            }
          });
        },
      },
    },
  },
});
