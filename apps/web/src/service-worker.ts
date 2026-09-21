import { CACHE_NAME, OFFLINE_FALLBACK_URL, PRECACHE_URLS, shouldCacheStaticAsset, shouldHandleNavigation } from "./pwa/offline"

/**
 * Static shell service worker.
 *
 * It caches the explicitly listed public shell files plus the built bundle under
 * `/assets`, and it never intercepts API, authentication, or socket traffic.
 * There is no background queue: offline requests either resolve from the cache,
 * fall back to the offline screen, or fail.
 */

const scope = globalThis as unknown as {
  addEventListener: (type: string, listener: (event: never) => void) => void
  skipWaiting: () => void
  clients: { claim: () => void }
  location: { origin: string }
}

scope.addEventListener("install", ((
  event: { waitUntil: (promise: Promise<unknown>) => void },
) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([...PRECACHE_URLS])).then(() => scope.skipWaiting()),
  )
}) as never)

scope.addEventListener("activate", ((event: { waitUntil: (promise: Promise<unknown>) => void }) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => scope.clients.claim()),
  )
}) as never)

scope.addEventListener("fetch", ((event: FetchEvent) => {
  const request = event.request
  if (shouldHandleNavigation({ url: request.url, method: request.method, mode: request.mode })) {
    event.respondWith(navigationResponse(request))
    return
  }
  if (shouldCacheStaticAsset({ url: request.url, method: request.method, mode: request.mode, destination: request.destination }, scope.location.origin)) {
    event.respondWith(cacheFirst(request))
  }
}) as never)

async function navigationResponse(request: Request): Promise<Response> {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME)
      await cache.put("/", response.clone())
    }
    return response
  } catch {
    const cached = (await caches.match("/", { ignoreSearch: true })) ?? (await caches.match(OFFLINE_FALLBACK_URL))
    return cached ?? new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } })
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const cached = await caches.match(request, { ignoreSearch: true })
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME)
    await cache.put(request, response.clone())
  }
  return response
}
