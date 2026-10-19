import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` proxies the API to a dashboard already running (npm start).
const target = process.env.DASH_URL || 'http://127.0.0.1:8080';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': { target, changeOrigin: false },
    },
  },
});
