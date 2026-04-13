'use strict';

// ─── Cache versioning ─────────────────────────────────────────────────────────
// Increment CACHE_VERSION to bust all cached assets on the next visit.
const CACHE_VERSION = 'v2';
const CACHE_NAME    = 'bridgeup-' + CACHE_VERSION;

// ─── Static assets to pre-cache on install ───────────────────────────────────
const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  '/css/styles.css',
  // Leaflet and MarkerCluster are served locally so they are available offline
  // and are never routed through the CDN (which may be blocked in some envs).
  '/lib/leaflet.min.css',
  '/lib/MarkerCluster.min.css',
  '/lib/MarkerCluster.Default.min.css',
  '/lib/leaflet.min.js',
  '/lib/leaflet.markercluster.min.js',
  '/js/app.js',
  '/js/map.js',
  '/js/chat.js',
  '/js/voice.js',
  '/images/icon-192.png',
  '/images/icon-512.png',
];

// ─── CartoDB tile cache ───────────────────────────────────────────────────────
const TILE_CACHE_NAME = 'bridgeup-tiles-' + CACHE_VERSION;
const TILE_CACHE_MAX  = 500;

// ─── IndexedDB constants ──────────────────────────────────────────────────────
const IDB_NAME    = 'bridgeup-offline';
const IDB_VERSION = 1;
const IDB_STORE   = 'pending_submissions';

// ─── Offline-queue paths (POST only) ─────────────────────────────────────────
const QUEUE_PATHS = ['/api/needs', '/api/reviews/submit'];

// =============================================================================
// INSTALL — pre-cache static shell; partial failure is allowed
// =============================================================================
self.addEventListener('install', (event) => {
  // Skip the waiting phase immediately so the new SW version activates and
  // takes control without requiring a full browser close/reopen cycle.
  // This is safe here because we bust the cache by incrementing CACHE_VERSION.
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll is all-or-nothing, so we cache each URL individually so that
      // one missing asset does not block the entire install.
      const results = PRECACHE_URLS.map((url) =>
        cache.add(url).catch((err) => {
          console.warn('[SW] Pre-cache failed for', url, err.message);
        })
      );
      return Promise.all(results);
    })
  );
});

// =============================================================================
// ACTIVATE — claim all clients immediately; delete stale caches
// =============================================================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Take control of all open pages without requiring a reload
      self.clients.claim(),

      // Remove every cache that does not belong to this version
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key !== CACHE_NAME && key !== TILE_CACHE_NAME
            )
            .map((key) => {
              console.log('[SW] Deleting stale cache:', key);
              return caches.delete(key);
            })
        )
      ),
    ])
  );
});

// =============================================================================
// FETCH — three routing strategies
// =============================================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Strategy 3: Network-first for all /api/ requests ─────────────────────
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // ── Strategy 2: Cache-first with size cap for CartoDB map tiles ───────────
  // Exact-match the apex domain and its letter subdomains (a–d).
  // hostname.includes() is intentionally NOT used — a subdomain like
  // "attacker-basemaps.cartocdn.com.evil.com" would pass an includes() check
  // and allow attacker-controlled content into the tile cache.
  const isCartoTile =
    url.hostname === 'basemaps.cartocdn.com' ||
    url.hostname.endsWith('.basemaps.cartocdn.com');

  if (isCartoTile) {
    event.respondWith(tileFirst(request));
    return;
  }

  // ── Strategy 1: Cache-first for static asset extensions + /images/ ────────
  const isStaticAsset =
    /\.(css|js|png|jpg|jpeg|svg|woff2|woff)(\?.*)?$/.test(url.pathname) ||
    url.pathname.startsWith('/images/');

  if (isStaticAsset) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // All other requests (HTML navigation etc.) — network with cache fallback
  event.respondWith(networkFirst(request));
});

// -----------------------------------------------------------------------------
// Strategy 1 — Cache-first, background update
// Serves the cached copy immediately; refreshes the cache entry in background.
// -----------------------------------------------------------------------------
async function cacheFirst(request) {
  const cache    = await caches.open(CACHE_NAME);
  const cached   = await cache.match(request);
  const fetchAndUpdate = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || (await fetchAndUpdate) || new Response('Offline', { status: 503 });
}

// -----------------------------------------------------------------------------
// Strategy 2 — CartoDB tile cache-first with a 500-tile LRU cap
// -----------------------------------------------------------------------------
async function tileFirst(request) {
  const cache  = await caches.open(TILE_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      // Enforce maximum tile count before storing a new one
      await evictOldestTiles(cache);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Tile unavailable offline', { status: 503 });
  }
}

async function evictOldestTiles(cache) {
  const keys = await cache.keys();
  if (keys.length >= TILE_CACHE_MAX) {
    // Delete oldest entries (keys are returned in insertion order by the spec)
    const excess = keys.length - TILE_CACHE_MAX + 1;
    await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
  }
}

// -----------------------------------------------------------------------------
// Strategy 3 — Network-first; on failure return 503 or queue the request
// For POST /api/needs and POST /api/reviews/submit, a network failure while
// offline enqueues the request body in IndexedDB for later sync replay.
// -----------------------------------------------------------------------------
async function networkFirst(request) {
  try {
    const response = await fetch(request.clone());
    return response;
  } catch (err) {
    // Only queue eligible offline POST requests
    const url    = new URL(request.url);
    const isPost = request.method === 'POST';
    const shouldQueue = isPost && QUEUE_PATHS.some((p) => url.pathname.startsWith(p));

    if (shouldQueue) {
      await enqueueSubmission(request);
      return new Response(
        JSON.stringify({
          queued: true,
          message: 'You are offline. Your submission has been saved and will be sent automatically when you reconnect.',
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'You appear to be offline. Please check your connection and try again.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// =============================================================================
// INDEXEDDB — offline submission queue
// =============================================================================
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        // Auto-increment key so each queued item has a unique id
        db.createObjectStore(IDB_STORE, { autoIncrement: true });
      }
    };

    req.onsuccess  = (event) => resolve(event.target.result);
    req.onerror    = (event) => reject(event.target.error);
  });
}

// Maximum body size we will store in IndexedDB (100 KB).
// The Express server enforces a 1 MB body limit, so anything larger would be
// rejected on replay anyway. This prevents a buggy or crafted request from
// exhausting the browser's IndexedDB storage quota.
const MAX_QUEUE_BODY_BYTES = 100 * 1024;

// Maximum number of pending submissions to hold in IDB.
// Without a cap, repeated offline taps of Submit could queue dozens of entries
// that all replay simultaneously on reconnect, amplifying server-side load.
const MAX_QUEUE_DEPTH = 20;

// Allowlist of headers stored with each queued submission.
// Storing all headers via forEach() would automatically persist any future
// credential header (e.g. cookies, custom tokens) added to requests.
// We keep only the two headers the server actually needs for replay.
const STORED_HEADERS = ['authorization', 'content-type'];

async function enqueueSubmission(request) {
  try {
    const url    = request.url;
    const method = request.method;

    // Build header map from explicit allowlist — never store all headers
    const headers = {};
    for (const name of STORED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }

    const body = await request.text();

    if (body.length > MAX_QUEUE_BODY_BYTES) {
      console.warn('[SW] Submission body exceeds size limit (' + body.length + ' bytes) — not queued for offline replay');
      return;
    }

    const db = await openIDB();

    // Enforce queue depth cap before writing
    const currentDepth = await new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE, 'readonly');
      const req   = tx.objectStore(IDB_STORE).count();
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });

    if (currentDepth >= MAX_QUEUE_DEPTH) {
      console.warn('[SW] Offline queue is full (' + currentDepth + ' entries) — submission not queued');
      return;
    }

    const entry = { url, method, headers, body, queuedAt: Date.now() };

    await new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req   = store.add(entry);
      req.onsuccess = resolve;
      req.onerror   = (e) => reject(e.target.error);
    });

    console.log('[SW] Queued offline submission for', url);
  } catch (err) {
    console.error('[SW] Failed to enqueue submission:', err.message);
  }
}

async function getAllQueuedSubmissions() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(IDB_STORE, 'readonly');
    const store   = tx.objectStore(IDB_STORE);
    const entries = [];
    const cursor  = store.openCursor();

    cursor.onsuccess = (event) => {
      const c = event.target.result;
      if (c) {
        entries.push({ key: c.key, value: c.value });
        c.continue();
      } else {
        resolve(entries);
      }
    };
    cursor.onerror = (event) => reject(event.target.error);
  });
}

async function deleteQueuedSubmission(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req   = store.delete(key);
    req.onsuccess = resolve;
    req.onerror   = (e) => reject(e.target.error);
  });
}

// =============================================================================
// BACKGROUND SYNC — replay queued submissions when connectivity returns
// Safari does not support Background Sync; guard with feature detection.
// =============================================================================
if ('sync' in self.registration) {
  self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-submissions') {
      event.waitUntil(replayQueuedSubmissions());
    }
  });
}

async function replayQueuedSubmissions() {
  let entries;
  try {
    entries = await getAllQueuedSubmissions();
  } catch (err) {
    console.error('[SW] Failed to read offline queue:', err.message);
    return;
  }

  for (const { key, value } of entries) {
    try {
      const response = await fetch(value.url, {
        method:  value.method,
        headers: value.headers,
        body:    value.body,
      });

      if (response.ok) {
        await deleteQueuedSubmission(key);
        console.log('[SW] Replayed queued submission:', value.url);
      } else {
        // Non-network error (e.g. 400/401) — remove from queue so it does
        // not replay forever; the user will need to re-submit.
        console.warn('[SW] Queued submission rejected by server (', response.status, ') — removing from queue:', value.url);
        await deleteQueuedSubmission(key);
      }
    } catch (err) {
      // Still offline — keep in queue, sync will retry automatically
      console.warn('[SW] Still offline during sync replay for', value.url, '— will retry');
    }
  }
}

// =============================================================================
// PUSH NOTIFICATIONS
// Safari (iOS 16.4+) supports Push API behind a permission prompt.
// Guard with feature detection so older Safari versions fail gracefully.
// =============================================================================
if ('PushManager' in self) {
  self.addEventListener('push', (event) => {
    try {
      let message = 'You have a new BridgeUp notification.';

      if (event.data) {
        try {
          const payload = event.data.json();
          const raw = payload.message || payload.body || message;
          // Truncate to 200 chars — prevents notification-body injection via
          // a crafted push payload that sends a multi-kilobyte message string.
          message = String(raw).slice(0, 200);
        } catch {
          // data is plain text, not JSON
          const raw = event.data.text() || message;
          message = String(raw).slice(0, 200);
        }
      }

      const options = {
        body:              message,
        icon:              '/images/icon-192.png',
        badge:             '/images/icon-192.png',
        vibrate:           [200, 100, 200],
        requireInteraction: false,
        data:              { timestamp: Date.now() },
      };

      event.waitUntil(
        self.registration.showNotification('BridgeUp', options)
      );
    } catch (err) {
      console.error('[SW] Push notification error:', err.message);
    }
  });
}
