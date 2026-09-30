/**
 * Worker HTTP router: Google sign-in, browser sessions, device enrollment and
 * credentials, and the two authenticated WebSocket upgrades.
 *
 * The router owns authentication and the trusted relay headers; the Durable
 * Object owns per-connection state. No route accepts a URL, path, or method from
 * a client for proxying.
 */

import {
  RemoteWebSocketPath,
  isSessionID,
  parseBearerToken,
  parseChallengeRequest,
  parseDeviceRefreshRequest,
  parseDeviceTokenRequest,
  parseEnrollRequest,
  parsePushSubscription,
  parsePushEndpoint,
  type ChallengeResponse,
  type CreateEnrollmentResponse,
  type DeviceTokenResponse,
  type DevicesResponse,
  type EnrollResponse,
  type MeResponse,
  type PushKeyResponse,
  type PushTestResponse,
} from "../../../packages/remote/src/index"
import { sendTestPush } from "./push/send"
import type { PushStore } from "./push/store"
import type { AuthRejection, AuthService } from "./auth/service"
import { browserSessionTtlMs, oauthTransactionTtlMs } from "./auth/service"
import type { GoogleEndpoints } from "./auth/google"
import { isIdentityAllowed } from "./auth/allowlist"
import { base64UrlDecode } from "./auth/crypto"
import { authorizationUrl, exchangeCode, verifyIdToken } from "./auth/google"
import { createJwksCache, type JwksCache } from "./auth/jwks"
import type { createInviteService } from "./invite/service"
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
  readonly adminKey?: string
  readonly invite?: ReturnType<typeof createInviteService>
  readonly fetch: typeof fetch
  readonly rateLimit?: (key: string) => boolean
  readonly now?: () => number
  /** Overrides the lazy sweep interval. Clamped to the bounded range below. */
  readonly cleanupEveryMs?: number
  /** Static asset binding for landing, docs, and SPA routes owned by the web lane. */
  readonly assets?: { readonly fetch: (request: Request) => Promise<Response> }
  readonly push?: { readonly store: PushStore; readonly publicKey?: string; readonly privateKey?: string; readonly subject?: string }
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

    if (url.pathname.startsWith("/api/admin/")) return adminRoute(deps, request, url, rateLimit, now())
    if (url.pathname === "/api/auth/invite" || url.pathname === "/api/auth/key") {
      if (request.method !== "POST") return methodNotAllowed()
      if (!rateLimit(`invite-auth:${clientAddress(request)}`)) return apiError(429, "rate_limited", "Too many attempts")
      return signInWithInvite(deps, request, url.pathname === "/api/auth/invite")
    }

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
    if (url.pathname === "/api/devices/revoked") {
      if (request.method !== "DELETE") return methodNotAllowed()
      return deleteRevokedDevices(deps, request)
    }
    if (url.pathname === "/api/push/key") {
      if (request.method !== "GET") return methodNotAllowed()
      return pushKey(deps, request)
    }
    if (url.pathname === "/api/push/subscriptions") {
      if (request.method === "POST") return subscribePush(deps, request)
      if (request.method === "DELETE") return unsubscribePush(deps, request)
      return methodNotAllowed()
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
    const remove = /^\/api\/devices\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname)
    if (remove) {
      if (request.method !== "DELETE") return methodNotAllowed()
      return deleteRevokedDevices(deps, request, remove[1])
    }
    const contentStream = /^\/api\/remote\/devices\/([A-Za-z0-9_-]{1,64})\/sessions\/([^/]+)\/(messages|attachments)\/([^/]+)$/.exec(url.pathname)
    if (contentStream) {
      if (request.method !== "GET") return methodNotAllowed()
      return streamSessionContent(deps, request, contentStream[1] ?? "", contentStream[2] ?? "", contentStream[4] ?? "", contentStream[3] === "messages")
    }
    if (url.pathname === RemoteWebSocketPath.client) {
      if (request.method !== "GET") return methodNotAllowed()
      return connectClient(deps, request, url)
    }
    if (url.pathname === RemoteWebSocketPath.agent) {
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

async function adminRoute(deps: RouterDeps, request: Request, url: URL, rateLimit: (key: string) => boolean, now: number): Promise<Response> {
  if (!deps.adminKey || deps.adminKey.length < 32) return apiError(404, "not_found", "Not found")
  const supplied = request.headers.get("authorization")
  const expectedHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deps.adminKey))
  const actualHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied?.startsWith("Bearer ") ? supplied.slice(7) : ""))
  if (!crypto.subtle.timingSafeEqual(expectedHash, actualHash)) {
    if (!rateLimit(`admin:${clientAddress(request)}`)) return apiError(429, "rate_limited", "Too many attempts")
    return apiError(401, "unauthorized", "Admin authentication failed")
  }
  if (url.pathname === "/api/admin/push/test") {
    if (request.method !== "POST") return methodNotAllowed()
    return testPush(deps, request, now)
  }
  if (!deps.invite) return apiError(404, "not_found", "Not found")
  if (url.pathname === "/api/admin/invites") {
    if (request.method === "GET") {
      const invites = await deps.invite.list()
      return jsonResponse({ invites: invites.map((row) => ({ id: row.id, label: row.label, createdAt: row.createdAt, redeemedAt: row.redeemedAt })) })
    }
    if (request.method !== "POST") return methodNotAllowed()
    const value = await readJsonBody(request)
    if (!isRecord(value) || Object.keys(value).some((key) => key !== "label") || ("label" in value &&
      (typeof value.label !== "string" || value.label.trim().length < 1 || value.label.trim().length > 64)))
      return apiError(400, "invalid_message", "Invalid invite label")
    return jsonResponse(await deps.invite.create(typeof value.label === "string" ? value.label.trim() : null, url.origin), { status: 201 })
  }
  const id = /^\/api\/admin\/invites\/(inv_[A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1]
  if (!id) return apiError(404, "not_found", "Not found")
  if (request.method !== "DELETE") return methodNotAllowed()
  const invite = await deps.invite.find(id)
  if (!invite) return apiError(404, "not_found", "Not found")
  if (invite.userID !== null) {
    const devices = await deps.service.listDevices(invite.userID)
    for (const device of devices) {
      const response = await deps.relay.getByName(`${invite.userID}:${device.id}`).fetch(new Request("https://relay.internal/_ycoding/close-device", {
        method: "POST", headers: { "x-ycoding-internal": "1" },
      }))
      if (!response.ok) return apiError(503, "internal_error", "Device could not be closed")
      await response.text()
    }
  }
  if (!await deps.invite.delete(id, invite.userID)) return apiError(404, "not_found", "Not found")
  return withSecurityHeaders(new Response(null, { status: 204, headers: { "cache-control": "no-store" } }))
}

async function signInWithInvite(deps: RouterDeps, request: Request, redeem: boolean): Promise<Response> {
  const guarded = requireMutationGuard(request)
  if (guarded) return guarded
  if (!deps.invite) return apiError(503, "internal_error", "Invite sign-in is unavailable")
  const body = await readJsonBody(request)
  if (!isRecord(body)) return apiError(redeem ? 404 : 401, redeem ? "not_found" : "unauthorized", redeem ? "Invite is not available" : "Access key is not valid")
  if (redeem) {
    const token = body.token
    if (typeof token !== "string" || base64UrlDecode(token)?.length !== 32) return apiError(404, "not_found", "Invite is not available")
    const created = await deps.invite.redeem(token)
    if (!created) return apiError(404, "not_found", "Invite is not available")
    await replaceBrowserSession(deps, request)
    return jsonResponse({ accessKey: created.accessKey }, { status: 201, cookies: [setCookie(sessionCookieName, created.cookieToken,
      { maxAgeSeconds: browserSessionTtlMs / 1000, path: "/" })] })
  }
  const token = await deps.invite.signIn(body.accessKey)
  if (!token) return apiError(401, "unauthorized", "Access key is not valid")
  await replaceBrowserSession(deps, request)
  return withSecurityHeaders(new Response(null, { status: 204, headers: { "cache-control": "no-store", "set-cookie": setCookie(sessionCookieName, token,
    { maxAgeSeconds: browserSessionTtlMs / 1000, path: "/" }) } }))
}

async function replaceBrowserSession(deps: RouterDeps, request: Request): Promise<void> {
  const oldToken = readCookie(request.headers.get("cookie"), sessionCookieName)
  if (!oldToken) return
  const previous = await deps.service.resolveBrowserSession(oldToken)
  await deps.service.signOut(oldToken)
  if (previous.ok) await revokeRelaySessions(deps, previous.value.userID, previous.value.sessionID)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
    devices: await withPresence(deps, authenticated.session.userID, devices),
  }
  return jsonResponse(body)
}

async function listDevices(deps: RouterDeps, request: Request): Promise<Response> {
  const authenticated = await requireSession(deps, request)
  if (!authenticated.ok) return authenticated.response
  const devices = await deps.service.listDevices(authenticated.session.userID)
  const body: DevicesResponse = { devices: await withPresence(deps, authenticated.session.userID, devices) }
  return jsonResponse(body)
}

function pushAvailable(push: RouterDeps["push"]): push is NonNullable<RouterDeps["push"]> & { publicKey: string; privateKey: string; subject: string } {
  if (push === undefined || typeof push.publicKey !== "string" || typeof push.privateKey !== "string" || typeof push.subject !== "string") return false
  const point = base64UrlDecode(push.publicKey)
  const scalar = base64UrlDecode(push.privateKey)
  return point?.length === 65 && point[0] === 4 && scalar?.length === 32 &&
    (push.subject.startsWith("mailto:") || push.subject.startsWith("https:"))
}

async function pushKey(deps: RouterDeps, request: Request): Promise<Response> {
  const authenticated = await requireSession(deps, request)
  if (!authenticated.ok) return authenticated.response
  if (!pushAvailable(deps.push)) return apiError(503, "internal_error", "Web Push is unavailable")
  const body: PushKeyResponse = { publicKey: deps.push.publicKey }
  return jsonResponse(body)
}

async function subscribePush(deps: RouterDeps, request: Request): Promise<Response> {
  const guarded = requireMutationGuard(request)
  if (guarded) return guarded
  const authenticated = await requireSession(deps, request)
  if (!authenticated.ok) return authenticated.response
  if (!pushAvailable(deps.push)) return apiError(503, "internal_error", "Web Push is unavailable")
  const parsed = parsePushSubscription(await readJsonBody(request))
  if (!parsed.ok) return apiError(400, parsed.error.code, parsed.error.message)
  try {
    await crypto.subtle.importKey("raw", Uint8Array.from(atob(parsed.value.keys.p256dh.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0)),
      { name: "ECDH", namedCurve: "P-256" }, false, [])
  } catch {
    return apiError(400, "invalid_message", "Push subscription key is invalid")
  }
  if ("categories" in parsed.value) {
    if (!await deps.push.store.upsert(authenticated.session.userID, authenticated.session.sessionID, parsed.value, (deps.now ?? Date.now)()))
      return apiError(401, "unauthorized", "Browser session is not authenticated")
    return jsonResponse({ subscribed: true })
  }
  const renewed = await deps.push.store.renew(authenticated.session.userID, authenticated.session.sessionID, parsed.value, (deps.now ?? Date.now)())
  if (renewed === "unauthorized") return apiError(401, "unauthorized", "Browser session is not authenticated")
  if (renewed === "missing")
    return apiError(404, "not_found", "The replaced push subscription is not registered")
  return jsonResponse({ subscribed: true })
}

async function testPush(deps: RouterDeps, request: Request, now: number): Promise<Response> {
  if (!pushAvailable(deps.push)) return apiError(503, "internal_error", "Web Push is unavailable")
  const value = await readJsonBody(request)
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "accountID" && key !== "endpoint") ||
    typeof value.accountID !== "string" || !/^usr_[A-Za-z0-9_-]{1,124}$/.test(value.accountID))
    return apiError(400, "invalid_message", "Expected an account ID and its registered push endpoint")
  const parsed = parsePushEndpoint({ endpoint: value.endpoint })
  if (!parsed.ok) return apiError(400, parsed.error.code, parsed.error.message)
  const claim = await deps.push.store.claimTest(value.accountID, parsed.value.endpoint, now)
  if (claim.status === "missing") return apiError(404, "not_found", "This device has no registered push subscription")
  if (claim.status === "limited") return apiError(429, "rate_limited", "Wait a minute before sending another test alert")
  const send = deps.fetch
  const body: PushTestResponse = await sendTestPush({ store: deps.push.store, subscription: claim.subscription, publicKey: deps.push.publicKey,
    privateKey: deps.push.privateKey, subject: deps.push.subject, now: () => now, fetch: (input, init) => send(input, init) })
  return jsonResponse(body)
}

async function unsubscribePush(deps: RouterDeps, request: Request): Promise<Response> {
  const guarded = requireMutationGuard(request)
  if (guarded) return guarded
  const authenticated = await requireSession(deps, request)
  if (!authenticated.ok) return authenticated.response
  const parsed = parsePushEndpoint(await readJsonBody(request))
  if (!parsed.ok) return apiError(400, parsed.error.code, parsed.error.message)
  if (deps.push) await deps.push.store.remove(authenticated.session.userID, parsed.value.endpoint)
  return jsonResponse({ removed: true })
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

async function deleteRevokedDevices(deps: RouterDeps, request: Request, deviceID?: string): Promise<Response> {
  const guarded = requireMutationGuard(request)
  if (guarded) return guarded
  const authenticated = await requireSession(deps, request)
  if (!authenticated.ok) return authenticated.response
  const result = await deps.service.deleteRevokedDevices(authenticated.session.userID, deviceID)
  if (result.active) return apiError(409, "invalid_message", "Revoke this device before removing it")
  return new Response(null, { status: 204 })
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

async function streamSessionContent(deps: RouterDeps, request: Request, deviceID: string, sessionID: string, item: string, message: boolean): Promise<Response> {
  if (isCrossSiteRequest(request) || (request.headers.has("origin") ? !isSameOrigin(request) : request.headers.get("sec-fetch-site") !== "same-origin"))
    return apiError(403, "forbidden", "Message reads require a same-origin request")
  const authenticated = await requireSession(deps, request)
  if (!authenticated.ok) return authenticated.response
  if (!isSessionID(sessionID) || sessionID.length > 128 ||
    (message ? !/^msg_[A-Za-z0-9_-]+$/.test(item) || item.length > 128 : !/^[0-9a-f]{64}$/.test(item)))
    return apiError(400, "invalid_message", "Invalid Session content ID")
  const authorized = await deps.service.authorizeClientCommand(authenticated.session.sessionID, deviceID)
  if (!authorized.ok) {
    if (authorized.reason === "not_owner") return apiError(403, "forbidden", "Device belongs to another owner")
    if (authorized.reason === "unknown_device") return apiError(404, "not_found", "Unknown device")
    return apiError(401, "unauthorized", "Browser session or device is no longer authorized")
  }
  return withSecurityHeaders(await deps.relay.getByName(`${authorized.value.userID}:${deviceID}`).fetch(new Request(
    `https://relay.internal/_ycoding/stream-${message ? "message" : "attachment"}`,
    { method: "POST", signal: request.signal, headers: {
      "x-ycoding-internal": "1",
      "x-ycoding-owner": authorized.value.userID,
      "x-ycoding-device": deviceID,
      "x-ycoding-browser-session": authenticated.session.sessionID,
      "x-ycoding-credential-expires-at": String(authenticated.session.expiresAt),
      "x-ycoding-target-session": sessionID,
      [message ? "x-ycoding-target-message" : "x-ycoding-target-digest"]: item,
    } },
  )))
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

async function withPresence(
  deps: RouterDeps,
  ownerID: string,
  devices: readonly Omit<DevicesResponse["devices"][number], "online">[],
): Promise<DevicesResponse["devices"]> {
  return Promise.all(
    devices.map(async (device) => ({
      ...device,
      online: device.status === "active" && (await readPresence(deps, ownerID, device.id)),
    })),
  )
}

async function readPresence(deps: RouterDeps, ownerID: string, deviceID: string): Promise<boolean> {
  try {
    const response = await deps.relay
      .getByName(`${ownerID}:${deviceID}`)
      .fetch(new Request("https://relay.internal/_ycoding/presence", {
        headers: { "x-ycoding-internal": "1" },
      }))
    if (!response.ok) return false
    const value: unknown = await response.json()
    return typeof value === "object" && value !== null && Reflect.get(value, "online") === true
  } catch {
    return false
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
