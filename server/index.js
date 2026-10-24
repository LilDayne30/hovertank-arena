import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { BattleRoom } from './BattleRoom.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const PORT = Number(process.env.PORT || 2567);

const gameServer = new Server({
  transport: new WebSocketTransport({ pingInterval: 5000, pingMaxRetries: 3 }),
  greet: false,
  express: (app) => {
    app.use(compression());
    app.get('/healthz', (_q, s) => s.json({ ok: true }));
    if (fs.existsSync(dist)) {
      app.use('/build', express.static(path.join(dist, 'build'), { maxAge: '30d', immutable: true }));
      app.use('/assets', express.static(path.join(dist, 'assets'), { maxAge: '1h' }));
      app.use(express.static(dist, { maxAge: 0 }));
    }
  },
});
gameServer.define('battle', BattleRoom);
await gameServer.listen(PORT);
console.log(`hovertank server on :${PORT} (static: ${fs.existsSync(dist) ? dist : 'none – run npm run build'})`);
