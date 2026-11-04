// Touch controls: the player can drag the on-screen buttons to where their fingers are.
// Positions are kept per device (localStorage) as the button's centre in fractions of the screen,
// so they follow the screen size. Default places come from the stylesheet (JUMP / DRIFT at the top
// right for the right index finger, FIRE / SUB / SP under the right thumb).
import { t as tr } from './i18n.js';

const KEY = 'ht-touch-layout';
export const LAYOUT_IDS = ['btn-fire', 'btn-jump', 'btn-drift', 'btn-side', 'btn-ult'];
const $ = (id) => document.getElementById(id);
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch { return {}; } };
const save = (v) => { try { if (Object.keys(v).length) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch { /* private mode: this visit only */ } };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function place(el, p) {
  if (!p) { for (const k of ['left', 'top', 'right', 'bottom', 'transform']) el.style[k] = ''; return; }
  el.style.left = `${(p.x * 100).toFixed(2)}%`; el.style.top = `${(p.y * 100).toFixed(2)}%`;
  el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'translate(-50%, -50%)';
}

export function applyTouchLayout() {
  const saved = load();
  for (const id of LAYOUT_IDS) { const el = $(id); if (el) place(el, saved[id]); }
}

// edit mode: buttons become draggable; "done" keeps the places, "reset" goes back to the defaults
export function editTouchLayout({ onStart, onEnd } = {}) {
  const bar = $('layout-bar');
  let saved = load();
  document.body.classList.add('layout-edit');
  bar.classList.remove('hidden');
  onStart?.();
  const drags = new Map();
  const down = (e) => {
    const el = e.currentTarget;
    e.preventDefault(); e.stopPropagation();
    el.setPointerCapture?.(e.pointerId);
    const r = el.getBoundingClientRect();
    drags.set(e.pointerId, { el, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2) });
    el.classList.add('dragging');
  };
  const move = (e) => {
    const d = drags.get(e.pointerId);
    if (!d) return;
    e.preventDefault();
    const W = innerWidth, H = innerHeight, half = d.el.offsetWidth / 2;
    const x = clamp(e.clientX - d.dx, half + 4, W - half - 4), y = clamp(e.clientY - d.dy, half + 4, H - half - 4);
    saved[d.el.id] = { x: x / W, y: y / H };
    place(d.el, saved[d.el.id]);
  };
  const up = (e) => { const d = drags.get(e.pointerId); if (!d) return; d.el.classList.remove('dragging'); drags.delete(e.pointerId); };
  const els = LAYOUT_IDS.map($).filter(Boolean);
  for (const el of els) { el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); }
  const finish = (keep) => {
    for (const el of els) { el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.classList.remove('dragging'); }
    if (keep) save(saved);
    applyTouchLayout();
    document.body.classList.remove('layout-edit');
    bar.classList.add('hidden');
    onEnd?.();
  };
  $('btn-layout-reset').onclick = () => { saved = {}; for (const el of els) place(el, null); };
  $('btn-layout-done').onclick = () => finish(true);
  $('btn-layout-cancel').onclick = () => finish(false);
  $('layout-hint').textContent = tr('ボタンをドラッグして、押しやすい位置に動かしてください');
}
