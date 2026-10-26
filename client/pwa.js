// PWA glue: service worker registration, "add to home screen" button, offline notice.
const $ = (id) => document.getElementById(id);

export const isInstalled = () =>
  matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function setupPwa({ onOffline } = {}) {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker not registered', e));
    });
  }

  const box = $('install'), btn = $('btn-install'), help = $('install-help');
  let deferred = null;
  if (!isInstalled()) {
    // Android / desktop Chrome & Edge: the browser offers a real install prompt
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      box.classList.remove('hidden');
    });
    // iOS / iPadOS: no prompt API, explain the share-sheet step instead
    if (isIOS()) {
      box.classList.remove('hidden');
      help.textContent = 'Safariの共有ボタン（□↑）→「ホーム画面に追加」で、アプリのように全画面で起動できます。';
    }
    btn.onclick = async () => {
      if (deferred) {
        deferred.prompt();
        const { outcome } = await deferred.userChoice.catch(() => ({}));
        deferred = null;
        if (outcome === 'accepted') box.classList.add('hidden');
      } else {
        help.classList.toggle('hidden');
      }
    };
    window.addEventListener('appinstalled', () => box.classList.add('hidden'));
  }

  // offline = the browser says so, or the last request to the server failed at the network level
  // (navigator.onLine alone stays true on Wi-Fi without internet)
  let reachable = true;
  const paint = () => onOffline?.(!navigator.onLine || !reachable);
  window.addEventListener('online', paint);
  window.addEventListener('offline', paint);
  paint();
  return { setReachable(v) { if (v !== reachable) { reachable = v; paint(); } } };
}
