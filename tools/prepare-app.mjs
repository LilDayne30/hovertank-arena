// Copies the web build (dist/) into dist-app/ for the Android / iOS apps (Capacitor webDir):
// the owner's admin page and the service worker stay out of the app.
//   npm run build:app   (= vite build + this + npx cap sync)
import { cpSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = join(import.meta.dirname, '..'), src = join(root, 'dist'), out = join(root, 'dist-app');
if (!existsSync(src)) throw new Error('run vite build first');
rmSync(out, { recursive: true, force: true });
// (and no .gz copies: the app reads its local files directly, and Android's packager rejects them as duplicates)
cpSync(src, out, { recursive: true, filter: (p) => !/(^|[\\/])(admin\.html|sw\.js)$/.test(p) && !/[\\/]build[\\/]admin-[^\\/]+$/.test(p) && !/\.gz$/.test(p) });
console.log('dist-app ready');
