import { defineConfig } from 'vite';
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Cloudflare's CDN does not compress .glb/.bin responses, so ship gzipped copies (<file>.gz);
// the client decompresses them with DecompressionStream (falls back to the plain file).
const precompress = () => ({
  name: 'precompress-binary-assets',
  apply: 'build',
  closeBundle() {
    const dir = join(import.meta.dirname, 'dist', 'assets');
    for (const f of readdirSync(dir)) {
      if (!/\.(glb|bin)$/.test(f)) continue;
      writeFileSync(join(dir, `${f}.gz`), gzipSync(readFileSync(join(dir, f)), { level: 9 }));
    }
  },
});

export default defineConfig({
  root: 'client',
  publicDir: '../public',
  build: { outDir: '../dist', emptyOutDir: true, assetsDir: 'build', target: 'es2020', chunkSizeWarningLimit: 2000 },
  server: { host: true },
  plugins: [precompress()],
});
