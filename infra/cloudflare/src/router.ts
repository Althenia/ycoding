/**
 * Worker HTTP router: Google sign-in, browser sessions, device enrollment and
 * credentials, and the two authenticated WebSocket upgrades.
 *
 * The router owns authentication and the trusted relay headers; the Durable
 * Object owns per-connection state. No route accepts a URL, path, or method from
 * a client for proxying.
 */

import {
  parseBearerToken,
  parseChallengeRequest,
  parseDeviceRefreshRequest,
  parseDeviceTokenRequest,
  parseEnrollRequest,
  type ChallengeResponse,
  type CreateEnrollmentResponse,
  type DeviceTokenResponse,
  type DevicesResponse,
  type EnrollResponse,
  type MeResponse,
} from "../../../packages/remote/src/index"
import type { AuthRejection, AuthService } from "./auth/service"
import { browserSessionTtlMs, oauthTransactionTtlMs } from "./auth/service"
import type { GoogleEndpoints } from "./auth/google"
import { isIdentityAllowed } from "./auth/allowlist"
import { authorizationUrl, exchangeCode, verifyIdToken } from "./auth/google"
import { createJwksCache, type JwksCache } from "./auth/jwks"
import {
  apiError,
  clearCookie,
  withSecurityHeaders,
  clientAddress,
  createRateLimiter,
  isCrossSiteRequest,
  isSameOrigin,
  isWebSocketUpgrade,
  jsonResponse,
  readCookie,
  readJsonBody,
  redirectResponse,
  setCookie,
} from "./http"

export const sessionCookieName = "yc_session"
export const oauthCookieName = "yc_oauth"

export type RelayNamespace = {
  readonly getByName: (name: string) => { readonly fetch: (request: Request) => Promise<Response> }
}

export type RouterDeps = {
  readonly service: AuthService
  readonly relay: RelayNamespace
  readonly endpoints: GoogleEndpoints
  /** Server-only sign-in allowlist. Empty denies every Google account. */
  readonly allowedEmails: ReadonlySet<string>
  readonly fetch: typeof fetch
  readonly rateLimit?: (key: string) => boolean
  readonly now?: () => number
  /** Overrides the lazy sweep interval. Clamped to the bounded range below. */
  readonly cleanupEveryMs?: number
  /** Static asset binding for landing, docs, and SPA routes owned by the web lane. */
  readonly assets?: { readonly fetch: (request: Request) => Promise<Response> }
}

/** Expired authentication metadata is swept at most once per hour per isolate. */
export const cleanupIntervalMs = 60 * 60 * 1000
/** Operators may tune the sweep cadence within these bounds; outside them the default applies. */
export const minCleanupIntervalMs = 10_000
export const maxCleanupIntervalMs = 24 * 60 * 60 * 1000

export function boundedCleanupInterval(value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minCleanupIntervalMs || parsed > maxCleanupIntervalMs) return cleanupIntervalMs
  return Math.floor(parsed)
}

const deviceIDPattern = /^[A-Za-z0-9_-]{1,64}$/
const authErrorRedirect = "/remote/?auth=error"

export function createRouter(deps: RouterDeps) {
  const jwks = new Map<string, JwksCache>()
  const limiter = createRateLimiter({ limit: 30, windowMs: 60_000 })
  const rateLimit = deps.rateLimit ?? limiter.take
  const now = deps.now ?? Date.now
  const cleanupEveryMs = deps.cleanupEveryMs ?? cleanupIntervalMs
  let lastCleanupAt = 0

  const keysFor = (endpoints: GoogleEndpoints) => {
    const cached = jwks.get(endpoints.jwksUri)
    if (cached) return cached
    const cache = createJwksCache({ jwksUri: endpoints.jwksUri, fetch: deps.fetch })
    jwks.set(endpoints.jwksUri, cache)
    return cache
  }

  /**
   * Route dispatch. Every handler is awaited by the error boundary below, so a
   * rejected handler answers with the generic envelope instead of escaping the
   * Worker as an unreported failure.
   */
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    // Bounded cleanup of expired metadata runs before any route so a liveness
    // probe is not a way to skip maintenance. A failure never breaks a request.
    if (now() - lastCleanupAt >= cleanupEveryMs) {
      lastCleanupAt = now()
      await deps.service.cleanup().catch(() => undefined)
    }
    if (url.pathname === "/health") return health(deps)

    if (url.pathname === "/api/auth/google/start") {
      if (request.method !== "GET") return methodNotAllowed()
      if (!rateLimit(`oauth-start:${clientAddress(request)}`)) return apiError(429, "rate_limited", "Too many requests")
      return startGoogleSignIn(deps, url)
    }
    if (url.pathname === "/api/auth/google/callback") {
      if (request.method !== "GET") return methodNotAllowed()
      if (!rateLimit(`oauth-callback:${clientAddress(request)}`)) return apiError(429, "rate_limited", "Too many requests")
      return completeGoogleSignIn(deps, request, url, keysFor(deps.endpoints))
    }
    if (url.pathname === "/api/auth/session/refresh") {
      if (request.method !== "POST") return methodNotAllowed()
      return refreshBrowserSession(deps, request)
    }
    if (url.pathname === "/api/auth/logout") {
      if (request.method !== "POST") return methodNotAllowed()
      return signOut(deps, request)
    }
    if (url.pathname === "/api/me") {
      if (request.method !== "GET") return methodNotAllowed()
      return currentUser(deps, request)
    }
    if (url.pathname === "/api/devices") {
      if (request.method !== "GET") return methodNotAllowed()
      return listDevices(deps, request)
    }
    if (url.pathname === "/api/devices/enrollments") {
      if (request.method !== "POST") return methodNotAllowed()
      return createEnrollment(deps, request)
    }
    if (url.pathname === "/api/devices/enroll") {
      if (request.method !== "POST") return methodNotAllowed()
      return enrollDevice(deps, request, rateLimit)
    }
    if (url.pathname === "/api/devices/challenge") {
      if (request.method !== "POST") return methodNotAllowed()
      return createDeviceChallenge(deps, request, rateLimit)
    }
    if (url.pathname === "/api/devices/token") {
      if (request.method !== "POST") return methodNotAllowed()
      return issueDeviceToken(deps, request, rateLimit)
    }
    if (url.pathname === "/api/devices/refresh") {
      if (request.method !== "POST") return methodNotAllowed()
      return refreshDeviceCredentials(deps, request, rateLimit)
    }
    const revoke = /^\/api\/devices\/([A-Za-z0-9_-]{1,64})\/revoke$/.exec(url.pathname)
    if (revoke) {
      if (request.method !== "POST") return methodNotAllowed()
      return revokeDevice(deps, request, revoke[1] ?? "")
    }
    if (url.pathname === "/ws/client") {
      if (request.method !== "GET") return methodNotAllowed()
      return connectClient(deps, request, url)
    }
    if (url.pathname === "/ws/agent") {
      if (request.method !== "GET") return methodNotAllowed()
      return connectAgent(deps, request)
    }
    // An unmatched relay path must never fall through to the SPA shell: a client
    // asking for JSON cannot be answered with HTML. Relay prefixes are owned by
    // this worker for every path, matched or not.
    if (isRelayPath(url.pathname)) return apiError(404, "invalid_message", "Not found")

    // Landing, docs, changelog, and the remote SPA are served from the asset
    // binding. Unmatched paths reach this branch for every `run_worker_first`
    // route, and the asset layer rewrites them to `/index.html` for the SPA.
    if (deps.assets) return withSecurityHeaders(await deps.assets.fetch(request))
    return withSecurityHeaders(new Response("Not found", { status: 404 }))
  }

  /**
   * Error boundary: awaiting the dispatch here is what turns a rejected handler
   * into the generic API error instead of an escaped Worker failure.
   */
  return async function route(request: Request): Promise<Response> {
    try {
      return await handle(request)
    } catch {
      return apiError(500, "internal_error", "Relay request failed")
    }
  }
}

async function health(deps: RouterDeps): Promise<Response> {
  try {
    const result = await deps.service.health()
    if (result) return jsonResponse({ status: "ok" })
  } catch {
    // Health responses intentionally omit provider and database details.
  }
  return jsonResponse({ status: "error" }, { status: 503 })
}

async function startGoogleSignIn(deps: RouterDeps, url: URL): Promise<Response> {
  if (deps.endpoints.clientId.length === 0 || deps.endpoints.clientSecret.length === 0)
    return apiError(503, "internal_error", "Google sign-in is not configured")
  const begun = await deps.service.beginOAuth({ redirectAfter: url.searchParams.get("redirect_after") })
  const authorizeURL = authorizationUrl(deps.endpoints, {
    state: begun.state,
    nonce: begun.nonce,
    codeChallenge: begun.codeChallenge,
    redirectUri: callbackURL(url),
  })
  return redirectResponse(authorizeURL, [
    setCookie(oauthCookieName, begun.cookieToken, { maxAgeSeconds: oauthTransactionTtlMs / 1000, path: "/api/auth" }),
  ])
}

async function completeGoogleSignIn(deps: RouterDeps, request: Request, url: URL, keys: JwksCache): Promise<Response> {
  const cookieToken = readCookie(request.headers.get("cookie"), oauthCookieName)
  const clearedCookie = clearCookie(oauthCookieName, "/api/auth")
  if (cookieToken === undefined) return redirectResponse(authErrorRedirect, [clearedCookie])

  const consumed = await deps.service.consumeOAuthTransaction(cookieToken, url.searchParams.get("state") ?? "")
  if (!consumed.ok) return redirectResponse(authErrorRedirect, [clearedCookie])

  const code = url.searchParams.get("code")
  if (code === null || code.length === 0) return redirectResponse(authErrorRedirect, [clearedCookie])

  const exchanged = await exchangeCode(deps.endpoints, deps.fetch, {
    code,
    codeVerifier: consumed.value.codeVerifier,
    redirectUri: callbackURL(url),
  })
  if (!exchanged.ok) return redirectResponse(authErrorRedirect, [clearedCookie])

  const identity = await verifyIdToken(deps.endpoints, {
    idToken: exchanged.value.idToken,
    nonce: consumed.value.nonce,
    keys,
  })
  if (!identity.ok) return redirectResponse(authErrorRedirect, [clearedCookie])
  // Fail closed: an unlisted or unverified account cannot sign in. The redirect
  // stays generic and never echoes the configured addresses.
  if (!isIdentityAllowed(deps.allowedEmails, identity.value)) return redirectResponse(authErrorRedirect, [clearedCookie])

  const signedIn = await deps.service.signIn({ provider: "google", subject: identity.value.subject })
  return redirectResponse(consumed.value.redirectAfter, [
    setCookie(sessionCookieName, signedIn.token, { maxAgeSeconds: browserSessionTtlMs / 1000, path: "/" }),
    clearedCookie,
  ])
}

async function refreshBrowserSession(deps: RouterDeps, request: Request): Promise<Response> {
  const guarded = requireMutationGuard(request)
  if (guarded) return guarded
  const token = readCookie(request.headers.get("cookie"), sessionCookieName)
  if (token === undefined) return apiError(401, "unauthorized", "Browser session is not authenticated")
  const previous = await deps.service.resolveBrowserSession(token)
  const rotated = await deps.service.rotateBrowserSession(token)
  // A concurrent rotation can revoke the presented session while a sibling request
  // already installed its replacement cookie. This refusal must not clear the
  // cookie, because it would delete a newer, valid session.
  if (!rotated.ok) return apiError(401, "unauthorized", "Browser session is not authenticated")
  // The replaced session is revoked: close every socket still authenticated by it
  // on every device this owner uses, not just one object.
  if (previous.ok && rotated.value.rotatedToken !== undefined)
    await revokeRelaySessions(deps, previous.value.userID, previous.value.sessionID)
  const cookies =
    rotated.value.rotatedToken === undefined
      ? []
      : [
          setCookie(sessionCookieName, rotated.value.rotatedToken, {
            maxAgeSeconds: browserSessionTtlMs / 1000,
            path: "/",
          }),
        ]
  return jsonResponse({ session: { expiresAt: rotated.value.rotatedExpiresAt ?? rotated.value.expiresAt } }, { cookies })
}

async function signOut(deps: RouterDeps, request: Request): Promise<Response> {
  const guarded = requireMutationGuard(request)
  if (guarded) return guarded
  const token = readCookie(request.headers.get("cookie"), sessionCookieName)
  if (token !== undefined) {
    const session = await deps.service.resolveBrowserSession(token)
    await deps.service.signOut(token)
    if (session.ok) await revokeRelaySessions(deps, session.value.userID, session.value.sessionID)
  }
  return jsonResponse({ signedOut: true }, { cookies: [clearCookie(sessionCookieName, "/")] })
}

async function currentUser(deps: RouterDeps, request: Request): Promise<Response> {
  const authenticated = await requireSession(deps, request)
  if (!authenticated.ok) return authenticated.response
  const devices = await deps.service.listDevices(authenticated.session.userID)
  const body: MeResponse = {
    user: { id: authenticated.session.userID },
    session: { expiresAt: authenticated.session.expiresAt },
    devices,
  }
  return jsonResponse(body)
}

async function listDevices(deps: RouterDeps, request: Request): Promise<Response> {
  const authenticated = await requireSession(deps, request)
  if (!authenticated.ok) return authenticated.response
  const body: DevicesResponse = { devices: await deps.service.listDevices(authenticated.session.userID) }
  return jsonResponse(body)
}

async function createEnrollment(deps: RouterDeps, request: Request): Promise<Response> {
  const guarded = requireMutationGuard(request)
  if (guarded) return guarded
  const authenticated = await requireSession(deps, request)
  if (!authenticated.ok) return authenticated.response
  const created: CreateEnrollmentResponse = await deps.service.createEnrollment(authenticated.session.userID)
  return jsonResponse(created)
}

async function enrollDevice(deps: RouterDeps, request: Request, rateLimit: (key: string) => boolean): Promise<Response> {
  if (!rateLimit(`enroll:${clientAddress(request)}`)) return apiError(429, "rate_limited", "Too many requests")
  const parsed = parseEnrollRequest(await readJsonBody(request))
  if (!parsed.ok) return apiError(400, parsed.error.code, parsed.error.message)
  const enrolled = await deps.service.completeEnrollment(parsed.value)
  if (!enrolled.ok) return rejectionResponse(enrolled)
  const body: EnrollResponse = { deviceID: enrolled.value.deviceID }
  return jsonResponse(body)
}

async function createDeviceChallenge(deps: RouterDeps, request: Request, rateLimit: (key: string) => boolean): Promise<Response> {
  if (!rateLimit(`challenge:${clientAddress(request)}`)) return apiError(429, "rate_limited", "Too many requests")
  const parsed = parseChallengeRequest(await readJsonBody(request))
  if (!parsed.ok) return apiError(400, parsed.error.code, parsed.error.message)
  const challenge = await deps.service.createChallenge(parsed.value.deviceID)
  if (!challenge.ok) return apiError(401, "unauthorized", "Device is not available for authentication")
  const body: ChallengeResponse = challenge.value
  return jsonResponse(body)
}

async function issueDeviceToken(deps: RouterDeps, request: Request, rateLimit: (key: string) => boolean): Promise<Response> {
  if (!rateLimit(`token:${clientAddress(request)}`)) return apiError(429, "rate_limited", "Too many requests")
  const parsed = parseDeviceTokenRequest(await readJsonBody(request))
  if (!parsed.ok) return apiError(400, parsed.error.code, parsed.error.message)
  const issued = await deps.service.redeemChallenge(parsed.value)
  if (!issued.ok) return apiError(401, "unauthorized", "Device authentication failed")
  const body: DeviceTokenResponse = issued.value
  return jsonResponse(body)
}

async function refreshDeviceCredentials(deps: RouterDeps, request: Request, rateLimit: (key: string) => boolean): Promise<Response> {
  if (!rateLimit(`refresh:${clientAddress(request)}`)) return apiError(429, "rate_limited", "Too many requests")
  const parsed = parseDeviceRefreshRequest(await readJsonBody(request))
  if (!parsed.ok) return apiError(400, parsed.error.code, parsed.error.message)
  const refreshed = await deps.service.refreshCredentials(parsed.value)
  if (!refreshed.ok) return apiError(401, "unauthorized", "Device credentials cannot be rotated")
  const body: DeviceTokenResponse = refreshed.value
  return jsonResponse(body)
}

async function revokeDevice(deps: RouterDeps, request: Request, deviceID: string): Promise<Response> {
  const guarded = requireMutationGuard(request)
  if (guarded) return guarded
  const authenticated = await requireSession(deps, request)
  if (!authenticated.ok) return authenticated.response
  const revoked = await deps.service.revokeDevice({ deviceID, userID: authenticated.session.userID })
  if (!revoked.ok) {
    if (revoked.reason === "not_owner") return apiError(403, "forbidden", "Device belongs to another owner")
    return apiError(404, "invalid_message", "Unknown device")
  }
  await notifyRelay(deps, authenticated.session.userID, deviceID, "close-device")
  return jsonResponse({ deviceID })
}

async function connectClient(deps: RouterDeps, request: Request, url: URL): Promise<Response> {
  if (!isWebSocketUpgrade(request)) return apiError(426, "invalid_message", "WebSocket upgrade required")
  if (isCrossSiteRequest(request) || !isSameOrigin(request))
    return apiError(403, "forbidden", "WebSocket upgrade requires a same-origin browser request")
  const token = readCookie(request.headers.get("cookie"), sessionCookieName)
  if (token === undefined) return apiError(401, "unauthorized", "Browser session is not authenticated")
  const session = await deps.service.resolveBrowserSession(token)
  if (!session.ok) return apiError(401, "unauthorized", "Browser session is not authenticated")

  const deviceID = url.searchParams.get("device") ?? ""
  if (!deviceIDPattern.test(deviceID)) return apiError(400, "invalid_message", "A valid device is required")
  const authorized = await deps.service.authorizeClientCommand(session.value.sessionID, deviceID)
  if (!authorized.ok) {
    if (authorized.reason === "not_owner") return apiError(403, "forbidden", "Device belongs to another owner")
    if (authorized.reason === "unknown_device") return apiError(404, "invalid_message", "Unknown device")
    return apiError(401, "unauthorized", "Browser session or device is no longer authorized")
  }

  return forwardUpgrade(deps, request, {
    role: "client",
    ownerID: authorized.value.userID,
    deviceID,
    browserSessionID: session.value.sessionID,
    credentialExpiresAt: session.value.expiresAt,
  })
}

async function connectAgent(deps: RouterDeps, request: Request): Promise<Response> {
  if (!isWebSocketUpgrade(request)) return apiError(426, "invalid_message", "WebSocket upgrade required")
  const token = parseBearerToken(request.headers.get("authorization"))
  if (token === undefined) return apiError(401, "unauthorized", "Device credential is required")
  const credential = await deps.service.authorizeAgentToken(token)
  if (!credential.ok) return apiError(401, "unauthorized", "Device credential is not valid")
  return forwardUpgrade(deps, request, {
    role: "agent",
    ownerID: credential.value.userID,
    deviceID: credential.value.deviceID,
    browserSessionID: credential.value.deviceID,
    credentialExpiresAt: credential.value.expiresAt,
  })
}

type TrustedRelayHeaders = {
  readonly role: "agent" | "client"
  readonly ownerID: string
  readonly deviceID: string
  readonly browserSessionID: string
  readonly credentialExpiresAt: number
}

async function forwardUpgrade(deps: RouterDeps, request: Request, trusted: TrustedRelayHeaders): Promise<Response> {
  const headers = new Headers(request.headers)
  for (const key of Array.from(headers.keys())) if (key.startsWith("x-ycoding-")) headers.delete(key)
  headers.set("x-ycoding-role", trusted.role)
  headers.set("x-ycoding-owner", trusted.ownerID)
  headers.set("x-ycoding-device", trusted.deviceID)
  headers.set("x-ycoding-browser-session", trusted.browserSessionID)
  headers.set("x-ycoding-credential-expires-at", String(trusted.credentialExpiresAt))
  return deps.relay.getByName(`${trusted.ownerID}:${trusted.deviceID}`).fetch(new Request(request, { headers }))
}

/**
 * Notifies every Durable Object this owner may have a socket in. Best effort: the
 * revocation is already durable, and every event delivery re-validates authority
 * within the relay's bounded window, so a failed enumeration or push must never
 * change the caller's response.
 */
async function revokeRelaySessions(deps: RouterDeps, userID: string, sessionID: string): Promise<void> {
  try {
    const devices = await deps.service.listDevices(userID)
    await Promise.all(devices.map((device) => notifyRelay(deps, userID, device.id, "revoke-session", sessionID)))
  } catch {
    // Best effort only; a failed push never changes the durable revocation.
  }
}

async function notifyRelay(
  deps: RouterDeps,
  ownerID: string,
  deviceID: string,
  path: "revoke-session" | "close-device",
  sessionID?: string,
): Promise<void> {
  const headers = new Headers({ "x-ycoding-internal": "1" })
  if (sessionID !== undefined) headers.set("x-ycoding-target-session", sessionID)
  try {
    const response = await deps.relay
      .getByName(`${ownerID}:${deviceID}`)
      .fetch(new Request(`https://relay.internal/_ycoding/${path}`, { method: "POST", headers }))
    await response.text()
  } catch {
    // Revocation is already durable in D1; the live socket also re-checks authority
    // on its next command, so a failed push is not a correctness loss.
  }
}

async function requireSession(
  deps: RouterDeps,
  request: Request,
): Promise<{ readonly ok: true; readonly session: { readonly sessionID: string; readonly userID: string; readonly expiresAt: number } } | { readonly ok: false; readonly response: Response }> {
  const token = readCookie(request.headers.get("cookie"), sessionCookieName)
  if (token === undefined) return { ok: false, response: apiError(401, "unauthorized", "Browser session is not authenticated") }
  const session = await deps.service.resolveBrowserSession(token)
  // An invalid cookie stays non-authoritative instead of being deleted here: the same
  // cookie can be an older generation that an in-flight request still carries while a
  // concurrent rotation already installed its replacement, so deleting it would
  // discard a newer, valid session. Only explicit sign-out clears the cookie.
  if (!session.ok)
    return { ok: false, response: apiError(401, "unauthorized", "Browser session is not authenticated") }
  return { ok: true, session: session.value }
}

/**
 * Mutating cookie-authenticated routes require an exact same-origin `Origin` and
 * reject an explicit cross-site `Sec-Fetch-Site`. Read-only `GET` routes do not,
 * because browsers omit `Origin` on ordinary same-origin navigation and fetch.
 */
function requireMutationGuard(request: Request): Response | undefined {
  if (isCrossSiteRequest(request)) return apiError(403, "forbidden", "Cross-site requests are rejected")
  if (!isSameOrigin(request)) return apiError(403, "forbidden", "Request must be same-origin")
  return undefined
}

function rejectionResponse(rejection: { readonly reason: AuthRejection }): Response {
  const message = rejectionMessages[rejection.reason]
  if (rejection.reason === "not_owner") return apiError(403, "forbidden", message)
  if (rejection.reason === "bad_enrollment_code") return apiError(400, "invalid_message", message)
  if (rejection.reason.endsWith("_enrollment")) return apiError(400, "invalid_message", message)
  return apiError(401, "unauthorized", message)
}

const rejectionMessages: Record<AuthRejection, string> = {
  unknown_transaction: "Sign-in transaction is not available",
  consumed_transaction: "Sign-in transaction is not available",
  expired_transaction: "Sign-in transaction is not available",
  state_mismatch: "Sign-in transaction is not available",
  unknown_session: "Browser session is not authenticated",
  revoked_session: "Browser session is not authenticated",
  expired_session: "Browser session is not authenticated",
  unknown_device: "Device is not available",
  revoked_device: "Device is not available",
  unknown_enrollment: "Enrollment is not available",
  consumed_enrollment: "Enrollment is not available",
  expired_enrollment: "Enrollment is not available",
  bad_enrollment_code: "Enrollment code is not valid",
  unknown_challenge: "Device authentication failed",
  consumed_challenge: "Device authentication failed",
  expired_challenge: "Device authentication failed",
  challenge_mismatch: "Device authentication failed",
  bad_signature: "Device authentication failed",
  unknown_credential: "Device credential is not valid",
  revoked_credential: "Device credential is not valid",
  expired_credential: "Device credential is not valid",
  wrong_credential_kind: "Device credential is not valid",
  not_owner: "Device belongs to another owner",
}

function callbackURL(url: URL): string {
  return new URL("/api/auth/google/callback", url.origin).toString()
}

/** `/api`, `/ws`, and `/health` prefixes belong to the worker on every path. */
function isRelayPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/ws" ||
    pathname.startsWith("/ws/") ||
    pathname === "/health" ||
    pathname.startsWith("/health/")
  )
}

function methodNotAllowed(): Response {
  return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST", "cache-control": "no-store" } })
}
