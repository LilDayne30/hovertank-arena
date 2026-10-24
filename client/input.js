// Unified input: keyboard+mouse (pointer lock) and multi-touch (joystick + look pad + buttons).
// Everything is cleared on blur / visibility change / touchcancel so no input "sticks".

export class Input {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ui = ui;
    this.keys = new Set();
    this.moveX = 0; this.moveY = 0;    // screen-relative stick, y = forward
    this.lookDX = 0; this.lookDY = 0;  // accumulated look delta (radians) since last read
    this.fire = false; this.drift = false;
    this.jumpQueued = false;
    this.touchMode = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.mouseSens = 0.0025;
    this.touchSens = 0.0065;
    this.enabled = true;
    this.touches = new Map();   // identifier -> {role, x0, y0, x, y}
    this.bind();
  }

  reset() {
    this.keys.clear();
    this.moveX = this.moveY = 0;
    this.lookDX = this.lookDY = 0;
    this.fire = this.drift = false;
    this.jumpQueued = false;
    this.touches.clear();
    this.ui.stickKnob && (this.ui.stickBase.style.display = 'none');
    for (const b of [this.ui.btnFire, this.ui.btnJump, this.ui.btnDrift]) b?.classList.remove('down');
  }

  bind() {
    const clear = () => this.reset();
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
    window.addEventListener('pagehide', clear);

    // ---------------- keyboard / mouse
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.target.tagName === 'INPUT') return;
      const k = e.code;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
      if (k === 'Space' && !e.repeat) this.jumpQueued = true;
      this.keys.add(k);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    this.canvas.addEventListener('mousedown', (e) => {
      if (this.touchMode || !this.enabled) return;
      if (document.pointerLockElement !== this.canvas) { this.canvas.requestPointerLock?.(); return; }
      if (e.button === 0) this.fire = true;
      if (e.button === 2) this.drift = true;
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.fire = false; if (e.button === 2) this.drift = false; });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== this.canvas) { this.fire = false; this.drift = false; this.keys.clear(); }
      this.ui.onPointerLock?.(document.pointerLockElement === this.canvas);
    });
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.lookDX += e.movementX * this.mouseSens;
      this.lookDY += e.movementY * this.mouseSens;
    });

    // ---------------- touch
    const opts = { passive: false };
    const surface = this.ui.touchLayer;
    surface.addEventListener('touchstart', (e) => this.onTouchStart(e), opts);
    surface.addEventListener('touchmove', (e) => this.onTouchMove(e), opts);
    surface.addEventListener('touchend', (e) => this.onTouchEnd(e), opts);
    surface.addEventListener('touchcancel', (e) => this.onTouchEnd(e), opts);
    // stop page scroll / pinch zoom / double-tap zoom anywhere in the game
    document.addEventListener('touchmove', (e) => { if (!e.target.closest?.('.scrollable')) e.preventDefault(); }, opts);
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());
  }

  roleFor(target, x) {
    if (target.closest?.('#btn-fire')) return 'fire';
    if (target.closest?.('#btn-jump')) return 'jump';
    if (target.closest?.('#btn-drift')) return 'drift';
    return x < window.innerWidth * 0.42 ? 'stick' : 'look';
  }

  onTouchStart(e) {
    e.preventDefault();
    if (!this.enabled) return;
    for (const t of e.changedTouches) {
      const role = this.roleFor(t.target, t.clientX);
      // only one finger per role (extra fingers on the same role become look fingers)
      const taken = [...this.touches.values()].some((v) => v.role === role);
      const r = taken && role !== 'look' ? 'look' : role;
      this.touches.set(t.identifier, { role: r, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY });
      if (r === 'stick') {
        const b = this.ui.stickBase;
        b.style.display = 'block';
        b.style.left = `${t.clientX}px`; b.style.top = `${t.clientY}px`;
        this.ui.stickKnob.style.transform = 'translate(-50%,-50%)';
      }
      if (r === 'fire') { this.fire = true; this.ui.btnFire.classList.add('down'); }
      if (r === 'jump') { this.jumpQueued = true; this.ui.btnJump.classList.add('down'); }
      if (r === 'drift') { this.drift = true; this.ui.btnDrift.classList.add('down'); }
    }
  }

  onTouchMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const s = this.touches.get(t.identifier);
      if (!s) continue;
      const dx = t.clientX - s.x, dy = t.clientY - s.y;
      s.x = t.clientX; s.y = t.clientY;
      if (s.role === 'stick') {
        const R = 56;
        let vx = s.x - s.x0, vy = s.y - s.y0;
        const m = Math.hypot(vx, vy);
        if (m > R) { vx *= R / m; vy *= R / m; }
        this.moveX = vx / R; this.moveY = -vy / R;
        this.ui.stickKnob.style.transform = `translate(calc(-50% + ${vx}px), calc(-50% + ${vy}px))`;
      } else if (s.role === 'look' || s.role === 'fire') {
        // fire button doubles as an aim pad: hold it and drag to aim while shooting
        this.lookDX += dx * this.touchSens;
        this.lookDY += dy * this.touchSens;
      }
    }
  }

  onTouchEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const s = this.touches.get(t.identifier);
      if (!s) continue;
      this.touches.delete(t.identifier);
      if (s.role === 'stick') { this.moveX = this.moveY = 0; this.ui.stickBase.style.display = 'none'; }
      if (s.role === 'fire') { this.fire = false; this.ui.btnFire.classList.remove('down'); }
      if (s.role === 'jump') this.ui.btnJump.classList.remove('down');
      if (s.role === 'drift') { this.drift = false; this.ui.btnDrift.classList.remove('down'); }
    }
    // safety net: if the browser lost track of fingers, clear everything
    if (e.touches && e.touches.length === 0 && this.touches.size) this.reset();
  }

  // Called once per simulation tick.
  sample() {
    let mx = this.moveX, my = this.moveY;
    if (!this.touchMode || this.keys.size) {
      const k = this.keys;
      const kx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
      const ky = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
      if (kx || ky) { const m = Math.hypot(kx, ky); mx = kx / m; my = ky / m; }
    }
    const drift = this.drift || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const jump = this.jumpQueued; this.jumpQueued = false;
    return { mx, my, drift, jump, fire: this.fire || this.keys.has('KeyF') };
  }

  takeLook() {
    const r = [this.lookDX, this.lookDY];
    this.lookDX = this.lookDY = 0;
    return r;
  }
}
