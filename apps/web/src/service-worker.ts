import { CACHE_NAME, CACHE_PREFIX, OFFLINE_FALLBACK_URL, PRECACHE_URLS, shouldCacheStaticAsset, shouldHandleNavigation } from "./pwa/offline"

/**
 * Static shell service worker.
 *
 * It caches the explicitly listed public shell files plus the built bundle under
 * `/assets`, and it never intercepts API, authentication, or socket traffic.
 * There is no background queue: offline requests either resolve from the cache,
 * fall back to the offline screen, or fail.
 */

const scope = globalThis as unknown as {
  addEventListener: {
    (type: "install" | "activate", listener: (event: { waitUntil: (promise: Promise<unknown>) => void }) => void): void
    (type: "fetch", listener: (event: FetchEvent) => void): void
    (type: "push", listener: (event: { data?: { json: () => unknown }; waitUntil: (promise: Promise<unknown>) => void }) => void): void
    (type: "notificationclick", listener: (event: { notification: { data?: unknown; close: () => void }; waitUntil: (promise: Promise<unknown>) => void }) => void): void
    (type: "pushsubscriptionchange", listener: (event: { newSubscription?: { endpoint: string; getKey: (name: "p256dh" | "auth") => ArrayBuffer | null };
      oldSubscription?: { endpoint: string }; waitUntil: (promise: Promise<unknown>) => void }) => void): void
  }
  skipWaiting: () => void
  clients: { claim: () => void; matchAll: (options: { type: "window"; includeUncontrolled: true }) => Promise<readonly {
    url: string; visibilityState: string; focused: boolean; focus: () => Promise<unknown>; postMessage: (message: unknown) => void }[]>;
    openWindow: (url: string) => Promise<unknown> }
  registration: { showNotification: (title: string, options: Record<string, unknown>) => Promise<void>;
    pushManager: { subscribe: (options: { userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer> }) => Promise<{
      endpoint: string; getKey: (name: "p256dh" | "auth") => ArrayBuffer | null }> } }
  location: { origin: string }
}

scope.addEventListener("install", (
  event: { waitUntil: (promise: Promise<unknown>) => void },
) => {
  event.waitUntil(precacheShell().then(() => scope.skipWaiting()))
})

scope.addEventListener("activate", (event: { waitUntil: (promise: Promise<unknown>) => void }) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => scope.clients.claim()),
  )
})

scope.addEventListener("fetch", (event: FetchEvent) => {
  const request = event.request
  if (shouldHandleNavigation({ url: request.url, method: request.method, mode: request.mode })) {
    event.respondWith(navigationResponse(request))
    return
  }
  if (shouldCacheStaticAsset({ url: request.url, method: request.method, mode: request.mode, destination: request.destination }, scope.location.origin)) {
    event.respondWith(cacheFirst(request))
  }
})

scope.addEventListener("push", (event: { data?: { json: () => unknown }; waitUntil: (promise: Promise<unknown>) => void }) => {
  event.waitUntil((async () => {
    const payload = await Promise.resolve().then(() => event.data?.json()).catch(() => undefined)
    if (!isPushPayload(payload)) return
    const clients = await scope.clients.matchAll({ type: "window", includeUncontrolled: true })
    if (clients.some((client) => client.visibilityState === "visible" && client.focused)) return
    await scope.registration.showNotification(payload.category === "approval-requested" ? "YCoding — approval needed" : "YCoding — work stopped", {
      body: payload.category === "approval-requested" ? "A session is waiting for your decision." : "A session stopped running.",
      tag: `ycoding-${payload.sessionID}-${payload.category}`, data: { sessionID: payload.sessionID },
      icon: "/icons/icon-256.png", badge: "/icons/icon-256.png",
    })
  })())
})

scope.addEventListener("notificationclick", (event: { notification: { data?: unknown; close: () => void }; waitUntil: (promise: Promise<unknown>) => void }) => {
  event.notification.close()
  event.waitUntil((async () => {
    const data = event.notification.data
    if (!isRecord(data) || !isSessionID(data.sessionID)) return
    const clients = await scope.clients.matchAll({ type: "window", includeUncontrolled: true })
    const current = clients.find((client) => {
      const url = new URL(client.url)
      return url.origin === scope.location.origin && (url.pathname === "/remote" || url.pathname.startsWith("/remote/"))
    })
    if (current) {
      const delivered = await current.focus().then(() => {
        current.postMessage({ type: "ycoding:open-session", sessionID: data.sessionID })
        return true
      }).catch(() => false)
      if (delivered) return
    }
    await scope.clients.openWindow(`/remote#session=${encodeURIComponent(data.sessionID)}`)
  })())
})

scope.addEventListener("pushsubscriptionchange", (event: { newSubscription?: { endpoint: string; getKey: (name: "p256dh" | "auth") => ArrayBuffer | null };
  oldSubscription?: { endpoint: string }; waitUntil: (promise: Promise<unknown>) => void }) => {
  event.waitUntil((async () => {
    try {
      const response = await fetch("/api/push/key", { credentials: "same-origin" })
      if (!response.ok) return
      const value: unknown = await response.json()
      if (!isRecord(value) || typeof value.publicKey !== "string") return
      const applicationServerKey = decodeKey(value.publicKey)
      if (!applicationServerKey) return
      const subscription = event.newSubscription ?? await scope.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
      const p256dh = subscription.getKey("p256dh")
      const auth = subscription.getKey("auth")
      if (!p256dh || !auth) return
      const registered = await fetch("/api/push/subscriptions", { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint,
          keys: { p256dh: encodeKey(new Uint8Array(p256dh)), auth: encodeKey(new Uint8Array(auth)) } }) })
      if (registered.ok && event.oldSubscription && event.oldSubscription.endpoint !== subscription.endpoint)
        await fetch("/api/push/subscriptions", { method: "DELETE", credentials: "same-origin",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: event.oldSubscription.endpoint }) })
    } catch { return }
  })())
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSessionID(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^ses[A-Za-z0-9_-]+$/.test(value)
}

function isPushPayload(value: unknown): value is { category: "approval-requested" | "agent-completed"; sessionID: string; deviceID: string } {
  return isRecord(value) && (value.category === "approval-requested" || value.category === "agent-completed") &&
    isSessionID(value.sessionID) && typeof value.deviceID === "string"
}

function decodeKey(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  try {
    const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="))
    const bytes = new Uint8Array(decoded.length)
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
    return bytes.length === 65 && bytes[0] === 4 ? bytes : undefined
  } catch { return undefined }
}

function encodeKey(value: Uint8Array): string {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

async function precacheShell(): Promise<void> {
  const cache = await caches.open(CACHE_NAME)
  await cache.addAll([...PRECACHE_URLS])
  const html = await (await cache.match("/"))?.text()
  const assets = [...(html ?? "").matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].flatMap((match) => match[1] ? [match[1]] : [])
  if (assets.length === 0) throw new Error("Built shell entry assets are missing")
  await cache.addAll(assets)
}

async function navigationResponse(request: Request): Promise<Response> {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME)
      await cache.put("/", response.clone())
    }
    return response
  } catch {
    const cache = await caches.open(CACHE_NAME)
    const cached = (await cache.match("/", { ignoreSearch: true })) ?? (await cache.match(OFFLINE_FALLBACK_URL))
    return cached ?? new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } })
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME)
  // Vite's Vary: Origin differs between install prefetches and module loads; this cache holds only public static assets.
  const cached = await cache.match(request, { ignoreSearch: true, ignoreVary: true })
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}
