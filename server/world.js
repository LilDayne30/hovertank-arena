import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorld } from '../shared/sim.js';
import { SPAWNS } from '../shared/arena.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetDir = path.join(here, '..', 'public', 'assets');

export function loadWorld() {
  const meta = JSON.parse(fs.readFileSync(path.join(assetDir, 'arena_hf.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(assetDir, 'arena_hf.bin'));
  const h = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const w = makeWorld(meta, h);
  w.spawns = SPAWNS;
  return w;
}
