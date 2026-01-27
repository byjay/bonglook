import { defineConfig } from 'vite';

export default defineConfig({
  base: '/bonglook/',
  server: {
    open: false,
    port: 35173,
    host: true,
  },
  root: '.',
  build: {
    outDir: 'dist',
  }
});
