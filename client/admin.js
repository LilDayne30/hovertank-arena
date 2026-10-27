// Owner's statistics page. Reads /api/admin/summary with the admin key (kept in this browser only).
const $ = (id) => document.getElementById(id);
const KEY = 'ht-admin-key';
const store = { get: () => { try { return localStorage.getItem(KEY); } catch { return null; } }, set: (v) => { try { localStorage.setItem(KEY, v); } catch { /* ignore */ } }, del: () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } } };
let days = 30, data = null;
try { days = Number(localStorage.getItem('ht-admin-days')) || 30; } catch { /* ignore */ }

const KIND = {
  'quick-2': 'クイックマッチ 1対1', 'quick-3': 'クイックマッチ 3人', 'quick-4': 'クイックマッチ 4人', 'quick-team': 'クイックマッチ チーム戦',
  'private-ffa': 'プライベート 個人戦', 'private-team': 'プライベート チーム戦',
};
const fmt = (n, d = 0) => (n ?? 0).toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: d });
const md = (day) => { const [, m, d] = day.split('-'); return `${Number(m)}/${Number(d)}`; };
// minutes -> "12分" / "3.4時間"
const dur = (min) => (min < 60 ? `${fmt(min)}分` : `${fmt(min / 60, 1)}時間`);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

async function load() {
  const key = store.get();
  if (!key) { show('login'); return; }
  const r = await fetch(`/api/admin/summary?days=${days}`, { headers: { authorization: `Bearer ${key}` }, cache: 'no-store' }).catch(() => null);
  if (!r || r.status === 401) { store.del(); show('login'); $('login-err').textContent = r ? '鍵が違います' : '通信できませんでした'; return; }
  data = await r.json();
  show('dash');
  render();
}
function show(which) { $('login').classList.toggle('hidden', which !== 'login'); $('dash').classList.toggle('hidden', which !== 'dash'); }

$('login-form').onsubmit = (e) => { e.preventDefault(); const k = $('key').value.trim(); if (k) { store.set(k); $('login-err').textContent = ''; load(); } };
$('logout').onclick = () => { store.del(); data = null; $('key').value = ''; show('login'); };
$('reload').onclick = load;
document.querySelectorAll('#range button').forEach((b) => { b.onclick = () => { days = Number(b.dataset.d); try { localStorage.setItem('ht-admin-days', String(days)); } catch { /* ignore */ } load(); }; });
setInterval(() => { if (data && !document.hidden) load(); }, 60000);
addEventListener('resize', () => { clearTimeout(window.__rt); window.__rt = setTimeout(() => data && render(), 200); });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => data && render());

function render() {
  document.querySelectorAll('#range button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.d) === days)));
  $('updated').textContent = `日本時間・${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 更新（1分ごとに自動更新）`;
  const rows = data.rows, t = rows[rows.length - 1], y = rows[rows.length - 2] || {};
  const delta = (a, b) => { const d = (a || 0) - (b || 0); return d === 0 ? '昨日と同じ' : `昨日より <span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${fmt(d)}</span>`; };
  const tile = (k, v, d, cls = '') => `<div class="tile ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  $('tiles').innerHTML = [
    tile('いま遊んでいる人', fmt(data.live.humans), `部屋 ${fmt(data.live.rooms)}（うちクイックマッチ ${fmt(data.live.publicHumans)}人）`, 'live'),
    tile('今日 開いた人', fmt(t.opened), delta(t.opened, y.opened)),
    tile('今日 遊んだ人', fmt(t.played), delta(t.played, y.played)),
    tile('今日 はじめて遊んだ人', fmt(t.newPlayers), delta(t.newPlayers, y.newPlayers)),
    tile('今日の試合数', fmt(t.matches), delta(t.matches, y.matches)),
    tile('今日のプレイ時間', dur(t.minutes), `昨日 ${dur(y.minutes || 0)}`),
    tile('今日の同時接続ピーク', fmt(t.peak), `昨日 ${fmt(y.peak)}`),
  ].join('');

  const labels = rows.map((r) => md(r.day));
  const s1 = css('--series-1'), s2 = css('--series-2');
  $('lg-people').innerHTML = `<span><i style="background:${s1}"></i>開いた人</span><span><i style="background:${s2}"></i>遊んだ人</span>`;
  lineChart($('ch-people'), labels, [{ name: '開いた人', color: s1, values: rows.map((r) => r.opened) }, { name: '遊んだ人', color: s2, values: rows.map((r) => r.played) }]);
  barChart($('ch-matches'), labels, rows.map((r) => r.matches), { color: s1, unit: '試合' });
  barChart($('ch-minutes'), labels, rows.map((r) => Math.round(r.minutes)), { color: s1, fmtV: (v) => dur(v) });

  const buckets = Array.from({ length: 10 }, (_, i) => data.levels.slice(i * 5, i * 5 + 5).reduce((a, b) => a + b, 0));
  barChart($('ch-levels'), buckets.map((_, i) => `${i * 5 + 1}-${i * 5 + 5}`), buckets, { color: s1, unit: '人', xTitle: 'Lv' });
  const T = data.totals;
  $('totals').innerHTML = `<span>遊んだことのある人 <b>${fmt(T.players)}</b></span><span>直近7日に遊んだ人 <b>${fmt(T.active7)}</b></span><span>2日以上遊んだ人 <b>${fmt(T.returning)}</b>${T.players ? `（${fmt((T.returning / T.players) * 100)}%）` : ''}</span>`;

  // match breakdown over the selected period
  const kinds = {}; let matches = 0, hs = 0, bs = 0;
  for (const r of rows) { matches += r.matches; hs += r.humanSlots; bs += r.botSlots; for (const [k, n] of Object.entries(r.kinds || {})) kinds[k] = (kinds[k] || 0) + n; }
  $('kinds-sub').textContent = `直近${days}日・合計 ${fmt(matches)} 試合`;
  const kr = Object.entries(kinds).sort((a, b) => b[1] - a[1]);
  $('kinds').innerHTML = `<tr><th>種類</th><th>試合数</th><th>割合</th></tr>${kr.map(([k, n]) => `<tr><td>${KIND[k] || k}</td><td>${fmt(n)}</td><td>${fmt((n / matches) * 100)}%</td></tr>`).join('') || '<tr><td colspan="3" class="empty">まだ試合がありません</td></tr>'}`
    + (matches ? `<tr><td>1試合あたりの人</td><td colspan="2">${fmt(hs / matches, 1)} 人</td></tr><tr><td>席のうちCPUの割合</td><td colspan="2">${fmt((bs / Math.max(1, hs + bs)) * 100)}%</td></tr>` : '');

  $('daily').innerHTML = `<tr><th>日付</th><th>開いた人</th><th>遊んだ人</th><th>はじめて遊んだ</th><th>初回起動</th><th>試合</th><th>プレイ時間</th><th>同時ピーク</th><th>ミッション達成</th><th>称号獲得</th></tr>`
    + [...rows].reverse().map((r) => `<tr><td>${r.day}</td><td>${fmt(r.opened)}</td><td>${fmt(r.played)}</td><td>${fmt(r.newPlayers)}</td><td>${fmt(r.newProfiles)}</td><td>${fmt(r.matches)}</td><td>${dur(r.minutes)}</td><td>${fmt(r.peak)}</td><td>${fmt(r.missions)}</td><td>${fmt(r.titles)}</td></tr>`).join('');
}

// ------------------------------------------------------------------ charts (plain SVG)
let W = 640; const H = 220, M = { l: 38, r: 54, t: 12, b: 26 };
// axis top = 4 equal steps of a round size (1, 2, 5 x 10^k), so tick labels stay whole numbers
function niceMax(v) { const raw = Math.max(1, v / 4), p = 10 ** Math.floor(Math.log10(raw)), n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p * 4; }
function axes(max, labels, xTitle) {
  const g = css('--grid'), mu = css('--text-muted'), iw = W - M.l - M.r, ih = H - M.t - M.b;
  let s = '';
  for (let i = 0; i <= 4; i++) {
    const y = M.t + ih - (ih * i) / 4, v = (max * i) / 4;
    s += `<line x1="${M.l}" x2="${W - M.r}" y1="${y}" y2="${y}" stroke="${g}" stroke-width="1"/>`;
    s += `<text x="${M.l - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="${mu}">${fmt(v, v % 1 ? 1 : 0)}</text>`;
  }
  const step = Math.max(1, Math.ceil(labels.length / (W > 800 ? 12 : 7)));
  labels.forEach((l, i) => {
    const last = labels.length - 1;
    if (i !== last && (i % step || last - i < step * 0.6)) return;   // keep the last date, skip one too close to it
    const x = M.l + (labels.length === 1 ? iw / 2 : (iw * (i + 0.5)) / labels.length);
    s += `<text x="${x}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${mu}">${l}</text>`;
  });
  if (xTitle) s += `<text x="${W - M.r + 8}" y="${H - 8}" font-size="11" fill="${mu}">${xTitle}</text>`;
  return s;
}
function tipEl(host) { let t = host.querySelector('.tip'); if (!t) { t = document.createElement('div'); t.className = 'tip'; host.appendChild(t); } return t; }
function placeTip(host, tip, px, py, html) {
  tip.innerHTML = html; tip.style.opacity = '1';
  const r = host.getBoundingClientRect(), tw = tip.offsetWidth;
  tip.style.left = `${Math.min(r.width - tw - 4, Math.max(4, px + 12))}px`; tip.style.top = `${Math.max(0, py - 40)}px`;
}

function lineChart(host, labels, series) {
  W = Math.max(320, Math.min(1000, host.clientWidth || 640));   // 1 SVG unit ~ 1 CSS px: text stays readable
  const iw = W - M.l - M.r, ih = H - M.t - M.b, n = labels.length;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const X = (i) => M.l + (n === 1 ? iw / 2 : (iw * (i + 0.5)) / n), Y = (v) => M.t + ih - (ih * v) / max;
  const surf = css('--surface-1'), tp = css('--text-secondary');
  let s = axes(max, labels);
  for (const sr of series) {
    s += `<polyline fill="none" stroke="${sr.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${sr.values.map((v, i) => `${X(i)},${Y(v)}`).join(' ')}"/>`;
    const li = n - 1;
    s += `<circle cx="${X(li)}" cy="${Y(sr.values[li])}" r="4" fill="${sr.color}" stroke="${surf}" stroke-width="2"/>`;
  }
  // direct labels at the line ends (nudged apart when they collide)
  const ends = series.map((sr) => ({ sr, y: Y(sr.values[n - 1]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  for (const e of ends) s += `<text x="${X(n - 1) + 8}" y="${e.y + 4}" font-size="11" fill="${tp}">${e.sr.name} ${fmt(e.sr.values[n - 1])}</text>`;
  s += `<line class="xh" x1="0" x2="0" y1="${M.t}" y2="${M.t + ih}" stroke="${css('--text-muted')}" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>`;
  s += `<rect x="${M.l}" y="${M.t}" width="${iw}" height="${ih}" fill="transparent" class="hit"/>`;
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="日別の人数の折れ線グラフ">${s}</svg>`;
  const svg = host.querySelector('svg'), xh = svg.querySelector('.xh'), tip = tipEl(host);
  const move = (ev) => {
    const r = svg.getBoundingClientRect(), sx = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((sx - M.l) / iw) * n - 0.5)));
    xh.setAttribute('x1', X(i)); xh.setAttribute('x2', X(i)); xh.setAttribute('opacity', '1');
    placeTip(host, tip, (X(i) / W) * r.width, ((M.t + 20) / H) * r.height, `${labels[i]}<br>${series.map((sr) => `<i style="background:${sr.color}"></i>${sr.name} <b>${fmt(sr.values[i])}</b>`).join('<br>')}`);
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerleave', () => { xh.setAttribute('opacity', '0'); tip.style.opacity = '0'; });
}

function barChart(host, labels, values, { color, unit = '', digits = 0, xTitle, fmtV } = {}) {
  W = Math.max(320, Math.min(1000, host.clientWidth || 640));
  const iw = W - M.l - M.r, ih = H - M.t - M.b, n = labels.length;
  const max = niceMax(Math.max(digits ? 0.5 : 1, ...values));
  const slot = iw / n, bw = Math.max(2, Math.min(28, slot - 2));
  const Y = (v) => M.t + ih - (ih * v) / max;
  let s = axes(max, labels, xTitle);
  values.forEach((v, i) => {
    const x = M.l + slot * i + (slot - bw) / 2, y = Y(v), h = M.t + ih - y;
    if (h > 0) {
      const r = Math.min(4, bw / 2, h);
      s += `<path d="M${x},${M.t + ih} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${M.t + ih} Z" fill="${color}"/>`;
    }
    s += `<rect x="${M.l + slot * i}" y="${M.t}" width="${slot}" height="${ih}" fill="transparent" data-i="${i}"/>`;
  });
  const mi = values.indexOf(Math.max(...values));
  if (values[mi] > 0) s += `<text x="${M.l + slot * mi + slot / 2}" y="${Y(values[mi]) - 5}" text-anchor="middle" font-size="11" fill="${css('--text-secondary')}">${fmtV ? fmtV(values[mi]) : fmt(values[mi], digits)}</text>`;
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="棒グラフ">${s}</svg>`;
  const svg = host.querySelector('svg'), tip = tipEl(host);
  svg.querySelectorAll('rect[data-i]').forEach((el) => {
    el.addEventListener('pointerenter', () => {
      const i = Number(el.dataset.i), r = svg.getBoundingClientRect();
      placeTip(host, tip, ((M.l + slot * i + slot / 2) / W) * r.width, (Y(values[i]) / H) * r.height, `${labels[i]}${xTitle ? ` ${xTitle}` : ''}<br>${fmtV ? `<b>${fmtV(values[i])}</b>` : `<b>${fmt(values[i], digits)}</b> ${unit}`}`);
    });
  });
  svg.addEventListener('pointerleave', () => { tip.style.opacity = '0'; });
}

load();
