/**
 * HTTP primitives for the relay worker: cookie handling, origin and CSRF guards,
 * per-isolate request rate limiting, and bounded JSON responses.
 *
 * Browser-visible rules:
 * - Read-only `GET` routes require no `Origin`; browsers usually omit it.
 * - Mutating cookie-authenticated routes require an exact same-origin `Origin`,
 *   and additionally reject an explicit `Sec-Fetch-Site: cross-site` request.
 * - WebSocket upgrades require an exact same-origin `Origin` (client) or a bearer
 *   credential (agent).
 */

import type { RemoteErrorCode } from "../../../packages/remote/src/index"

/**
 * Security headers applied to every response this worker generates or delegates.
 * HTML, JSON, and redirect responses get the same baseline; connect-src/frame
 * policy for the SPA itself belongs to the web lane's own asset headers.
 */
const securityHeaders: ReadonlyArray<readonly [string, string]> = [
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["x-frame-options", "DENY"],
  ["cross-origin-opener-policy", "same-origin"],
  ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
  ["strict-transport-security", "max-age=31536000; includeSubDomains"],
]

/** Adds the baseline headers without overwriting anything the origin set. */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of securityHeaders) if (!headers.has(name)) headers.set(name, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined
  for (const part of header.split(";")) {
    const separator = part.indexOf("=")
    if (separator === -1) continue
    if (part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    return value.length === 0 ? undefined : value
  }
  return undefined
}

export function setCookie(name: string, value: string, options: { readonly maxAgeSeconds: number; readonly path: string }): string {
  return `${name}=${value}; Path=${options.path}; Max-Age=${options.maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`
}

export function clearCookie(name: string, path: string): string {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

/** Exact same-origin check. A missing `Origin` never counts as same-origin. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (origin === null) return false
  try {
    const originURL = new URL(origin)
    const requestURL = new URL(request.url)
    return originURL.protocol === requestURL.protocol && originURL.host === requestURL.host
  } catch {
    return false
  }
}

/** Browsers set this on cross-site requests and JavaScript cannot forge it. */
export function isCrossSiteRequest(request: Request): boolean {
  return request.headers.get("sec-fetch-site") === "cross-site"
}

export function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown"
}

export type RateLimiter = { readonly take: (key: string) => boolean }

export function createRateLimiter(options: {
  readonly limit: number
  readonly windowMs: number
  readonly maxKeys?: number
  readonly now?: () => number
}): RateLimiter {
  const now = options.now ?? Date.now
  const maxKeys = options.maxKeys ?? 1024
  const windows = new Map<string, { windowStart: number; count: number }>()
  return {
    take: (key) => {
      const current = now()
      const window = windows.get(key)
      if (!window || current - window.windowStart >= options.windowMs) {
        windows.delete(key)
        windows.set(key, { windowStart: current, count: 1 })
        while (windows.size > maxKeys) {
          const oldest = windows.keys().next()
          if (oldest.done) break
          windows.delete(oldest.value)
        }
        return true
      }
      window.count += 1
      return window.count <= options.limit
    },
  }
}

export function jsonResponse(body: unknown, options: { readonly status?: number; readonly cookies?: readonly string[] } = {}): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  for (const cookie of options.cookies ?? []) headers.append("set-cookie", cookie)
  return withSecurityHeaders(new Response(JSON.stringify(body), { status: options.status ?? 200, headers }))
}

export function apiError(
  status: number,
  code: RemoteErrorCode,
  message: string,
  cookies: readonly string[] = [],
): Response {
  return jsonResponse({ error: { code, message } }, { status, cookies })
}

export function redirectResponse(location: string, cookies: readonly string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store" })
  for (const cookie of cookies) headers.append("set-cookie", cookie)
  return withSecurityHeaders(new Response(null, { status: 302, headers }))
}

const maxJsonBodyChars = 8192

/** Reads a bounded JSON body. Oversized or malformed bodies return `undefined`. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > maxJsonBodyChars) return undefined
  const text = await request.text()
  if (text.length === 0 || text.length > maxJsonBodyChars) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket"
}
