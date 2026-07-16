/* Track Record service worker.
 * Scope: /trackrecord (registered narrowly from the game page only).
 * __VERSION__ and __PRECACHE__ are stamped at build time by the tr-sw
 * integration in astro.config.mjs (versioned by the content-hashed asset list).
 * Update strategy: skipWaiting + clients.claim, so a new deploy activates
 * promptly; combined with network-first HTML this avoids the stale-shell bug.
 */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL_CACHE = 'tr-shell-' + VERSION;
const DATA_CACHE = 'tr-data-' + VERSION;
const AUDIO_CACHE = 'tr-audio-v1';
const AUDIO_MAX = 50;
const SONGS_PATH = '/data/tr-songs.json';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    // allSettled so a single 404 cannot abort the whole install
    await Promise.allSettled(PRECACHE.map((u) => c.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      const staleShell = k.startsWith('tr-shell-') && k !== SHELL_CACHE;
      const staleData = k.startsWith('tr-data-') && k !== DATA_CACHE;
      return (staleShell || staleData) ? caches.delete(k) : Promise.resolve();
    }));
    await self.clients.claim();
  })());
});

function isHTML(req) {
  return req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
}

async function trimCache(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // HTML: network-first with cache fallback (deploys propagate immediately).
  if (isHTML(req)) {
    e.respondWith(
      fetch(req)
        .then((res) => { const cp = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, cp)); return res; })
        .catch(() => caches.match(req).then((m) => m || caches.match('/trackrecord')))
    );
    return;
  }

  // Song JSON: stale-while-revalidate.
  if (url.origin === self.location.origin && url.pathname === SONGS_PATH) {
    e.respondWith(caches.open(DATA_CACHE).then(async (c) => {
      const cached = await c.match(req);
      const net = fetch(req).then((res) => { c.put(req, res.clone()); return res; }).catch(() => cached);
      return cached || net;
    }));
    return;
  }

  // Audio clips: runtime cache-as-you-play, LRU-capped so offline replay works.
  if (/\.(m4a|aac|mp3)(\?|$)/i.test(url.pathname) || url.hostname.endsWith('itunes.apple.com')) {
    e.respondWith(caches.open(AUDIO_CACHE).then(async (c) => {
      const cached = await c.match(req);
      if (cached) {
        // move-to-most-recent for LRU ordering
        const cp = cached.clone();
        c.delete(req).then(() => c.put(req, cp)).catch(() => {});
        return cached;
      }
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) {
        await c.put(req, res.clone());
        trimCache(AUDIO_CACHE, AUDIO_MAX);
      }
      return res;
    }).catch(() => caches.match(req)));
    return;
  }

  // Hashed, immutable app assets: cache-first.
  if (url.origin === self.location.origin && url.pathname.startsWith('/_astro/')) {
    e.respondWith(caches.match(req).then((m) => m || fetch(req).then((res) => {
      const cp = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, cp)); return res;
    })));
    return;
  }
});
