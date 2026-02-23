// Service worker for OnePlay Music PWA.
// Cache-first for app shell assets; passthrough for all other requests
// (Graph API, audio CDN, OneDrive SAS-token URLs).
//
// INVARIANT: __DEPLOY_COUNTER__ is replaced by `npm run deploy` with the
// current value from deploy-counter.txt. This ensures every deploy produces
// a byte-different sw.js, triggering the browser's update lifecycle.

const CACHE_VERSION = '__DEPLOY_COUNTER__';
const CACHE_NAME = 'oneplay-music-' + CACHE_VERSION;

/** App shell assets to cache on install. Explicit list — no globs.
 *  Excludes source maps (.js.map) and test artifacts. */
const APP_SHELL = [
    './',
    './index.html',
    './theme.css',
    './index.css',
    './manifest.json',
    './assets/favicon.png',
    './assets/appicon.png',
    './assets/bigicon.png',
    './dist/index.js',
    './dist/auth.js',
    './dist/db.js',
    './dist/downloads.js',
    './dist/favorites.js',
    './dist/index-startup.js',
    './dist/index-sync.js',
    './dist/indexer.js',
    './dist/logger.js',
    './dist/logger-web.js',
    './dist/media-title.js',
    './dist/modal.js',
    './dist/path-names.js',
    './dist/playback-engine.js',
    './dist/playback-ui.js',
    './dist/playback.js',
    './dist/roots.js',
    './dist/search.js',
    './dist/select-dialogs.js',
    './dist/select.js',
    './dist/settings.js',
    './dist/shares.js',
    './dist/tracks.js',
    './dist/tree.js',
];

// Install: populate cache with app shell, then take over immediately.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

// Activate: evict old caches, claim clients so the new SW serves immediately.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((n) => n.startsWith('oneplay-music-') && n !== CACHE_NAME)
                    .map((n) => caches.delete(n))
            ))
            .then(() => self.clients.claim())
    );
});

// Fetch: cache-first for app shell, passthrough for everything else.
// Navigations always return cached index.html (handles OAuth ?code= redirects,
// query params, deep links).
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    if (event.request.mode === 'navigate') {
        // All navigations serve the cached index.html (single-page app).
        // Clone the cached response to strip any redirect status — a redirected
        // response used for a navigate request whose redirect mode isn't "follow"
        // causes a network error in some browsers/serve configurations.
        event.respondWith(
            caches.match('./index.html').then((cached) => {
                if (!cached) return fetch(event.request);
                if (cached.redirected) {
                    return new Response(cached.body, {
                        headers: cached.headers,
                        status: cached.status,
                        statusText: cached.statusText,
                    });
                }
                return cached;
            })
        );
        return;
    }

    // Subresources: on localhost, always fetch from network (dev needs fresh code).
    // In production, cache-first. API calls, audio URLs etc. are not in the
    // cache, so caches.match returns undefined and they fall through to fetch.
    const isLocalhost = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';
    if (isLocalhost) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request).then((c) => c || Promise.reject('offline')))
        );
    } else {
        event.respondWith(
            caches.match(event.request).then((cached) => cached || fetch(event.request))
        );
    }
});
