// BridgeUp Service Worker
// Strategy:
//   - App shell (HTML, JS, CSS, fonts): cache-first + background revalidate
//   - API calls (/api/*): network-only (never serve stale data)
//   - Map tiles (cartocdn, openstreetmap): network-only (too large to cache)
//   - Everything else: network-first with cache fallback

const CACHE = 'bridgeup-v2'; // bump version to invalidate old cached assets

const PRECACHE = [
  '/',
  '/index.html',
];

// ── Install: pre-cache the app shell ─────────────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE))
  );
  // Take control immediately — don't wait for old SW to die
  self.skipWaiting();
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // 1. Never intercept non-GET requests
  if (request.method !== 'GET') return;

  // 2. Never cache API calls — always fresh data
  if (url.pathname.startsWith('/api/')) return;

  // Matches a host exactly, or as a subdomain of it. `includes()` would also match an
  // attacker-controlled host that merely CONTAINS the name — `unpkg.com.example.net` — so the
  // rule below would silently apply to the wrong origin.
  const isHost = (hostname, domain) => hostname === domain || hostname.endsWith('.' + domain);

  // 3. Never cache map tiles (CartoDB, OSM, Leaflet CDN)
  // tile.openstreetmap.org is covered by the openstreetmap.org subdomain match.
  if (
    ['cartocdn.com', 'openstreetmap.org', 'unpkg.com'].some((d) => isHost(url.hostname, d))
  ) return;

  // 4. Never cache Google Fonts network requests (they self-cache via their own SW)
  if (['fonts.googleapis.com', 'fonts.gstatic.com'].some((d) => isHost(url.hostname, d))) return;

  // 5. Navigation requests (HTML pages): network-first, fall back to cached shell
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 6. Static assets (JS, CSS, SVG, images): cache-first, background revalidate
  e.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(request, clone));
        }
        return res;
      });
      // Return cached immediately if available, update in background
      return cached || network;
    })
  );
});
