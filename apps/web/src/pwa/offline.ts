export const CACHE_NAME = "ycoding-web-shell-v1"
export const OFFLINE_FALLBACK_URL = "/offline.html"

/**
 * Explicit static public shell assets. Nothing here is user-, session-, or
 * provider-derived, and every entry is a same-origin path served from the web
 * application's public directory.
 */
export const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  OFFLINE_FALLBACK_URL,
  "/robots.txt",
  "/brand/ycoding-mark.svg",
  "/icons/icon-256.png",
  "/icons/icon-512.png",
] as const

/**
 * Request paths the service worker never intercepts, caches, or replays.
 * API, authentication, socket, and discovery traffic always reaches the network.
 */
export const BLOCKED_PATH_PREFIXES = ["/api", "/auth", "/ws", "/oauth", "/.well-known"] as const

export type CacheableRequest = {
  readonly url: string
  readonly method: string
  readonly destination?: string
  readonly mode?: string
}

export function isBlockedPath(pathname: string): boolean {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`
  return BLOCKED_PATH_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  )
}

export function isPrecachedShellUrl(pathname: string): boolean {
  return (PRECACHE_URLS as readonly string[]).includes(pathname)
}

/** True only for same-origin static shell assets: the built bundle and precached public files. */
export function shouldCacheStaticAsset(request: CacheableRequest, origin: string): boolean {
  if (!isCacheableGet(request)) return false
  const url = parseUrl(request.url)
  if (!url || url.origin !== origin) return false
  if (isBlockedPath(url.pathname)) return false
  if (request.mode === "navigate" || request.destination === "document") return false
  if (isPrecachedShellUrl(url.pathname)) return true
  return url.pathname.startsWith("/assets/")
}

/** True for same-origin document navigations that may fall back to the cached shell. */
export function shouldHandleNavigation(request: CacheableRequest): boolean {
  if (!isCacheableGet(request)) return false
  if (request.mode !== "navigate") return false
  const url = parseUrl(request.url)
  return url !== undefined && !isBlockedPath(url.pathname)
}

function isCacheableGet(request: CacheableRequest): boolean {
  return request.method.toUpperCase() === "GET"
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}
