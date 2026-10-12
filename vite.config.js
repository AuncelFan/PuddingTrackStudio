import { defineConfig } from 'vite';

export default defineConfig({
  // Keep the build relocatable below a reverse proxy's path prefix.
  base: './',
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8000' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
