import { describe, expect, test } from "bun:test"
import { browserSessionTtlMs, createAuthService } from "../src/auth/service"
import { parseAllowedEmails } from "../src/auth/allowlist"
import { boundedCleanupInterval, cleanupIntervalMs, maxCleanupIntervalMs, minCleanupIntervalMs } from "../src/router"
import { sha256Hex } from "../src/auth/crypto"
import { clearCookie, readCookie, setCookie } from "../src/http"
import { createRouter, type RelayNamespace } from "../src/router"
import { RemoteWebSocketPath, deviceSignaturePayload, type RemotePublicKey } from "../../../packages/remote/src/index"
import { createMemoryAuthStore } from "./support/memory-store"
import {
  googleFetch,
  rsaIdentity,
  signedToken,
  testAllowedEmail,
  testClaims,
  testEndpoints,
  testClientID,
  testIssuer,
} from "./support/google"
import { base64UrlEncode } from "../src/auth/crypto"

const origin = "https://relay.test"
const sameOrigin = { origin }
const crossSite = { origin: "https://evil.example", "sec-fetch-site": "cross-site" }

async function harness(
  options: {
    readonly rateLimit?: (key: string) => boolean
    readonly allowedEmails?: ReadonlySet<string>
    readonly service?: ReturnType<typeof createAuthService>
    readonly assets?: { readonly fetch: (request: Request) => Promise<Response> }
    readonly cleanupEveryMs?: number
    readonly relay?: RelayNamespace
  } = {},
) {
  let now = 1_700_000_000_000
  const store = createMemoryAuthStore()
  const service = options.service ?? createAuthService(store, { now: () => now })
  const relayCalls: { readonly name: string; readonly request: Request }[] = []
  const relay = options.relay ?? {
    getByName: (name: string) => ({
      fetch: async (request: Request) => {
        relayCalls.push({ name, request })
        return new Response("relay-ok", { status: 200 })
      },
    }),
  }
  const identity = await rsaIdentity()
  const endpoints = testEndpoints()
  let idToken = ""
  const router = createRouter({
    service,
    relay,
    endpoints,
    allowedEmails: options.allowedEmails ?? new Set([testAllowedEmail]),
    fetch: googleFetch({ jwk: identity.jwk, idToken: () => idToken }),
    now: () => now,
    ...(options.cleanupEveryMs === undefined ? {} : { cleanupEveryMs: options.cleanupEveryMs }),
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    ...(options.assets === undefined ? {} : { assets: options.assets }),
  })
  return {
    store,
    service,
    router,
    relayCalls,
    identity,
    endpoints,
    setIDToken: (value: string) => {
      idToken = value
    },
    advance: (milliseconds: number) => {
      now += milliseconds
    },
    at: () => now,
  }
}

type Harness = Awaited<ReturnType<typeof harness>>

async function signIn(h: Harness, subject = "subject-1") {
  return h.service.signIn({ provider: "google", subject })
}

async function enrollDevice(h: Harness, userID: string, name = "Studio Mac") {
  const created = await h.service.createEnrollment(userID)
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  const publicKey: RemotePublicKey = { kty: "EC", crv: "P-256", x: jwk.x ?? "", y: jwk.y ?? "" }
  const completed = await h.service.completeEnrollment({
    enrollmentID: created.enrollmentID,
    code: created.code,
    name,
    publicKey,
  })
  if (!completed.ok) throw new Error("enrollment failed")
  return { pair, deviceID: completed.value.deviceID, code: created.code, enrollmentID: created.enrollmentID }
}

function sessionCookie(token: string) {
  return { cookie: setCookie("yc_session", token, { maxAgeSeconds: 3600, path: "/" }).split(";")[0]! }
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("router: health and unknown routes", () => {
  test("reports health and leaves unknown paths to the asset deployment", async () => {
    const h = await harness()
    expect((await h.router(new Request(`${origin}/health`))).status).toBe(200)
    expect((await h.router(new Request(`${origin}/`))).status).toBe(404)
    expect((await h.router(new Request(`${origin}/remote/chat`))).status).toBe(404)
    expect((await h.router(new Request(`${origin}/api/unknown`))).status).toBe(404)
    expect((await h.router(new Request(`${origin}/api/me`, { method: "POST" }))).status).toBe(405)
  })
})

describe("router: google sign-in", () => {
  test("starts sign-in with PKCE, state, nonce, and a scoped transaction cookie", async () => {
    const h = await harness()
    const response = await h.router(new Request(`${origin}/api/auth/google/start?redirect_after=/remote/chat`))
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location") ?? "")
    expect(location.origin + location.pathname).toBe(`${testIssuer}/authorize`)
    expect(location.searchParams.get("code_challenge_method")).toBe("S256")
    expect(location.searchParams.get("response_type")).toBe("code")
    expect(location.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/google/callback`)
    expect(location.searchParams.get("state")).toBeTruthy()

    const cookie = response.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("yc_oauth=")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Path=/api/auth")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("completes sign-in without an Origin header and issues a session cookie", async () => {
    const h = await harness()
    const started = await h.router(new Request(`${origin}/api/auth/google/start?redirect_after=/remote/chat`))
    const oauthCookie = started.headers.get("set-cookie") ?? ""
    const cookieToken = readCookie(oauthCookie, "yc_oauth") ?? ""
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? ""
    const transaction = await h.store.findOAuthTransaction(await sha256Hex(cookieToken))
    h.setIDToken(await signedToken(h.identity.pair, testClaims({ nonce: transaction?.nonce })))

    const callback = await h.router(
      new Request(`${origin}/api/auth/google/callback?code=code-1&state=${state}`, {
        headers: { cookie: `yc_oauth=${cookieToken}` },
      }),
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe("/remote/chat")
    const sessionCookie = callback.headers.get("set-cookie") ?? ""
    expect(sessionCookie).toContain("yc_session=")
    expect(sessionCookie).toContain("Path=/")
    expect(sessionCookie).toContain(clearCookie("yc_oauth", "/api/auth").split(";")[0] ?? "yc_oauth=")

    const sessionToken = readCookie(sessionCookie, "yc_session") ?? ""
    const session = await h.service.resolveBrowserSession(sessionToken)
    expect(session.ok).toBe(true)
  })

  test("rejects invalid state, replayed transactions, and unauthenticated callbacks", async () => {
    const h = await harness()
    const started = await h.router(new Request(`${origin}/api/auth/google/start`))
    const cookieToken = readCookie(started.headers.get("set-cookie"), "yc_oauth") ?? ""
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? ""
    const transaction = await h.store.findOAuthTransaction(await sha256Hex(cookieToken))
    h.setIDToken(await signedToken(h.identity.pair, testClaims({ nonce: transaction?.nonce })))

    const wrongState = await h.router(
      new Request(`${origin}/api/auth/google/callback?code=code-1&state=attacker`, {
        headers: { cookie: `yc_oauth=${cookieToken}` },
      }),
    )
    expect(wrongState.status).toBe(302)
    expect(wrongState.headers.get("location")).toBe("/remote/?auth=error")

    const replayed = await h.router(
      new Request(`${origin}/api/auth/google/callback?code=code-1&state=${state}`, {
        headers: { cookie: `yc_oauth=${cookieToken}` },
      }),
    )
    expect(replayed.headers.get("location")).toBe("/remote/?auth=error")

    const noCookie = await h.router(new Request(`${origin}/api/auth/google/callback?code=code-1&state=${state}`))
    expect(noCookie.headers.get("location")).toBe("/remote/?auth=error")
    expect(h.relayCalls).toEqual([])
  })

  test("rejects an id token whose nonce, audience, or signature does not match", async () => {
    const cases: ((current: Harness) => Promise<string>)[] = [
      async (current) => signedToken(current.identity.pair, testClaims({ nonce: "replayed-nonce" })),
      async (current) => signedToken(current.identity.pair, testClaims({ aud: "other-client" })),
      async (current) => signedToken(current.identity.pair, testClaims({ iss: "https://accounts.evil.example" })),
      async (current) => signedToken(current.identity.pair, testClaims({ exp: 1 })),
      async () => {
        const other = await rsaIdentity()
        return signedToken(other.pair, testClaims())
      },
      async () => "not-a-jwt",
    ]
    for (const build of cases) {
      const h = await harness()
      const started = await h.router(new Request(`${origin}/api/auth/google/start`))
      const cookieToken = readCookie(started.headers.get("set-cookie"), "yc_oauth") ?? ""
      const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? ""
      h.setIDToken(await build(h))

      const callback = await h.router(
        new Request(`${origin}/api/auth/google/callback?code=code-1&state=${state}`, {
          headers: { cookie: `yc_oauth=${cookieToken}` },
        }),
      )
      expect(callback.headers.get("location")).toBe("/remote/?auth=error")
      expect(callback.headers.get("set-cookie")).not.toContain("yc_session=")
    }

    const unconfigured = createRouter({
      service: createAuthService(createMemoryAuthStore()),
      relay: { getByName: () => ({ fetch: async () => new Response(null) }) },
      endpoints: testEndpoints({ clientId: "", clientSecret: "" }),
      fetch: googleFetch({ jwk: (await rsaIdentity()).jwk, idToken: () => "" }),
    })
    expect((await unconfigured(new Request(`${origin}/api/auth/google/start`))).status).toBe(503)
  })
})

describe("router: browser session routes", () => {
  test("reads /api/me without an Origin header and without writing cookies", async () => {
    const h = await harness()
    const session = await signIn(h)
    const response = await h.router(new Request(`${origin}/api/me`, { headers: sessionCookie(session.token) }))
    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toBeNull()
    const body = (await response.json()) as { user: { id: string }; devices: unknown[] }
    expect(body.user.id).toBe(session.userID)
    expect(body.devices).toEqual([])
  })

  test("rejects unauthenticated and revoked sessions on read routes", async () => {
    const h = await harness()
    expect((await h.router(new Request(`${origin}/api/me`))).status).toBe(401)
    expect((await h.router(new Request(`${origin}/api/devices`))).status).toBe(401)

    const session = await signIn(h)
    await h.service.signOut(session.token)
    const revoked = await h.router(new Request(`${origin}/api/me`, { headers: sessionCookie(session.token) }))
    expect(revoked.status).toBe(401)
    // `GET /api/me` is read-only and writes no cookie: a dead cookie stays
    // non-authoritative until sign-in or explicit logout replaces it, and deleting it
    // here could discard a newer cookie a concurrent rotation already installed.
    expect(revoked.headers.get("set-cookie")).toBeNull()
  })

  test("rotates the browser session only on the explicit same-origin route", async () => {
    const h = await harness()
    const session = await signIn(h)
    h.advance(16 * 24 * 60 * 60 * 1000)

    expect(
      (await h.router(new Request(`${origin}/api/auth/session/refresh`, { method: "POST", headers: sessionCookie(session.token) }))).status,
    ).toBe(403)
    expect(
      (
        await h.router(
          new Request(`${origin}/api/auth/session/refresh`, {
            method: "POST",
            headers: { ...sessionCookie(session.token), ...crossSite },
          }),
        )
      ).status,
    ).toBe(403)

    const rotated = await h.router(
      new Request(`${origin}/api/auth/session/refresh`, {
        method: "POST",
        headers: { ...sessionCookie(session.token), ...sameOrigin },
      }),
    )
    expect(rotated.status).toBe(200)
    const rotatedToken = readCookie(rotated.headers.get("set-cookie"), "yc_session") ?? ""
    expect(rotatedToken).not.toBe(session.token)
    expect((await h.service.resolveBrowserSession(session.token)).ok).toBe(false)
    expect((await h.service.resolveBrowserSession(rotatedToken)).ok).toBe(true)
  })

  test("signs out on a same-origin mutation and closes every device's relay sockets", async () => {
    const h = await harness()
    const session = await signIn(h)
    const first = await enrollDevice(h, session.userID)
    const second = await enrollDevice(h, session.userID, "Second Mac")

    const response = await h.router(
      new Request(`${origin}/api/auth/logout`, { method: "POST", headers: { ...sessionCookie(session.token), ...sameOrigin } }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0")
    expect((await h.service.resolveBrowserSession(session.token)).ok).toBe(false)
    expect(h.relayCalls.map((call) => call.name).sort()).toEqual(
      [`${session.userID}:${first.deviceID}`, `${session.userID}:${second.deviceID}`].sort(),
    )
    for (const call of h.relayCalls) {
      expect(new URL(call.request.url).pathname).toBe("/_ycoding/revoke-session")
      expect(call.request.headers.get("x-ycoding-target-session")).toBe(session.sessionID)
    }
  })

  test("does not notify relay objects for a signed-out session's untouched devices", async () => {
    const h = await harness()
    const owner = await signIn(h, "owner")
    const other = await signIn(h, "other")
    await enrollDevice(h, other.userID)

    await h.router(new Request(`${origin}/api/auth/logout`, { method: "POST", headers: { ...sessionCookie(owner.token), ...sameOrigin } }))
    expect(h.relayCalls).toEqual([])
  })

  test("closes sockets of the replaced session after rotation", async () => {
    const h = await harness()
    const session = await signIn(h)
    const device = await enrollDevice(h, session.userID)
    h.advance(16 * 24 * 60 * 60 * 1000)

    const rotated = await h.router(
      new Request(`${origin}/api/auth/session/refresh`, {
        method: "POST",
        headers: { ...sessionCookie(session.token), ...sameOrigin },
      }),
    )
    expect(rotated.status).toBe(200)
    expect(h.relayCalls.map((call) => call.name)).toEqual([`${session.userID}:${device.deviceID}`])
    expect(h.relayCalls[0]!.request.headers.get("x-ycoding-target-session")).toBe(session.sessionID)
  })

  test("keeps the session read-only on GET while rotation is a mutation", async () => {
    const h = await harness()
    const session = await signIn(h)
    const before = await h.router(new Request(`${origin}/api/me`, { headers: sessionCookie(session.token) }))
    expect(before.headers.get("set-cookie")).toBeNull()
    expect(h.relayCalls).toEqual([])
  })

  test("lists only the authenticated owner's devices", async () => {
    const h = await harness()
    const owner = await signIn(h, "owner")
    const intruder = await signIn(h, "intruder")
    const device = await enrollDevice(h, owner.userID)

    const ownerList = (await (
      await h.router(new Request(`${origin}/api/devices`, { headers: sessionCookie(owner.token) }))
    ).json()) as { devices: { id: string; online: boolean }[] }
    expect(ownerList.devices.map((entry) => entry.id)).toEqual([device.deviceID])
    expect(ownerList.devices[0]?.online).toBe(false)

    const intruderList = (await (
      await h.router(new Request(`${origin}/api/devices`, { headers: sessionCookie(intruder.token) }))
    ).json()) as { devices: unknown[] }
    expect(intruderList.devices).toEqual([])
  })

  test("reports authenticated relay presence instead of enrollment or last-seen state", async () => {
    const online = new Set<string>()
    const h = await harness({
      relay: {
        getByName: (name) => ({
          fetch: async (request) =>
            new URL(request.url).pathname === "/_ycoding/presence"
              ? Response.json({ online: online.has(name) })
              : new Response(null, { status: 204 }),
        }),
      },
    })
    const owner = await signIn(h, "owner")
    const first = await enrollDevice(h, owner.userID)
    const second = await enrollDevice(h, owner.userID, "Offline Mac")
    online.add(`${owner.userID}:${first.deviceID}`)

    const response = await h.router(new Request(`${origin}/api/devices`, { headers: sessionCookie(owner.token) }))
    const body = (await response.json()) as { devices: { id: string; online: boolean }[] }
    expect(new Map(body.devices.map((device) => [device.id, device.online]))).toEqual(
      new Map([
        [first.deviceID, true],
        [second.deviceID, false],
      ]),
    )
  })
})

describe("router: device enrollment and credentials", () => {
  test("mints a one-use enrollment code for a same-origin browser request", async () => {
    const h = await harness()
    const session = await signIn(h)
    expect(
      (await h.router(new Request(`${origin}/api/devices/enrollments`, { method: "POST", headers: sessionCookie(session.token) }))).status,
    ).toBe(403)

    const created = await h.router(
      new Request(`${origin}/api/devices/enrollments`, {
        method: "POST",
        headers: { ...sessionCookie(session.token), ...sameOrigin },
      }),
    )
    expect(created.status).toBe(200)
    const body = (await created.json()) as { enrollmentID: string; code: string }
    expect(body.code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/)

    const enrolled = await h.router(
      jsonRequest(`${origin}/api/devices/enroll`, {
        enrollmentID: body.enrollmentID,
        code: body.code,
        name: "Studio Mac",
        publicKey: { kty: "EC", crv: "P-256", x: "a".repeat(43), y: "b".repeat(43) },
      }),
    )
    expect(enrolled.status).toBe(200)
    expect((await enrolled.json()) as { deviceID: string }).toMatchObject({ deviceID: expect.stringContaining("dev_") })

    const replay = await h.router(
      jsonRequest(`${origin}/api/devices/enroll`, {
        enrollmentID: body.enrollmentID,
        code: body.code,
        name: "Studio Mac",
        publicKey: { kty: "EC", crv: "P-256", x: "a".repeat(43), y: "b".repeat(43) },
      }),
    )
    expect(replay.status).toBe(400)
  })

  test("rejects malformed and oversized enrollment bodies without an Origin header", async () => {
    const h = await harness()
    expect((await h.router(jsonRequest(`${origin}/api/devices/enroll`, { code: "nope" }))).status).toBe(400)
    expect(
      (
        await h.router(
          new Request(`${origin}/api/devices/enroll`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enrollmentID: "enr_1", code: "x".repeat(9000) }),
          }),
        )
      ).status,
    ).toBe(400)
    expect((await h.router(new Request(`${origin}/api/devices/enroll`))).status).toBe(405)
  })

  test("runs the challenge, token, and rotation flow headlessly", async () => {
    const h = await harness()
    const owner = await signIn(h, "owner")
    const device = await enrollDevice(h, owner.userID)

    const challenge = await h.router(jsonRequest(`${origin}/api/devices/challenge`, { deviceID: device.deviceID }))
    expect(challenge.status).toBe(200)
    const challengeBody = (await challenge.json()) as { challengeID: string; nonce: string }

    const signature = base64UrlEncode(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          device.pair.privateKey,
          new TextEncoder().encode(deviceSignaturePayload(challengeBody.challengeID, challengeBody.nonce)),
        ),
      ),
    )
    const issued = await h.router(
      jsonRequest(`${origin}/api/devices/token`, {
        deviceID: device.deviceID,
        challengeID: challengeBody.challengeID,
        signature,
      }),
    )
    expect(issued.status).toBe(200)
    const tokens = (await issued.json()) as { accessToken: string; refreshToken: string }

    const replay = await h.router(
      jsonRequest(`${origin}/api/devices/token`, {
        deviceID: device.deviceID,
        challengeID: challengeBody.challengeID,
        signature,
      }),
    )
    expect(replay.status).toBe(401)

    const refreshed = await h.router(
      jsonRequest(`${origin}/api/devices/refresh`, { deviceID: device.deviceID, refreshToken: tokens.refreshToken }),
    )
    expect(refreshed.status).toBe(200)
    const rotated = (await refreshed.json()) as { refreshToken: string }
    expect(
      (
        await h.router(
          jsonRequest(`${origin}/api/devices/refresh`, { deviceID: device.deviceID, refreshToken: tokens.refreshToken }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await h.router(
          jsonRequest(`${origin}/api/devices/refresh`, { deviceID: device.deviceID, refreshToken: rotated.refreshToken }),
        )
      ).status,
    ).toBe(200)
  })

  test("refuses a challenge for an unknown device with a generic failure", async () => {
    const h = await harness()
    const response = await h.router(jsonRequest(`${origin}/api/devices/challenge`, { deviceID: "dev_unknown" }))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Device is not available for authentication" } })
  })

  test("rate limits device credential routes by client address", async () => {
    const h = await harness({ rateLimit: () => false })
    const response = await h.router(jsonRequest(`${origin}/api/devices/challenge`, { deviceID: "dev_1" }))
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: { code: "rate_limited", message: "Too many requests" } })
  })

  test("revokes an owned device, closes its relay sockets, and rejects other owners", async () => {
    const h = await harness()
    const owner = await signIn(h, "owner")
    const intruder = await signIn(h, "intruder")
    const device = await enrollDevice(h, owner.userID)

    expect(
      (
        await h.router(
          new Request(`${origin}/api/devices/${device.deviceID}/revoke`, {
            method: "POST",
            headers: { ...sessionCookie(intruder.token), ...sameOrigin },
          }),
        )
      ).status,
    ).toBe(403)

    const revoked = await h.router(
      new Request(`${origin}/api/devices/${device.deviceID}/revoke`, {
        method: "POST",
        headers: { ...sessionCookie(owner.token), ...sameOrigin },
      }),
    )
    expect(revoked.status).toBe(200)
    expect(h.relayCalls.at(-1)?.name).toBe(`${owner.userID}:${device.deviceID}`)
    expect(new URL(h.relayCalls.at(-1)?.request.url ?? "").pathname).toBe("/_ycoding/close-device")
    expect((await h.service.createChallenge(device.deviceID)).ok).toBe(false)
    const listed = (await (
      await h.router(new Request(`${origin}/api/devices`, { headers: sessionCookie(owner.token) }))
    ).json()) as { devices: { id: string; status: string; online: boolean }[] }
    expect(listed.devices.find((entry) => entry.id === device.deviceID)).toMatchObject({
      status: "revoked",
      online: false,
    })
  })
})

describe("router: websocket upgrades", () => {
  test("requires a same-origin Origin on the browser socket", async () => {
    const h = await harness()
    const session = await signIn(h)
    const device = await enrollDevice(h, session.userID)
    const url = `${origin}${RemoteWebSocketPath.client}?device=${device.deviceID}`
    const upgrade = { upgrade: "websocket" }

    expect((await h.router(new Request(url))).status).toBe(426)
    expect(
      (
        await h.router(
          new Request(url, {
            headers: { ...upgrade, ...sessionCookie(session.token), "sec-fetch-site": "cross-site", origin: "https://evil.example" },
          }),
        )
      ).status,
    ).toBe(403)
    expect(
      (await h.router(new Request(url, { headers: { ...upgrade, ...sessionCookie(session.token) } }))).status,
    ).toBe(403)
    expect((await h.router(new Request(url, { headers: upgrade }))).status).toBe(403)
  })

  test("forwards trusted relay headers and strips browser-supplied ones", async () => {
    const h = await harness()
    const session = await signIn(h)
    const device = await enrollDevice(h, session.userID)
    const response = await h.router(
      new Request(`${origin}${RemoteWebSocketPath.client}?device=${device.deviceID}`, {
        headers: {
          upgrade: "websocket",
          origin,
          "x-ycoding-role": "agent",
          "x-ycoding-owner": "usr_attacker",
          "x-ycoding-device": "dev_attacker",
          ...sessionCookie(session.token),
        },
      }),
    )
    expect(response.status).toBe(200)
    const called = h.relayCalls.at(-1)!
    expect(called.name).toBe(`${session.userID}:${device.deviceID}`)
    expect(called.request.headers.get("x-ycoding-role")).toBe("client")
    expect(called.request.headers.get("x-ycoding-owner")).toBe(session.userID)
    expect(called.request.headers.get("x-ycoding-device")).toBe(device.deviceID)
    expect(called.request.headers.get("x-ycoding-browser-session")).toBe(session.sessionID)
    expect(called.request.headers.get("x-ycoding-credential-expires-at")).toBe(String(session.expiresAt))
  })

  test("rejects an unowned or unknown device on the browser socket", async () => {
    const h = await harness()
    const owner = await signIn(h, "owner")
    const intruder = await signIn(h, "intruder")
    const device = await enrollDevice(h, owner.userID)
    const upgrade = { upgrade: "websocket", origin }

    expect(
      (
        await h.router(
          new Request(`${origin}${RemoteWebSocketPath.client}?device=${device.deviceID}`, {
            headers: { ...upgrade, ...sessionCookie(intruder.token) },
          }),
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await h.router(
          new Request(`${origin}${RemoteWebSocketPath.client}?device=dev_unknown`, { headers: { ...upgrade, ...sessionCookie(owner.token) } }),
        )
      ).status,
    ).toBe(404)
    expect(
      (await h.router(new Request(`${origin}${RemoteWebSocketPath.client}`, { headers: { ...upgrade, ...sessionCookie(owner.token) } }))).status,
    ).toBe(400)
  })

  test("authenticates the agent socket with a bearer access credential only", async () => {
    const h = await harness()
    const owner = await signIn(h, "owner")
    const device = await enrollDevice(h, owner.userID)
    const issued = await h.service.issueCredentials(device.deviceID)
    if (!issued.ok) throw new Error("issue failed")
    const url = `${origin}${RemoteWebSocketPath.agent}`
    const upgrade = { upgrade: "websocket" }

    expect((await h.router(new Request(url))).status).toBe(426)
    expect((await h.router(new Request(url, { headers: { ...upgrade, authorization: "Bearer short" } }))).status).toBe(401)
    expect(
      (
        await h.router(
          new Request(url, { headers: { ...upgrade, authorization: `Bearer ${issued.value.refreshToken}` } }),
        )
      ).status,
    ).toBe(401)
    expect(
      (await h.router(new Request(url, { headers: { ...upgrade, cookie: `yc_session=${owner.token}` } }))).status,
    ).toBe(401)

    const accepted = await h.router(new Request(url, { headers: { ...upgrade, authorization: `Bearer ${issued.value.accessToken}` } }))
    expect(accepted.status).toBe(200)
    const called = h.relayCalls.at(-1)!
    expect(called.name).toBe(`${owner.userID}:${device.deviceID}`)
    expect(called.request.headers.get("x-ycoding-role")).toBe("agent")
    expect(called.request.headers.get("authorization")).toBe(`Bearer ${issued.value.accessToken}`)
  })

  test("rejects a revoked device on the agent socket", async () => {
    const h = await harness()
    const owner = await signIn(h, "owner")
    const device = await enrollDevice(h, owner.userID)
    const issued = await h.service.issueCredentials(device.deviceID)
    if (!issued.ok) throw new Error("issue failed")
    await h.service.revokeDevice({ deviceID: device.deviceID, userID: owner.userID })
    const response = await h.router(
      new Request(`${origin}${RemoteWebSocketPath.agent}`, {
        headers: { upgrade: "websocket", authorization: `Bearer ${issued.value.accessToken}` },
      }),
    )
    expect(response.status).toBe(401)
    expect(h.relayCalls).toEqual([])
  })

  test("rejects missing, old, and unknown WebSocket protocol routes before upgrade", async () => {
    const h = await harness()
    for (const path of ["/ws/client", "/ws/agent", "/ws/v1/client", "/ws/v1/agent", "/ws/v2/client", "/ws/v2/agent", "/ws/v4/client", "/ws/v4/agent"])
      expect((await h.router(new Request(`${origin}${path}`, { headers: { upgrade: "websocket" } }))).status).toBe(404)
    expect(h.relayCalls).toEqual([])
  })
})

describe("router: google client id", () => {
  test("uses the configured client id for audience checks", async () => {
    expect(testClientID).toContain("apps.googleusercontent.com")
    expect(testEndpoints().clientId).toBe(testClientID)
  })
})

async function completeSignIn(h: Harness, claims: Record<string, unknown> = {}) {
  const started = await h.router(new Request(`${origin}/api/auth/google/start`))
  const cookieToken = readCookie(started.headers.get("set-cookie"), "yc_oauth") ?? ""
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? ""
  const transaction = await h.store.findOAuthTransaction(await sha256Hex(cookieToken))
  h.setIDToken(await signedToken(h.identity.pair, { ...testClaims({ nonce: transaction?.nonce }), ...claims }))
  return h.router(
    new Request(`${origin}/api/auth/google/callback?code=code-1&state=${state}`, {
      headers: { cookie: `yc_oauth=${cookieToken}` },
    }),
  )
}

describe("router: sign-in allowlist", () => {
  test("admits an allowlisted verified account", async () => {
    const h = await harness()
    const response = await completeSignIn(h)
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/remote/")
    expect(response.headers.get("set-cookie")).toContain("yc_session=")
  })

  test("denies an unapproved account without leaking configured addresses", async () => {
    const h = await harness()
    const response = await completeSignIn(h, { email: "stranger@example.invalid" })
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/remote/?auth=error")
    expect(response.headers.get("set-cookie") ?? "").not.toContain("yc_session=")
    expect(await response.text()).not.toContain(testAllowedEmail)
    expect(h.relayCalls).toEqual([])
  })

  test("denies an allowlisted address whose email is not verified", async () => {
    const h = await harness()
    const response = await completeSignIn(h, { email_verified: false })
    expect(response.headers.get("location")).toBe("/remote/?auth=error")
    const unverified = await completeSignIn(h, { email_verified: "false" })
    expect(unverified.headers.get("location")).toBe("/remote/?auth=error")
  })

  test("denies every account when the allowlist is missing or empty", async () => {
    for (const allowedEmails of [new Set<string>(), new Set([" "]), new Set([""])]) {
      const h = await harness({ allowedEmails })
      const response = await completeSignIn(h)
      expect(response.headers.get("location")).toBe("/remote/?auth=error")
      expect(response.headers.get("set-cookie") ?? "").not.toContain("yc_session=")
    }
  })

  test("denies an identity without an email claim and matches exactly", async () => {
    const absent = await harness()
    expect((await completeSignIn(absent, { email: undefined })).headers.get("location")).toBe("/remote/?auth=error")

    const suffix = await harness({ allowedEmails: new Set(["example.invalid"]) })
    expect((await completeSignIn(suffix)).headers.get("location")).toBe("/remote/?auth=error")

    const variant = await harness()
    expect((await completeSignIn(variant, { email: "owner@example.invalid.evil" })).headers.get("location")).toBe(
      "/remote/?auth=error",
    )
  })

  test("normalizes configured addresses and the presented claim", async () => {
    const h = await harness({ allowedEmails: parseAllowedEmails({ GOOGLE_ALLOWED_EMAILS: " Owner@Example.INVALID ,second@example.invalid\n" }) })
    expect((await completeSignIn(h)).headers.get("location")).toBe("/remote/")
  })

  test("rate limits repeated unauthenticated sign-in starts", async () => {
    const h = await harness({ rateLimit: (key) => !key.startsWith("oauth-start:") })
    const response = await h.router(new Request(`${origin}/api/auth/google/start`))
    expect(response.status).toBe(429)
  })
})

describe("router: expired metadata cleanup", () => {
  test("sweeps at most once per interval and keeps serving requests", async () => {
    const store = createMemoryAuthStore()
    let sweeps = 0
    const counting = {
      ...store,
      deleteExpired: async (now: number, retentionMs: number, limit: number) => {
        sweeps += 1
        return store.deleteExpired(now, retentionMs, limit)
      },
    }
    const h = await harness({ service: createAuthService(counting, { now: () => Date.now() }) })
    await h.router(new Request(`${origin}/api/me`))
    await h.router(new Request(`${origin}/api/me`))
    expect(sweeps).toBe(1)

    h.advance(cleanupIntervalMs + 1)
    await h.router(new Request(`${origin}/api/me`))
    expect(sweeps).toBe(2)
  })

  test("clamps an operator sweep cadence to the bounded range", () => {
    expect(boundedCleanupInterval(undefined)).toBe(cleanupIntervalMs)
    expect(boundedCleanupInterval("nonsense")).toBe(cleanupIntervalMs)
    expect(boundedCleanupInterval(String(minCleanupIntervalMs - 1))).toBe(cleanupIntervalMs)
    expect(boundedCleanupInterval(String(maxCleanupIntervalMs + 1))).toBe(cleanupIntervalMs)
    expect(boundedCleanupInterval(String(minCleanupIntervalMs))).toBe(minCleanupIntervalMs)
    expect(boundedCleanupInterval("30000")).toBe(30_000)
  })

  test("honours a bounded sweep cadence override", async () => {
    const store = createMemoryAuthStore()
    let sweeps = 0
    const counting = {
      ...store,
      deleteExpired: async (now: number, retentionMs: number, limit: number) => {
        sweeps += 1
        return store.deleteExpired(now, retentionMs, limit)
      },
    }
    const h = await harness({ service: createAuthService(counting, { now: () => Date.now() }), cleanupEveryMs: 1_000 })
    await h.router(new Request(`${origin}/api/me`))
    await h.router(new Request(`${origin}/api/me`))
    expect(sweeps).toBe(1)
    h.advance(1_001)
    await h.router(new Request(`${origin}/api/me`))
    expect(sweeps).toBe(2)
  })

  test("serves requests even when cleanup fails", async () => {
    const store = createMemoryAuthStore()
    const failing = {
      ...store,
      deleteExpired: async () => {
        throw new Error("database unavailable")
      },
    }
    const h = await harness({ service: createAuthService(failing, { now: () => Date.now() }) })
    expect((await h.router(new Request(`${origin}/health`))).status).toBe(200)
    const session = await h.service.signIn({ provider: "google", subject: "s" })
    expect((await h.router(new Request(`${origin}/api/me`, { headers: sessionCookie(session.token) }))).status).toBe(200)
  })
})

describe("router: static asset delegation", () => {
  test("delegates landing and SPA routes to the asset binding but never relay routes", async () => {
    const seen: string[] = []
    const h = await harness({
      assets: {
        fetch: async (request: Request) => {
          seen.push(new URL(request.url).pathname)
          return new Response("asset", { status: 200 })
        },
      },
    })
    expect(await (await h.router(new Request(`${origin}/`))).text()).toBe("asset")
    expect(await (await h.router(new Request(`${origin}/remote/chat`))).text()).toBe("asset")
    expect(await (await h.router(new Request(`${origin}/docs/configuration`))).text()).toBe("asset")
    expect(seen).toEqual(["/", "/remote/chat", "/docs/configuration"])

    expect((await h.router(new Request(`${origin}/api/me`))).status).toBe(401)
    expect((await h.router(new Request(`${origin}/health`))).status).toBe(200)
    expect((await h.router(new Request(`${origin}${RemoteWebSocketPath.client}?device=dev_1`))).status).toBe(426)
    expect(seen).toEqual(["/", "/remote/chat", "/docs/configuration"])
  })

  test("never delegates an unmatched relay path to the SPA shell", async () => {
    const seen: string[] = []
    const h = await harness({
      assets: {
        fetch: async (request: Request) => {
          seen.push(new URL(request.url).pathname)
          return new Response("<html>shell</html>", { status: 200, headers: { "content-type": "text/html" } })
        },
      },
    })
    for (const path of ["/api", "/api/unknown", "/ws", "/ws/smoke/agent", "/health/extra"]) {
      const response = await h.router(new Request(`${origin}${path}`))
      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")?.includes("application/json")).toBe(true)
    }
    expect(seen).toEqual([])
  })

  test("adds baseline security headers to delegated assets without dropping theirs", async () => {
    const h = await harness({
      assets: {
        fetch: async () =>
          new Response("<html></html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
          }),
      },
    })
    const response = await h.router(new Request(`${origin}/remote/deep/link`))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("public, max-age=60")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin")
    expect(response.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()")
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains")
  })

  test("adds security headers to worker JSON, redirect, and 404 responses", async () => {
    const h = await harness()
    const unauthorized = await h.router(new Request(`${origin}/api/me`))
    expect(unauthorized.headers.get("x-content-type-options")).toBe("nosniff")
    expect(unauthorized.headers.get("x-frame-options")).toBe("DENY")
    const started = await h.router(new Request(`${origin}/api/auth/google/start`))
    expect(started.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
    const missing = await h.router(new Request(`${origin}/nope`))
    expect(missing.status).toBe(404)
    expect(missing.headers.get("x-content-type-options")).toBe("nosniff")
  })

  test("returns the relay upgrade response untouched", async () => {
    const upstream = new Response("upgrade", { status: 200, headers: { "x-relay-marker": "kept" } })
    const h = await harness({ assets: undefined })
    const router = createRouter({
      service: h.service,
      relay: { getByName: () => ({ fetch: async () => upstream }) },
      endpoints: testEndpoints(),
      allowedEmails: new Set([testAllowedEmail]),
      fetch: googleFetch({ jwk: h.identity.jwk, idToken: () => "" }),
      now: () => Date.now(),
    })
    const session = await h.service.signIn({ provider: "google", subject: "subject-1" })
    const device = await enrollDevice(h, session.userID)
    const forwarded = await router(
      new Request(`${origin}${RemoteWebSocketPath.client}?device=${device.deviceID}`, {
        headers: { upgrade: "websocket", origin, ...sessionCookie(session.token) },
      }),
    )
    expect(forwarded).toBe(upstream)
    expect(forwarded.headers.get("x-relay-marker")).toBe("kept")
    expect(forwarded.headers.get("x-content-type-options")).toBeNull()
  })

  test("reports 404 when no asset binding is configured", async () => {
    const h = await harness()
    expect((await h.router(new Request(`${origin}/`))).status).toBe(404)
  })
})

describe("router: revocation pushes, failure boundaries, and cookie hygiene", () => {
  function clock() {
    let value = 1_700_000_000_000
    return {
      now: () => value,
      advance: (milliseconds: number) => {
        value += milliseconds
      },
    }
  }

  async function serviceWith(options: { readonly failListDevices?: boolean } = {}) {
    const time = clock()
    const store = createMemoryAuthStore()
    const base = createAuthService(store, { now: time.now })
    const service = options.failListDevices
      ? {
          ...base,
          listDevices: async (): Promise<readonly never[]> => {
            throw new Error("device store unavailable")
          },
        }
      : base
    return { time, service }
  }

  test("completes sign-out when device enumeration fails", async () => {
    const { service } = await serviceWith({ failListDevices: true })
    const session = await service.signIn({ provider: "google", subject: "subject-1" })
    const h = await harness({ service })

    const response = await h.router(
      new Request(`${origin}/api/auth/logout`, {
        method: "POST",
        headers: { ...sessionCookie(session.token), ...sameOrigin },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0")
    expect(await response.json()).toEqual({ signedOut: true })
    expect((await service.resolveBrowserSession(session.token)).ok).toBe(false)
  })

  test("returns the rotated cookie when device enumeration fails", async () => {
    const { time, service } = await serviceWith({ failListDevices: true })
    const session = await service.signIn({ provider: "google", subject: "subject-2" })
    time.advance(browserSessionTtlMs / 2 + 1)
    const h = await harness({ service })

    const response = await h.router(
      new Request(`${origin}/api/auth/session/refresh`, {
        method: "POST",
        headers: { ...sessionCookie(session.token), ...sameOrigin },
      }),
    )

    expect(response.status).toBe(200)
    const rotated = readCookie(response.headers.get("set-cookie"), "yc_session")
    expect(rotated).toBeTruthy()
    expect(rotated).not.toBe(session.token)
    expect((await service.resolveBrowserSession(rotated ?? "")).ok).toBe(true)
  })

  test("completes sign-out when the relay namespace rejects the push", async () => {
    const { service } = await serviceWith()
    const session = await service.signIn({ provider: "google", subject: "subject-3" })
    const h = await harness({
      service,
      relay: {
        getByName: () => ({
          fetch: async () => {
            throw new Error("relay unavailable")
          },
        }),
      },
    })
    await enrollDevice(h, session.userID)

    const response = await h.router(
      new Request(`${origin}/api/auth/logout`, {
        method: "POST",
        headers: { ...sessionCookie(session.token), ...sameOrigin },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0")
  })

  test("answers a failed handler with the generic error envelope", async () => {
    const { service } = await serviceWith({ failListDevices: true })
    const session = await service.signIn({ provider: "google", subject: "subject-4" })
    const h = await harness({ service })

    const response = await h.router(new Request(`${origin}/api/me`, { headers: sessionCookie(session.token) }))

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: { code: "internal_error", message: "Relay request failed" } })
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("does not clear the cookie for a rotation that lost a concurrent race", async () => {
    const { time, service } = await serviceWith()
    const session = await service.signIn({ provider: "google", subject: "subject-5" })
    time.advance(browserSessionTtlMs / 2 + 1)
    const h = await harness({ service })
    const refresh = () =>
      h.router(
        new Request(`${origin}/api/auth/session/refresh`, {
          method: "POST",
          headers: { ...sessionCookie(session.token), ...sameOrigin },
        }),
      )

    const [first, second] = await Promise.all([refresh(), refresh()])
    const winner = first.status === 200 ? first : second
    const loser = first.status === 200 ? second : first

    expect([first.status, second.status].sort((left, right) => left - right)).toEqual([200, 401])
    expect(readCookie(winner.headers.get("set-cookie"), "yc_session")).toBeTruthy()
    expect(loser.headers.get("set-cookie")).toBeNull()
  })

  test("denies an unknown cookie without deleting it or changing the error envelope", async () => {
    const h = await harness()

    const response = await h.router(new Request(`${origin}/api/me`, { headers: sessionCookie("unknown-token") }))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "Browser session is not authenticated" },
    })
    expect(response.headers.get("set-cookie")).toBeNull()

    const devices = await h.router(new Request(`${origin}/api/devices`, { headers: sessionCookie("unknown-token") }))
    expect(devices.status).toBe(401)
    expect(devices.headers.get("set-cookie")).toBeNull()
  })

  test("does not let an in-flight request delete the cookie a concurrent rotation installed", async () => {
    const { time, service } = await serviceWith()
    const session = await service.signIn({ provider: "google", subject: "subject-6" })
    time.advance(browserSessionTtlMs / 2 + 1)
    let entered = false
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const gated = {
      ...service,
      resolveBrowserSession: async (token: string) => {
        if (!entered) {
          entered = true
          await gate
        }
        return service.resolveBrowserSession(token)
      },
    }
    const h = await harness({ service: gated })
    const headers = { ...sessionCookie(session.token), ...sameOrigin }

    const inFlight = h.router(new Request(`${origin}/api/me`, { headers }))
    for (let attempt = 0; attempt < 200 && !entered; attempt += 1) await Promise.resolve()
    expect(entered).toBe(true)

    const rotated = await h.router(new Request(`${origin}/api/auth/session/refresh`, { method: "POST", headers }))
    expect(rotated.status).toBe(200)
    const fresh = readCookie(rotated.headers.get("set-cookie"), "yc_session")
    expect(fresh).toBeTruthy()

    release()
    const stale = await inFlight
    expect(stale.status).toBe(401)
    expect(stale.headers.get("set-cookie")).toBeNull()
    expect((await service.resolveBrowserSession(fresh ?? "")).ok).toBe(true)
  })
})
