// Bump this whenever the caching strategy changes; activate() purges older caches.
const CACHE_NAME = 'mgrains-shell-v4'
const APP_BASE = new URL('./', self.location.href).pathname
const SHELL_URLS = [APP_BASE, `${APP_BASE}manifest.webmanifest`, `${APP_BASE}mgrains-mark.svg`]

async function precache() {
  const cache = await caches.open(CACHE_NAME)
  await cache.addAll(SHELL_URLS)
  // Precache the content-hashed build assets (JS/CSS/worklet) listed in the
  // generated manifest. The SW activates after the first visit's assets have
  // already loaded, so without this they would not be cached until re-requested,
  // leaving the first offline load broken. Best-effort: a missing manifest (dev
  // build) or fetch failure still leaves the shell cached and assets fall back to
  // the runtime cache-first handler below.
  try {
    const response = await fetch(`${APP_BASE}precache-manifest.json`, { cache: 'no-store' })
    if (response.ok) {
      const assets = await response.json()
      if (Array.isArray(assets)) {
        await cache.addAll(assets.map((path) => `${APP_BASE}${path}`))
      }
    }
  } catch {
    // Offline precache of hashed assets is best-effort; ignore failures.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache())
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
    )),
  )
  self.clients.claim()
})

function cacheResponse(request, response) {
  if (response.ok) {
    const copy = response.clone()
    void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  if (new URL(request.url).origin !== self.location.origin) return

  // Network-first for navigations: a stale cached index.html points at hashed
  // asset URLs that no longer exist after a deploy, which renders a blank page.
  // Always try the network, refresh the cached shell, and fall back to cache offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => cacheResponse(request, response))
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match(APP_BASE))),
    )
    return
  }

  // Cache-first for everything else: built assets are content-hashed and immutable.
  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request).then((response) => cacheResponse(request, response))),
  )
})
