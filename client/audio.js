// Sound: every effect and the music are synthesized with the Web Audio API at runtime
// (no audio files to download). A compressor/limiter on the master makes it loud and punchy.
// Positional sounds are attenuated by distance and panned left/right relative to the camera.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const NOTE = (n) => 440 * 2 ** ((n - 69) / 12);   // MIDI note -> Hz

export class Sound {
  constructor() {
    this.ctx = null;
    this.vol = { bgm: 0.55, sfx: 0.9 };
    this.muted = false;
    this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
    this.voices = 0;
    this.music = { mode: 'off', step: 0, next: 0, bar: 0, intense: false };
  }

  // must be called from a user gesture (browsers start audio suspended)
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.init(new AC({ latencyHint: 'interactive' }));
      this.scheduler = setInterval(() => this.schedule(), 25);
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.ctx.suspend(); else this.ctx.resume(); });
    }
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }
  // build the audio graph on a context (an OfflineAudioContext in tests)
  init(ctx, offline = false) {
    this.offline = offline; this.at = 0;
    {
      const c = this.ctx = ctx;
      this.master = c.createGain();
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -16; comp.knee.value = 8; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.18;
      this.limiter = c.createDynamicsCompressor();
      this.limiter.threshold.value = -2; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.001; this.limiter.release.value = 0.05;
      // master low-pass, normally wide open; dips for a moment on a kill (muffled "impact" feel)
      this.duck = c.createBiquadFilter(); this.duck.type = 'lowpass'; this.duck.frequency.value = 20000; this.duck.Q.value = 0.7;
      this.master.connect(this.duck); this.duck.connect(comp); comp.connect(this.limiter); this.limiter.connect(c.destination);
      this.sfx = c.createGain(); this.sfx.connect(this.master);
      this.bgm = c.createGain(); this.bgm.connect(this.master);
      // shared reverb (generated impulse) for big, roomy explosions
      this.verb = c.createConvolver(); this.verb.buffer = this.impulse(1.8, 2.6);
      this.verbIn = c.createGain(); this.verbIn.gain.value = 0.9; this.verbIn.connect(this.verb); this.verb.connect(this.sfx);
      // tape-ish delay for the music lead
      this.delay = c.createDelay(1); this.delay.delayTime.value = 0.34;
      const fb = c.createGain(); fb.gain.value = 0.35; this.delay.connect(fb); fb.connect(this.delay);
      const dOut = c.createGain(); dOut.gain.value = 0.5; this.delay.connect(dOut); dOut.connect(this.bgm);
      this.noiseBuf = this.makeNoise(2);
      this.drive = c.createWaveShaper(); this.drive.curve = this.curve(2.2); this.drive.connect(this.sfx);
      this.applyVolume();
      this.startEngine();
    }
  }
  get ready() { return this.ctx && (this.ctx.state === 'running' || this.offline); }

  setVolume(k, v) { this.vol[k] = v; this.applyVolume(); }
  setMuted(m) { this.muted = m; this.applyVolume(); }
  applyVolume() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, m = this.muted ? 0 : 1;
    this.sfx.gain.setTargetAtTime(this.vol.sfx * m, t, 0.05);
    this.bgm.gain.setTargetAtTime(this.vol.bgm * 0.32 * m, t, 0.05);   // music sits under the effects
  }

  // ------------------------------------------------------------------ building blocks
  makeNoise(sec) {
    const b = this.ctx.createBuffer(1, this.ctx.sampleRate * sec, this.ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  impulse(sec, decay) {
    const c = this.ctx, n = c.sampleRate * sec, b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** decay; }
    return b;
  }
  curve(k) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
    return c;
  }
  // output node for one sound: gain (distance) -> panner -> bus (+ reverb send)
  out({ pos, gain = 1, verb = 0, drive = false, bus } = {}) {
    const c = this.ctx;
    let g = gain, pan = 0;
    if (pos) {
      const L = this.listener, dx = pos.x - L.x, dz = pos.z - L.z, d = Math.hypot(dx, dz, (pos.y ?? L.y) - L.y);
      g *= 1 / (1 + (d / 16) ** 1.35);
      // right of the camera = positive pan (camera forward = (-sin yaw, -cos yaw))
      const rx = Math.cos(L.yaw), rz = -Math.sin(L.yaw);
      pan = clamp(((dx * rx + dz * rz) / Math.max(1, d)) * 0.8, -0.85, 0.85);
    }
    const node = c.createGain(); node.gain.value = g;
    let tail = node;
    if (c.createStereoPanner && pos) { const p = c.createStereoPanner(); p.pan.value = pan; node.connect(p); tail = p; }
    tail.connect(bus || (drive ? this.drive : this.sfx));
    if (verb) { const s = c.createGain(); s.gain.value = verb * g; node.connect(s); s.connect(this.verbIn); }
    return { node, g };
  }
  voice(ms) { this.voices++; setTimeout(() => this.voices--, ms); return this.voices < 40; }

  tone(dest, { type = 'sine', f0, f1 = f0, t = 0, dur = 0.2, a = 0.002, gain = 0.5, curve = 'exp' }) {
    const c = this.ctx, now = c.currentTime + this.at + t;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, now);
    if (f1 !== f0) (curve === 'lin' ? o.frequency.linearRampToValueAtTime(f1, now + dur) : o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), now + dur));
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(gain, now + a); g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o.connect(g); g.connect(dest); o.start(now); o.stop(now + dur + 0.05);
  }
  noise(dest, { type = 'lowpass', f0 = 1000, f1 = f0, q = 0.8, t = 0, dur = 0.3, a = 0.002, gain = 0.5 }) {
    const c = this.ctx, now = c.currentTime + this.at + t;
    const s = c.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, now); if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), now + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(gain, now + a); g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    s.connect(f); f.connect(g); g.connect(dest);
    s.start(now, Math.random() * 1.5); s.stop(now + dur + 0.05);
  }

  // ------------------------------------------------------------------ effects
  fire(pos, own) {
    if (!this.ready || !this.voice(600)) return;
    const { node } = this.out({ pos: own ? null : pos, gain: own ? 1.0 : 0.9, verb: 0.35, drive: true });
    this.tone(node, { f0: 170, f1: 38, dur: 0.38, gain: 1.0 });                 // chest thump
    this.noise(node, { type: 'highpass', f0: 2500, dur: 0.07, gain: 0.7 });     // crack
    this.noise(node, { f0: 2600, f1: 260, dur: 0.42, gain: 0.9 });              // blast body
    this.tone(node, { type: 'square', f0: 90, f1: 45, dur: 0.12, gain: 0.25 });
  }
  boom(pos, size = 1) {
    if (!this.ready || !this.voice(1200)) return;
    const { node, g } = this.out({ pos, gain: 0.75 * size, verb: 0.6, drive: true });
    if (g < 0.02) return;
    this.tone(node, { f0: 110, f1: 32, dur: 0.6 * size, gain: 1.0 });
    this.noise(node, { f0: 3200, f1: 140, dur: 0.85 * size, gain: 0.9 });
    for (let i = 0; i < 6; i++) this.noise(node, { type: 'bandpass', f0: 1500 + Math.random() * 2500, q: 3, t: 0.05 + Math.random() * 0.45, dur: 0.04, gain: 0.35 });   // debris crackle
  }
  hitConfirm() {   // you hit someone: metallic clang + bright ding
    if (!this.ready) return;
    const { node } = this.out({ gain: 0.55 });
    this.tone(node, { type: 'triangle', f0: 920, f1: 880, dur: 0.22, gain: 0.6 });
    this.tone(node, { type: 'square', f0: 1380, f1: 1320, dur: 0.12, gain: 0.18 });
    this.tone(node, { f0: 2093, dur: 0.32, t: 0.02, gain: 0.35 });
  }
  hurt() {         // you got hit
    if (!this.ready) return;
    const { node } = this.out({ gain: 1.0, drive: true, verb: 0.2 });
    this.tone(node, { f0: 95, f1: 38, dur: 0.35, gain: 1.0 });
    this.noise(node, { f0: 900, f1: 120, dur: 0.3, gain: 0.8 });
    this.tone(node, { type: 'sawtooth', f0: 220, f1: 110, dur: 0.18, gain: 0.25 });
  }
  shield(pos) {
    if (!this.ready || !this.voice(400)) return;
    const { node } = this.out({ pos, gain: 0.7, verb: 0.2 });
    this.tone(node, { type: 'sawtooth', f0: 1600, f1: 240, dur: 0.22, gain: 0.35 });
    this.noise(node, { type: 'bandpass', f0: 4000, f1: 1200, q: 4, dur: 0.2, gain: 0.4 });
  }
  kill(pos, mine, me) {
    if (!this.ready) return;
    const { node } = this.out({ pos: mine || me ? null : pos, gain: 1.1, verb: 0.9, drive: true });
    this.tone(node, { f0: 75, f1: 24, dur: 1.4, gain: 1.0 });
    this.noise(node, { f0: 5000, f1: 90, dur: 1.6, gain: 1.0 });
    this.noise(node, { type: 'highpass', f0: 1800, dur: 0.12, gain: 0.8 });
    for (let i = 0; i < 12; i++) this.noise(node, { type: 'bandpass', f0: 800 + Math.random() * 4000, q: 2, t: 0.1 + Math.random() * 1.0, dur: 0.05, gain: 0.4 });
    if (mine) {   // kill confirm fanfare
      const { node: n2 } = this.out({ gain: 0.45 });
      [72, 76, 79, 84].forEach((m, i) => this.tone(n2, { type: 'square', f0: NOTE(m), t: 0.08 + i * 0.07, dur: 0.18, gain: 0.35 }));
      this.tone(n2, { type: 'sawtooth', f0: NOTE(48), t: 0.08, dur: 0.5, gain: 0.3 });
    }
    if (me) {     // you were destroyed: falling tone
      const { node: n3 } = this.out({ gain: 0.5 });
      this.tone(n3, { type: 'sawtooth', f0: 440, f1: 55, dur: 1.1, gain: 0.35, curve: 'lin' });
    }
  }
  jump(pos, own) {
    if (!this.ready || !this.voice(400)) return;
    const { node } = this.out({ pos: own ? null : pos, gain: own ? 0.5 : 0.45 });
    this.noise(node, { type: 'bandpass', f0: 500, f1: 2600, q: 1.5, dur: 0.28, gain: 0.6 });
    this.tone(node, { f0: 260, f1: 700, dur: 0.18, gain: 0.3 });
  }
  land(pos, own, k = 1) {
    if (!this.ready || !this.voice(300)) return;
    const { node } = this.out({ pos: own ? null : pos, gain: 0.55 * k, drive: true });
    this.tone(node, { f0: 130, f1: 45, dur: 0.2, gain: 0.9 });
    this.noise(node, { f0: 700, f1: 150, dur: 0.18, gain: 0.5 });
  }
  boost(pos, own, lvl) {
    if (!this.ready || !this.voice(900)) return;
    const { node } = this.out({ pos: own ? null : pos, gain: own ? 0.85 : 0.7, verb: 0.3, drive: true });
    const d = lvl >= 2 ? 0.75 : 0.5;
    this.noise(node, { type: 'bandpass', f0: 300, f1: 4200, q: 1.2, dur: d, gain: 0.8 });
    this.tone(node, { type: 'sawtooth', f0: lvl >= 2 ? 160 : 200, f1: lvl >= 2 ? 1400 : 900, dur: d * 0.8, gain: 0.35 });
    this.tone(node, { f0: 90, f1: 40, dur: 0.25, gain: 0.8 });
  }
  chargeTing(lvl) {
    if (!this.ready) return;
    const { node } = this.out({ gain: 0.4 });
    if (lvl === 1) this.tone(node, { type: 'triangle', f0: 1318, dur: 0.25, gain: 0.5 });
    else { this.tone(node, { type: 'triangle', f0: 1760, dur: 0.3, gain: 0.5 }); this.tone(node, { type: 'triangle', f0: 2637, t: 0.06, dur: 0.35, gain: 0.4 }); }
  }
  healSpawn() {
    if (!this.ready) return;
    const { node } = this.out({ gain: 0.4, verb: 0.6 });
    [79, 83, 86, 91].forEach((m, i) => this.tone(node, { type: 'triangle', f0: NOTE(m), t: i * 0.09, dur: 0.6, gain: 0.35 }));
  }
  heal(pos, mine) {
    if (!this.ready) return;
    const { node } = this.out({ pos: mine ? null : pos, gain: mine ? 0.6 : 0.5, verb: 0.5 });
    [72, 76, 79, 84, 88, 91].forEach((m, i) => this.tone(node, { type: 'sine', f0: NOTE(m), t: i * 0.045, dur: 0.4, gain: 0.35 }));
    this.noise(node, { type: 'highpass', f0: 6000, dur: 0.6, gain: 0.15, a: 0.05 });
  }
  respawn(pos, own) {
    if (!this.ready || !this.voice(900)) return;
    const { node } = this.out({ pos: own ? null : pos, gain: own ? 0.5 : 0.4, verb: 0.5 });
    this.tone(node, { type: 'sawtooth', f0: 180, f1: 900, dur: 0.6, gain: 0.25, curve: 'lin' });
    this.noise(node, { type: 'bandpass', f0: 300, f1: 3000, q: 2, dur: 0.6, gain: 0.35 });
    this.tone(node, { f0: NOTE(84), t: 0.55, dur: 0.4, gain: 0.3 });
  }
  // hit stop: muffle everything for a split second, then open up again, under a sub-bass hit
  impact() {
    if (!this.ready) return;
    const t = this.ctx.currentTime + this.at, f = this.duck.frequency;
    f.cancelScheduledValues(t); f.setValueAtTime(380, t); f.exponentialRampToValueAtTime(20000, t + 0.5);
    const { node } = this.out({ gain: 0.9, drive: true });
    this.tone(node, { f0: 62, f1: 28, dur: 0.6, gain: 1.0 });
    this.noise(node, { type: 'highpass', f0: 3000, t: 0.12, dur: 0.18, gain: 0.35 });
  }
  click() {
    if (!this.ready) return;
    const { node } = this.out({ gain: 0.25 });
    this.tone(node, { type: 'triangle', f0: 880, f1: 1100, dur: 0.06, gain: 0.4 });
  }
  horn() {           // match start / new game
    if (!this.ready) return;
    const { node } = this.out({ gain: 0.45, verb: 0.5 });
    for (const m of [48, 55, 60, 64]) this.tone(node, { type: 'sawtooth', f0: NOTE(m), a: 0.04, dur: 1.0, gain: 0.2 });
  }
  matchEnd(result) { // 'win' | 'lose' | 'draw'
    if (!this.ready) return;
    const { node } = this.out({ gain: 0.5, verb: 0.6 });
    const seq = result === 'win' ? [60, 64, 67, 72, 76, 79, 84] : result === 'lose' ? [67, 63, 60, 55, 51] : [60, 65, 67, 72];
    seq.forEach((m, i) => this.tone(node, { type: 'square', f0: NOTE(m), t: i * 0.11, dur: 0.32, gain: 0.25 }));
    if (result === 'win') for (const m of [48, 55, 64]) this.tone(node, { type: 'sawtooth', f0: NOTE(m), t: 0.77, a: 0.02, dur: 1.2, gain: 0.18 });
  }
  levelUp() {
    if (!this.ready) return;
    const { node } = this.out({ gain: 0.5, verb: 0.7 });
    const chords = [[60, 64, 67], [65, 69, 72], [67, 71, 74], [72, 76, 79, 84]];
    chords.forEach((ch, i) => ch.forEach((m) => this.tone(node, { type: i === 3 ? 'sawtooth' : 'square', f0: NOTE(m), t: i * 0.16, a: 0.01, dur: i === 3 ? 1.2 : 0.2, gain: 0.14 })));
    this.noise(node, { type: 'highpass', f0: 7000, t: 0.48, dur: 1.0, gain: 0.12, a: 0.05 });
  }

  // ------------------------------------------------------------------ sidearms / specials
  dash(pos, own) {
    if (!this.ready || !this.voice(600)) return;
    const { node } = this.out({ pos: own ? null : pos, gain: own ? 0.8 : 0.65, verb: 0.25, drive: true });
    this.noise(node, { type: 'bandpass', f0: 600, f1: 5200, q: 1.4, dur: 0.32, gain: 0.9 });
    this.tone(node, { type: 'sawtooth', f0: 320, f1: 1500, dur: 0.18, gain: 0.3 });
    this.tone(node, { f0: 120, f1: 50, dur: 0.18, gain: 0.7 });
  }
  shieldUp(pos, own) {
    if (!this.ready || !this.voice(700)) return;
    const { node } = this.out({ pos: own ? null : pos, gain: own ? 0.6 : 0.5, verb: 0.5 });
    this.tone(node, { type: 'sawtooth', f0: 220, f1: 1760, dur: 0.22, gain: 0.25 });
    this.tone(node, { type: 'triangle', f0: 1760, t: 0.18, dur: 0.5, gain: 0.3 });
    this.noise(node, { type: 'highpass', f0: 5000, dur: 0.4, gain: 0.2 });
  }
  reflect(pos, own) {   // perfect guard: bright "ting" + whoosh back
    if (!this.ready) return;
    const { node } = this.out({ pos: own ? null : pos, gain: own ? 0.8 : 0.6, verb: 0.7 });
    this.tone(node, { type: 'triangle', f0: 2637, dur: 0.5, gain: 0.55 });
    this.tone(node, { type: 'triangle', f0: 3951, t: 0.04, dur: 0.45, gain: 0.35 });
    this.tone(node, { type: 'square', f0: 1318, f1: 1320, dur: 0.12, gain: 0.2 });
    this.noise(node, { type: 'bandpass', f0: 5000, f1: 700, q: 2, t: 0.05, dur: 0.35, gain: 0.5 });
  }
  rico(pos) {
    if (!this.ready || !this.voice(300)) return;
    const { node } = this.out({ pos, gain: 0.55, verb: 0.3 });
    this.tone(node, { type: 'triangle', f0: 2400, f1: 900, dur: 0.22, gain: 0.45 });
    this.noise(node, { type: 'bandpass', f0: 3500, q: 3, dur: 0.08, gain: 0.5 });
  }
  minePlace(pos, own) {
    if (!this.ready || !this.voice(400)) return;
    const { node } = this.out({ pos: own ? null : pos, gain: own ? 0.5 : 0.35 });
    this.tone(node, { f0: 180, f1: 90, dur: 0.12, gain: 0.7 });
    this.tone(node, { type: 'square', f0: 1200, t: 0.12, dur: 0.06, gain: 0.15 });
    this.tone(node, { type: 'square', f0: 1600, t: 0.22, dur: 0.06, gain: 0.15 });
  }
  megaFire(pos, own) {
    if (!this.ready) return;
    const { node } = this.out({ pos: own ? null : pos, gain: own ? 1.1 : 1.0, verb: 0.8, drive: true });
    this.tone(node, { type: 'sawtooth', f0: 90, f1: 1800, dur: 0.25, gain: 0.25, curve: 'lin' });   // charge whine
    this.tone(node, { f0: 140, f1: 26, t: 0.02, dur: 0.8, gain: 1.0 });
    this.noise(node, { f0: 6000, f1: 180, t: 0.02, dur: 0.9, gain: 1.0 });
    this.noise(node, { type: 'highpass', f0: 2000, t: 0.02, dur: 0.12, gain: 0.8 });
  }
  bigBoom(pos, size = 1.6) {   // mega cannon / mine / slam: a bigger, longer boom
    if (!this.ready || !this.voice(1800)) return;
    const { node, g } = this.out({ pos, gain: 0.9 * Math.min(1.4, size), verb: 0.9, drive: true });
    if (g < 0.02) return;
    this.tone(node, { f0: 80, f1: 22, dur: 1.1 * size * 0.7, gain: 1.0 });
    this.noise(node, { f0: 4200, f1: 90, dur: 1.2 * size * 0.7, gain: 1.0 });
    for (let i = 0; i < 9; i++) this.noise(node, { type: 'bandpass', f0: 1000 + Math.random() * 3000, q: 3, t: 0.05 + Math.random() * 0.7, dur: 0.05, gain: 0.35 });
  }
  overdrive(pos, own) {
    if (!this.ready) return;
    const { node } = this.out({ pos: own ? null : pos, gain: own ? 0.75 : 0.55, verb: 0.6, drive: true });
    this.tone(node, { type: 'sawtooth', f0: 110, f1: 880, dur: 0.6, gain: 0.35, curve: 'lin' });
    this.tone(node, { type: 'sawtooth', f0: 165, f1: 1320, dur: 0.6, gain: 0.2, curve: 'lin' });
    this.noise(node, { type: 'bandpass', f0: 400, f1: 6000, q: 1, dur: 0.7, gain: 0.5 });
    if (own) [76, 83, 88].forEach((m, i) => this.tone(node, { type: 'square', f0: NOTE(m), t: 0.55 + i * 0.06, dur: 0.2, gain: 0.18 }));
  }
  strikeCall(pos, own, enemy) {   // radio beeps + rising siren (a warning for whoever is under it)
    if (!this.ready) return;
    const { node } = this.out({ pos: own ? null : pos, gain: enemy ? 0.8 : 0.55, verb: 0.4 });
    [0, 0.14].forEach((t) => this.tone(node, { type: 'square', f0: 1400, t, dur: 0.08, gain: 0.2 }));
    this.tone(node, { type: 'sawtooth', f0: 400, f1: 900, t: 0.3, dur: 0.9, gain: 0.18, curve: 'lin' });
  }
  bombWhistle(pos, dur) {
    if (!this.ready || !this.voice((dur + 0.1) * 1000)) return;
    const { node, g } = this.out({ pos, gain: 0.45, verb: 0.3 });
    if (g < 0.03) return;
    this.tone(node, { f0: 2200, f1: 500, dur, a: 0.05, gain: 0.25, curve: 'lin' });
  }
  slamJump(pos, own) {
    if (!this.ready || !this.voice(600)) return;
    const { node } = this.out({ pos: own ? null : pos, gain: own ? 0.7 : 0.55, verb: 0.3 });
    this.noise(node, { type: 'bandpass', f0: 300, f1: 3000, q: 1.2, dur: 0.45, gain: 0.7 });
    this.tone(node, { type: 'sawtooth', f0: 120, f1: 600, dur: 0.4, gain: 0.25 });
  }
  slam(pos, own) {
    if (!this.ready) return;
    const { node } = this.out({ pos: own ? null : pos, gain: 1.1, verb: 1.0, drive: true });
    this.tone(node, { f0: 70, f1: 18, dur: 1.2, gain: 1.0 });
    this.tone(node, { type: 'square', f0: 55, f1: 25, dur: 0.4, gain: 0.4 });
    this.noise(node, { f0: 2500, f1: 60, dur: 1.3, gain: 1.0 });
    this.noise(node, { type: 'highpass', f0: 1500, dur: 0.1, gain: 0.7 });
  }
  readyPing(kind) {   // your sidearm / special became ready again
    if (!this.ready) return;
    const { node } = this.out({ gain: 0.35 });
    if (kind === 'ult') [72, 79, 84, 91].forEach((m, i) => this.tone(node, { type: 'triangle', f0: NOTE(m), t: i * 0.06, dur: 0.35, gain: 0.35 }));
    else this.tone(node, { type: 'triangle', f0: NOTE(88), dur: 0.12, gain: 0.3 });
  }

  // ------------------------------------------------------------------ continuous: engine, drift screech, jet
  startEngine() {
    const c = this.ctx;
    this.eng = {};
    const out = c.createGain(); out.gain.value = 0; out.connect(this.sfx);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 3; lp.connect(out);
    const o1 = c.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 55;
    const o2 = c.createOscillator(); o2.type = 'square'; o2.frequency.value = 27.5;
    const g2 = c.createGain(); g2.gain.value = 0.5;
    const hum = c.createOscillator(); hum.type = 'sine'; hum.frequency.value = 110;
    const gh = c.createGain(); gh.gain.value = 0.35;
    o1.connect(lp); o2.connect(g2); g2.connect(lp); hum.connect(gh); gh.connect(out);
    for (const o of [o1, o2, hum]) o.start();
    // drift screech and boost jet: filtered noise loops
    const mk = (type, f, q) => {
      const s = c.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true;
      const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      const g = c.createGain(); g.gain.value = 0;
      s.connect(fl); fl.connect(g); g.connect(this.sfx); s.start();
      return { fl, g };
    };
    this.eng = { out, lp, o1, o2, hum, screech: mk('bandpass', 1200, 9), jet: mk('bandpass', 1600, 1.2) };
  }
  // called every frame with the local tank state
  engine({ alive, speed = 0, boost = 0, sliding = false, charge = 0, inGame = false }) {
    if (!this.ctx || !this.eng.out) return;
    const t = this.ctx.currentTime, e = this.eng, on = alive && inGame;
    const s = clamp(speed / 27, 0, 1);
    e.o1.frequency.setTargetAtTime(48 + s * 95 + (boost > 0 ? 40 : 0), t, 0.08);
    e.o2.frequency.setTargetAtTime(24 + s * 48, t, 0.08);
    e.hum.frequency.setTargetAtTime(105 + s * 40, t, 0.1);
    e.lp.frequency.setTargetAtTime(260 + s * 900 + (boost > 0 ? 1800 : 0), t, 0.08);
    e.out.gain.setTargetAtTime(on ? 0.1 + s * 0.12 : 0, t, 0.1);
    e.screech.fl.frequency.setTargetAtTime(900 + Math.min(1.5, charge) * 1100, t, 0.05);
    e.screech.g.gain.setTargetAtTime(on && sliding ? 0.16 + Math.min(1.3, charge) * 0.12 : 0, t, 0.04);
    e.jet.g.gain.setTargetAtTime(on && boost > 0 ? 0.35 : 0, t, 0.05);
  }
  setListener(x, y, z, yaw) { const L = this.listener; L.x = x; L.y = y; L.z = z; L.yaw = yaw; }

  // ------------------------------------------------------------------ music
  // a small step sequencer: drums, bass, arpeggio and pad over an Am-F-C-G loop.
  // modes: 'lobby' (calm), 'battle', 'result' (pad only); intense = last 30 s (faster, busier)
  setMusic(mode, intense = false) {
    const m = this.music;
    if (m.mode === mode && m.intense === intense) return;
    m.mode = mode; m.intense = intense;
    if (this.ctx && m.next < this.ctx.currentTime) m.next = this.ctx.currentTime + 0.05;
  }
  schedule() {
    const c = this.ctx, m = this.music;
    if (!c || c.state !== 'running' || m.mode === 'off') return;
    const bpm = m.mode === 'lobby' ? 100 : m.intense ? 152 : 136;
    const stepDur = 60 / bpm / 4;
    if (m.next < c.currentTime) m.next = c.currentTime + 0.05;
    while (m.next < c.currentTime + 0.15) { this.playStep(m.step, m.next, stepDur); m.next += stepDur; m.step = (m.step + 1) % 64; }
  }
  playStep(step, at, sd) {
    const c = this.ctx, m = this.music, b = this.bgm, i = step % 16, bar = Math.floor(step / 16);
    const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];   // Am F C G
    const ch = chords[bar];
    const t = (f) => Math.max(0, at - c.currentTime + f);
    const battle = m.mode === 'battle';
    const n = (opts) => this.noise(b, { ...opts, t: t(0) });
    if (battle) {
      if (i % 4 === 0) this.tone(b, { f0: 150, f1: 42, t: t(0), dur: 0.28, gain: 0.9 });                         // kick
      if (m.intense && i % 4 === 2 && Math.random() < 0.5) this.tone(b, { f0: 150, f1: 42, t: t(0), dur: 0.2, gain: 0.6 });
      if (i === 4 || i === 12) { n({ type: 'bandpass', f0: 1900, q: 0.7, dur: 0.18, gain: 0.55 }); this.tone(b, { type: 'triangle', f0: 210, f1: 150, t: t(0), dur: 0.1, gain: 0.35 }); }
      if (i % 2 === 0 || m.intense) n({ type: 'highpass', f0: 8000, dur: i % 4 === 2 ? 0.09 : 0.03, gain: i % 4 === 2 ? 0.22 : 0.12 });
      // driving bass (8ths, octave jumps)
      if (i % 2 === 0) this.tone(b, { type: 'sawtooth', f0: NOTE(ch[0] - 24 + (i % 4 === 2 ? 12 : 0)), t: t(0), dur: sd * 1.8, a: 0.005, gain: 0.32 });
      // arpeggio lead (into the delay)
      const arp = [0, 1, 2, 1, 0, 2, 1, 2];
      if (i % (m.intense ? 1 : 2) === 0) {
        const o = c.createGain(); o.gain.value = 1; o.connect(b); o.connect(this.delay);
        this.tone(o, { type: 'square', f0: NOTE(ch[arp[(i >> (m.intense ? 0 : 1)) % 8]] + 12 + (m.intense ? 12 : 0)), t: t(0), dur: sd * 1.4, gain: 0.07 });
      }
    }
    if (i === 0) {
      // pad (all modes): detuned saws through a soft lowpass
      const dur = sd * 16;
      for (const note of ch) for (const det of [-6, 6]) {
        const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = NOTE(note); o.detune.value = det;
        const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = battle ? 1100 : 750;
        const g = c.createGain(); const st = c.currentTime + t(0);
        g.gain.setValueAtTime(0.0001, st); g.gain.exponentialRampToValueAtTime(battle ? 0.035 : 0.05, st + 0.4); g.gain.setValueAtTime(battle ? 0.035 : 0.05, st + dur - 0.3); g.gain.exponentialRampToValueAtTime(0.0001, st + dur);
        o.connect(f); f.connect(g); g.connect(b); o.start(st); o.stop(st + dur + 0.05);
      }
      if (m.mode === 'lobby') this.tone(b, { type: 'triangle', f0: NOTE(ch[0] - 12), t: t(0), dur: sd * 8, a: 0.05, gain: 0.25 });
    }
    if (m.mode === 'lobby' && i % 4 === 2) {
      const o = c.createGain(); o.connect(b); o.connect(this.delay);
      this.tone(o, { type: 'triangle', f0: NOTE(ch[(i >> 2) % 3] + 12), t: t(0), dur: sd * 3, gain: 0.08 });
    }
  }
}
