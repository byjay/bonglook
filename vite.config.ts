import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    open: false,
    port: 35173, // Unique UI Port
    host: true,  // Important for Docker
  },
  root: '.',
  build: {
    outDir: 'dist',
  }
});
