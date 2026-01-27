import { defineConfig } from 'vite';

export default defineConfig({
  base: '/bonglook/',
  server: {
    open: false,
    port: 35173,
    host: true,
    cors: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  },
  root: '.',
  build: {
    outDir: 'dist',
  }
});
