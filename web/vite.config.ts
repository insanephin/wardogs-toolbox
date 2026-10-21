import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { join } from 'node:path';

const target = process.env.DASH_URL || 'http://127.0.0.1:8080';

export default defineConfig(({ mode }) => {
  const isAdmin = mode === 'admin';
  return {
    root: import.meta.dirname,
    base: isAdmin ? '/rcon/' : '/',
    plugins: [react()],
    build: {
      outDir: isAdmin ? '../dist/admin' : '../dist/public',
      emptyOutDir: true,
      rolldownOptions: { input: join(import.meta.dirname, isAdmin ? 'admin.html' : 'index.html') },
    },
    server: {
      proxy: {
        '/api': { target, changeOrigin: false },
        '/auth': { target, changeOrigin: false },
        '/callback': { target, changeOrigin: false },
      },
    },
  };
});
