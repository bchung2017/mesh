import { defineConfig } from 'vite';

// The Flask API dev server (see backend/). Override with MESH_API_URL if you
// run it on a different host/port.
const API_TARGET = process.env.MESH_API_URL || 'http://localhost:5000';

export default defineConfig({
  root: '.',
  server: {
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
