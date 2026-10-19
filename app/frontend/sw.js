const VERSION = 'v1.0.8-20261019001';
const CORE_CACHE = `core-${VERSION}`;
const RUNTIME_CACHE = `rt-${VERSION}`;
const LEGACY_PROTECTED_MEDIA_CACHES = [
  'rt-v1.0.4-20260224001',
  'rt-v1.0.5-20260822001',
  'rt-v1.0.6-20260822001',
];
const PROTECTED_PATH_PREFIXES = ['/pdfs/', '/videos/', '/recordings/', '/note-images/'];
const NETWORK_ONLY_PREFIXES = [
  '/articles',
  '/media',
  '/class-notes',
  '/api',
  '/auth',
  '/users',
  '/documents',
];

const CORE_ASSETS = [
  './mobile-power.html',
  './mobile-styles.css',
  './shared/dictionary-util.js',
  './manifest.json'
];

function canCacheResponse(response) {
  if (!response || response.status !== 200) return false;
  const control = response.headers?.get?.('cache-control') || '';
  return !/(?:^|,)\s*(?:private|no-store)(?:\s*(?:=|,|$))/i.test(control);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CORE_CACHE).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => (
      LEGACY_PROTECTED_MEDIA_CACHES.includes(k)
      || ((k.startsWith('core-') || k.startsWith('rt-')) && k !== CORE_CACHE && k !== RUNTIME_CACHE)
    ) ? caches.delete(k) : null))).then(() => self.clients.claim())
  );
});

// Simple runtime caching: network-first for HTML and JS; cache-first for other assets; special case TTS
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  if (
    req.headers.get('authorization')
    || url.searchParams.has('token')
    || PROTECTED_PATH_PREFIXES.some(prefix => url.pathname.startsWith(prefix))
  ) {
    event.respondWith(fetch(req));
    return;
  }

  // Do not cache Range requests (video/audio partial content); Cache API does not support 206 responses.
  if (req.headers.get('range')) {
    event.respondWith(fetch(req));
    return;
  }

  // Avoid caching large media files; rely on HTTP caching instead.
  if (req.destination === 'video' || req.destination === 'audio' || /\.(mp4|webm|mp3|wav|m4a|ogg)$/i.test(url.pathname)) {
    event.respondWith(fetch(req));
    return;
  }

  // Never cache admin/API routes (they change frequently and must be real-time)
  if (
    url.pathname.startsWith('/admin/')
    || NETWORK_ONLY_PREFIXES.some((prefix) => (
      url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)
    ))
  ) {
    event.respondWith(fetch(req));
    return;
  }

  // Cache API: TTS JSON responses only
  if (url.pathname.startsWith('/tts/generate')) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        try {
          const fresh = await fetch(req);
          if (canCacheResponse(fresh)) {
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch (_) {
          const cached = await cache.match(req);
          if (cached) return cached; throw _;
        }
      })
    );
    return;
  }

  // JavaScript files: ALWAYS network-first, never cache (to avoid stale code)
  if (url.pathname.endsWith('.js')) {
    event.respondWith(fetch(req));
    return;
  }

  // HTML: network-first
  if (req.headers.get('accept') && req.headers.get('accept').includes('text/html')) {
    event.respondWith(
      fetch(req).then((res) => {
        if (canCacheResponse(res)) {
          const copy = res.clone(); caches.open(CORE_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Static assets (CSS, images, etc.): cache-first
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (canCacheResponse(res)) {
        const copy = res.clone(); caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
