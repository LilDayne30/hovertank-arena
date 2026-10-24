import { defineConfig } from 'vite';
export default defineConfig({
  root: 'client',
  publicDir: '../public',
  build: { outDir: '../dist', emptyOutDir: true, assetsDir: 'build', target: 'es2020', chunkSizeWarningLimit: 2000 },
  server: { host: true },
});
