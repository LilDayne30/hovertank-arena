import { defineConfig } from 'vite';
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

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

// PWA: write dist/sw.js with the list of every built file and a version derived from their contents.
// Runs after precompress (plugin order), so the .gz copies are included and the plain .glb/.bin are not
// (the client only ever fetches the .gz versions).
const serviceWorker = () => ({
  name: 'service-worker',
  apply: 'build',
  closeBundle() {
    const dist = join(import.meta.dirname, 'dist');
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(join(dist, d), { withFileTypes: true })) {
        const rel = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) walk(rel); else files.push(rel);
      }
    };
    walk('');
    const list = files.filter((f) => f !== 'sw.js' && !f.endsWith('.html') && !/^assets\/.*\.(glb|bin)$/.test(f) && !/^build\/admin-/.test(f)).sort();
    const h = createHash('sha256');
    for (const f of [...list, 'index.html']) h.update(f).update(readFileSync(join(dist, f)));
    const urls = ['/', ...list.map((f) => `/${f}`)];
    const src = readFileSync(join(import.meta.dirname, 'client', 'sw-template.js'), 'utf8')
      .replace("const VERSION = '__VERSION__'", () => `const VERSION = '${ h.digest('hex').slice(0, 12)}'`)
      .replace('const PRECACHE = __PRECACHE__', () => `const PRECACHE = ${JSON.stringify(urls)}`);
    writeFileSync(join(dist, 'sw.js'), src);
  },
});

export default defineConfig({
  root: 'client',
  publicDir: '../public',
  build: {
    outDir: '../dist', emptyOutDir: true, assetsDir: 'build', target: 'es2020', chunkSizeWarningLimit: 2000,
    // the game + the owner's statistics page (/admin.html, not cached by the service worker)
    rollupOptions: { input: { main: join(import.meta.dirname, 'client', 'index.html'), admin: join(import.meta.dirname, 'client', 'admin.html') } },
  },
  server: { host: true },
  plugins: [precompress(), serviceWorker()],
});
