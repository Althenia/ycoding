import { describe, expect, test } from "bun:test"
import { createAuthService } from "../src/auth/service"
import { sha256Base64Url } from "../src/auth/crypto"
import { createMcpClientResolver } from "../src/auth/mcp/client"
import { createMemoryMcpStore } from "../src/auth/mcp/memory-store"
import { createMcpAuthService, type McpPrincipal } from "../src/auth/mcp/service"
import { createMcpRouter } from "../src/mcp-router"
import { readCookie } from "../src/http"
import { createMemoryAuthStore } from "./support/memory-store"
import { googleFetch, rsaIdentity, signedToken, testAllowedEmail, testClaims, testEndpoints, testIssuer } from "./support/google"

const issuer = "https://relay.test"
const redirect = "https://client.example/callback"
const verifier = "v".repeat(43)
const epoch = "epoch-aaaaaaaaaaaa"
const scope = "ycoding:remote"
const ownerSubject = "google-subject-1"
const sameOrigin = { origin: issuer }

async function deviceKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  return { kty: "EC" as const, crv: "P-256" as const, x: jwk.x ?? "", y: jwk.y ?? "" }
}

async function harness(
  options: {
    readonly rateLimit?: (key: string) => boolean
    readonly deviceName?: string
    readonly unnamed?: boolean
    readonly endpointOverrides?: Parameters<typeof testEndpoints>[0]
    readonly clientFetch?: typeof fetch
  } = {},
) {
  let clock = 1_700_000_000_000
  const now = () => clock
  const authStore = createMemoryAuthStore()
  const auth = createAuthService(authStore, { now })
  const store = createMemoryMcpStore()
  const clients = createMcpClientResolver({
    store,
    issuer,
    now,
    fetch: options.clientFetch ?? ((async () => new Response("unreachable", { status: 500 })) as typeof fetch),
  })
  const service = createMcpAuthService({
    store,
    issuer,
    now,
    resolveClient: (id) => clients.resolve(id),
    authorizeDevice: (deviceID) => auth.authorizeAgentCommand(deviceID),
    resolveOwner: (subject) => authStore.findOrCreateUser("google", subject, clock),
  })
  const owner = await authStore.findOrCreateUser("google", ownerSubject, clock)
  const stranger = await authStore.findOrCreateUser("google", "google-subject-stranger", clock)
  const publicKey = await deviceKey()
  await authStore.insertDevice({ id: "dev_1", userID: owner, name: "Studio", publicKey, createdAt: clock })
  await authStore.insertDevice({ id: "dev_2", userID: stranger, name: "Other", publicKey, createdAt: clock })
  expect((await service.setDeviceEnabled({ deviceID: "dev_1", enabled: true, epoch })).ok).toBe(true)

  const identity = await rsaIdentity()
  let idToken = ""
  const rateKeys: string[] = []
  const deviceNames: { readonly ownerID: string; readonly deviceID: string }[] = []
  const forwarded: { readonly principal: McpPrincipal; readonly request: Request }[] = []
  const router = createMcpRouter({
    issuer,
    auth: service,
    clients,
    endpoints: testEndpoints(options.endpointOverrides),
    allowedEmails: new Set([testAllowedEmail]),
    fetch: googleFetch({ jwk: identity.jwk, idToken: () => idToken }),
    now,
    rateLimit: (key) => {
      rateKeys.push(key)
      return options.rateLimit ? options.rateLimit(key) : true
    },
    deviceName: async (ownerID, deviceID) => {
      deviceNames.push({ ownerID, deviceID })
      return options.unnamed ? undefined : (options.deviceName ?? "Studio Mac")
    },
    forward: async (principal, request) => {
      forwarded.push({ principal, request })
      return new Response('{"jsonrpc":"2.0"}', { status: 200, headers: { "content-type": "application/json", "cache-control": "max-age=600" } })
    },
  })
  return {
    router,
    service,
    store,
    auth,
    authStore,
    owner,
    identity,
    rateKeys,
    deviceNames,
    forwarded,
    setIDToken: (value: string) => {
      idToken = value
    },
    advance: (milliseconds: number) => {
      clock += milliseconds
    },
  }
}

type Harness = Awaited<ReturnType<typeof harness>>

function form(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`${issuer}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  })
}

function authorizeURL(clientID: string, overrides: Record<string, string | undefined> = {}) {
  const url = new URL(`${issuer}/api/mcp/oauth/authorize`)
  const params: Record<string, string | undefined> = {
    client_id: clientID,
    redirect_uri: redirect,
    response_type: "code",
    resource: `${issuer}/api/mcp/devices/dev_1`,
    scope,
    state: "client-state",
    code_challenge_method: "S256",
    ...overrides,
  }
  for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value)
  return url
}

async function registerClient(h: Harness, name = "Test Client") {
  const response = await h.router(
    new Request(`${issuer}/api/mcp/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    }),
  )
  expect(response?.status).toBe(201)
  const body = (await response?.json()) as { client_id: string }
  return body.client_id
}

async function startAuthorization(h: Harness, clientID: string, overrides: Record<string, string | undefined> = {}) {
  const url = authorizeURL(clientID, { code_challenge: await sha256Base64Url(verifier), ...overrides })
  const response = await h.router(new Request(url))
  const html = response?.status === 200 ? await response.clone().text() : ""
  return {
    response,
    html,
    cookie: readCookie(response?.headers.get("set-cookie") ?? null, "yc_mcp_auth") ?? "",
    csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "",
  }
}

async function login(h: Harness, started: { cookie: string; csrf: string }, headers: Record<string, string> = {}) {
  return h.router(form("/api/mcp/oauth/login", { csrf: started.csrf }, { ...sameOrigin, cookie: `yc_mcp_auth=${started.cookie}`, ...headers }))
}

async function googleCallback(
  h: Harness,
  cookie: string,
  location: string,
  claims: Record<string, unknown> = {},
  query: Record<string, string> = {},
) {
  const google = new URL(location)
  h.setIDToken(await signedToken(h.identity.pair, testClaims({ nonce: google.searchParams.get("nonce"), sub: ownerSubject, ...claims })))
  const url = new URL(`${issuer}/api/mcp/oauth/google/callback`)
  url.searchParams.set("code", "google-code")
  url.searchParams.set("state", google.searchParams.get("state") ?? "")
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
  return h.router(new Request(url, { headers: { cookie: `yc_mcp_auth=${cookie}` } }))
}

async function reachConsent(h: Harness, overrides: Record<string, string | undefined> = {}) {
  const clientID = await registerClient(h)
  const started = await startAuthorization(h, clientID, overrides)
  const redirected = await login(h, started)
  const location = redirected?.headers.get("location") ?? ""
  const callback = await googleCallback(h, started.cookie, location)
  const html = await callback?.text()
  return { clientID, started, callback, consentCsrf: /name="csrf" value="([^"]+)"/.exec(html ?? "")?.[1] ?? "", html: html ?? "" }
}

function decide(h: Harness, flow: { started: { cookie: string }; consentCsrf: string }, decision: string, headers: Record<string, string> = {}) {
  return h.router(
    form("/api/mcp/oauth/consent", { csrf: flow.consentCsrf, decision }, { ...sameOrigin, cookie: `yc_mcp_auth=${flow.started.cookie}`, ...headers }),
  )
}

async function issueCode(h: Harness) {
  const flow = await reachConsent(h)
  const allowed = await decide(h, flow, "allow")
  const target = new URL(allowed?.headers.get("location") ?? "")
  return { flow, allowed, target, code: target.searchParams.get("code") ?? "" }
}

function tokenRequest(fields: Record<string, string | undefined>, headers: Record<string, string> = {}) {
  const body = Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined))
  return form("/api/mcp/oauth/token", body, headers)
}

async function issueTokens(h: Harness) {
  const { flow, code } = await issueCode(h)
  const response = await h.router(
    tokenRequest({ grant_type: "authorization_code", code, client_id: flow.clientID, redirect_uri: redirect, code_verifier: verifier, resource: `${issuer}/api/mcp/devices/dev_1` }),
  )
  expect(response?.status).toBe(200)
  const tokens = (await response?.json()) as { access_token: string; refresh_token: string }
  return { clientID: flow.clientID, tokens }
}

function mcpPost(token: string | undefined, deviceID = "dev_1", headers: Record<string, string> = {}) {
  return new Request(`${issuer}/api/mcp/devices/${deviceID}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
  })
}

const challenge = (deviceID: string) =>
  `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/api/mcp/devices/${deviceID}", scope="ycoding:remote"`

describe("MCP router namespaces", () => {
  test("ignores paths outside the MCP and well-known namespaces", async () => {
    const h = await harness()
    for (const path of ["/health", "/api/me", "/api/mcpx", "/api/auth/google/start", "/remote/chat", "/"])
      expect({ path, response: await h.router(new Request(`${issuer}${path}`)) }).toEqual({ path, response: undefined })
  })

  test("answers unknown MCP and well-known paths with JSON 404, including navigations", async () => {
    const h = await harness()
    for (const path of ["/api/mcp", "/api/mcp/", "/api/mcp/unknown", "/api/mcp/oauth", "/api/mcp/oauth/unknown", "/api/mcp/devices", "/api/mcp/devices/dev_1/extra", "/api/mcp/devices/bad%20id", "/.well-known", "/.well-known/unknown", "/.well-known/oauth-authorization-server/extra", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp/devices/dev_1/extra"]) {
      const response = await h.router(new Request(`${issuer}${path}`, { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } }))
      expect({ path, status: response?.status }).toEqual({ path, status: 404 })
      expect(response?.headers.get("content-type")).toContain("application/json")
      expect(response?.headers.get("cache-control")).toBe("no-store")
    }
  })

  test("rejects the wrong method on known routes with 405 and an Allow header", async () => {
    const h = await harness()
    const cases: readonly [string, string, string][] = [
      ["POST", "/.well-known/oauth-authorization-server", "GET"],
      ["POST", "/.well-known/oauth-protected-resource/api/mcp/devices/dev_1", "GET"],
      ["GET", "/api/mcp/oauth/register", "POST"],
      ["POST", "/api/mcp/oauth/authorize", "GET"],
      ["GET", "/api/mcp/oauth/login", "POST"],
      ["POST", "/api/mcp/oauth/google/callback", "GET"],
      ["GET", "/api/mcp/oauth/consent", "POST"],
      ["GET", "/api/mcp/oauth/token", "POST"],
      ["GET", "/api/mcp/oauth/revoke", "POST"],
      ["GET", "/api/mcp/devices/dev_1", "POST"],
      ["PUT", "/api/mcp/devices/dev_1", "POST"],
      ["DELETE", "/api/mcp/devices/dev_1", "POST"],
    ]
    for (const [method, path, allow] of cases) {
      const response = await h.router(new Request(`${issuer}${path}`, { method }))
      expect({ method, path, status: response?.status, allow: response?.headers.get("allow") }).toEqual({ method, path, status: 405, allow })
    }
    expect(h.forwarded).toEqual([])
  })
})

describe("MCP discovery metadata", () => {
  test("advertises S256, issuer response parameters, public clients, and both registration methods", async () => {
    const h = await harness()
    const response = await h.router(new Request(`${issuer}/.well-known/oauth-authorization-server`))
    expect(response?.status).toBe(200)
    expect(response?.headers.get("cache-control")).toBe("no-store")
    expect(await response?.json()).toEqual({
      issuer,
      authorization_endpoint: `${issuer}/api/mcp/oauth/authorize`,
      token_endpoint: `${issuer}/api/mcp/oauth/token`,
      registration_endpoint: `${issuer}/api/mcp/oauth/register`,
      revocation_endpoint: `${issuer}/api/mcp/oauth/revoke`,
      scopes_supported: [scope],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    })
  })

  test("publishes protected-resource metadata for the exact device resource", async () => {
    const h = await harness()
    const response = await h.router(new Request(`${issuer}/.well-known/oauth-protected-resource/api/mcp/devices/dev_1`))
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({
      resource: `${issuer}/api/mcp/devices/dev_1`,
      authorization_servers: [issuer],
      scopes_supported: [scope],
      bearer_methods_supported: ["header"],
    })
    expect(h.rateKeys).toEqual([])
  })
})

describe("MCP client registration", () => {
  const post = (body: BodyInit, headers: Record<string, string> = { "content-type": "application/json" }) =>
    new Request(`${issuer}/api/mcp/oauth/register`, { method: "POST", headers, body })

  test("registers a public client and returns no secret", async () => {
    const h = await harness()
    const response = await h.router(post(JSON.stringify({ client_name: "My Client", redirect_uris: [redirect], client_secret: "ignored" })))
    expect(response?.status).toBe(201)
    expect(response?.headers.get("cache-control")).toBe("no-store")
    const body = (await response?.json()) as Record<string, unknown>
    expect(body).toMatchObject({ client_name: "My Client", redirect_uris: [redirect], token_endpoint_auth_method: "none" })
    expect(JSON.stringify(body)).not.toContain("client_secret")
  })

  test("maps registration failures to OAuth errors", async () => {
    const h = await harness()
    const cases: readonly [unknown, number, string][] = [
      [{ client_name: "A", redirect_uris: ["http://client.example/cb"] }, 400, "invalid_redirect_uri"],
      [{ client_name: "A", redirect_uris: [redirect], token_endpoint_auth_method: "client_secret_basic" }, 400, "invalid_client_metadata"],
      [{ redirect_uris: [redirect] }, 400, "invalid_client_metadata"],
    ]
    for (const [body, status, error] of cases) {
      const response = await h.router(post(JSON.stringify(body)))
      expect({ status: response?.status, error: ((await response?.json()) as { error: string }).error }).toEqual({ status, error })
    }
  })

  test("rejects malformed, mistyped, and oversized bodies before registering", async () => {
    const h = await harness()
    expect((await h.router(post("{not json")))?.status).toBe(400)
    expect((await h.router(post("[]")))?.status).toBe(400)
    expect((await h.router(post(JSON.stringify({ client_name: "A", redirect_uris: [redirect] }), { "content-type": "text/plain" })))?.status).toBe(400)
    const oversized = JSON.stringify({ client_name: "A", redirect_uris: [redirect], padding: "x".repeat(40_000) })
    expect((await h.router(post(oversized)))?.status).toBe(413)
    const chunked = new Request(`${issuer}/api/mcp/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized))
          controller.close()
        },
      }),
      duplex: "half",
    } as RequestInit)
    expect((await h.router(chunked))?.status).toBe(413)
  })

  test("returns 429 at the registration capacity", async () => {
    const h = await harness()
    const clients = createMcpClientResolver({ store: createMemoryMcpStore(), issuer, maxClients: 1, fetch: (async () => new Response("", { status: 500 })) as typeof fetch })
    const router = createMcpRouter({
      issuer,
      auth: h.service,
      clients,
      endpoints: testEndpoints(),
      allowedEmails: new Set(),
      fetch: (async () => new Response("", { status: 500 })) as typeof fetch,
      rateLimit: () => true,
      deviceName: async () => undefined,
      forward: async () => new Response(null),
    })
    const body = JSON.stringify({ client_name: "A", redirect_uris: [redirect] })
    expect((await router(post(body)))?.status).toBe(201)
    const limited = await router(post(body))
    expect(limited?.status).toBe(429)
    expect(((await limited?.json()) as { error: string }).error).toBe("temporarily_unavailable")
  })
})

describe("MCP authorization request", () => {
  test("shows the pre-Google notice without naming the device and binds a transaction cookie", async () => {
    const h = await harness()
    const clientID = await registerClient(h, `<script>alert(1)</script>`)
    const started = await startAuthorization(h, clientID)
    expect(started.response?.status).toBe(200)
    expect(started.response?.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(started.response?.headers.get("cache-control")).toBe("no-store")
    const cookie = started.response?.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("yc_mcp_auth=")
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api/mcp/oauth", "Max-Age=600"]) expect(cookie).toContain(attribute)
    expect(started.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(started.html).not.toContain("<script")
    expect(started.html).toContain("client.example")
    expect(started.html).toContain(`${issuer}/api/mcp/devices/dev_1`)
    expect(started.html).toContain("every existing and future Session")
    expect(started.html).not.toContain("Studio Mac")
    expect(started.html).toContain('action="/api/mcp/oauth/login"')
    expect(started.csrf.length).toBeGreaterThan(10)
    expect(started.html).not.toContain(started.cookie)
    expect(h.deviceNames).toEqual([])
  })

  test("never redirects an unknown client, unregistered redirect, or duplicated parameter", async () => {
    const h = await harness()
    const clientID = await registerClient(h)
    const challengeValue = await sha256Base64Url(verifier)
    const cases: readonly [URL, string][] = [
      [authorizeURL("mcp_unknown", { code_challenge: challengeValue }), "invalid_client"],
      [authorizeURL(clientID, { code_challenge: challengeValue, redirect_uri: "https://client.example/other" }), "invalid_redirect_uri"],
      [authorizeURL(clientID, { code_challenge: challengeValue, redirect_uri: undefined }), "invalid_redirect_uri"],
      [authorizeURL(clientID, { code_challenge: challengeValue, client_id: undefined }), "invalid_client"],
    ]
    for (const [url, error] of cases) {
      const response = await h.router(new Request(url))
      expect({ status: response?.status, location: response?.headers.get("location"), error: ((await response?.json()) as { error: string }).error }).toEqual({ status: 400, location: null, error })
    }
    for (const name of ["client_id", "redirect_uri", "state", "scope", "resource", "code_challenge"]) {
      const url = authorizeURL(clientID, { code_challenge: challengeValue })
      url.searchParams.append(name, url.searchParams.get(name) ?? "x")
      const response = await h.router(new Request(url))
      expect({ name, status: response?.status, location: response?.headers.get("location") }).toEqual({ name, status: 400, location: null })
    }
  })

  test("redirects binding errors to the validated URI with state and issuer", async () => {
    const h = await harness()
    const clientID = await registerClient(h)
    const cases: readonly [Record<string, string | undefined>, string][] = [
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge_method: undefined }, "invalid_request"],
      [{ code_challenge: undefined }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: `${issuer}/api/mcp/devices/dev_2` }, "invalid_target"],
      [{ scope: "other" }, "invalid_scope"],
    ]
    for (const [overrides, error] of cases) {
      const url = authorizeURL(clientID, { code_challenge: await sha256Base64Url(verifier), ...overrides })
      const response = await h.router(new Request(url))
      const target = new URL(response?.headers.get("location") ?? "https://invalid.example")
      expect({ overrides, status: response?.status, origin: target.origin + target.pathname, error: target.searchParams.get("error"), state: target.searchParams.get("state"), iss: target.searchParams.get("iss") }).toEqual({
        overrides,
        status: 302,
        origin: redirect,
        error,
        state: "client-state",
        iss: issuer,
      })
      expect(response?.headers.get("set-cookie")).toBeNull()
    }
  })

  test("is rate limited under one authorization key per address", async () => {
    const h = await harness({ rateLimit: () => false })
    const response = await h.router(new Request(authorizeURL("mcp_any")))
    expect(response?.status).toBe(429)
    expect(response?.headers.get("content-type")).toContain("text/html")
    expect(h.rateKeys).toEqual(["mcp-authorize:unknown"])
  })
})

describe("MCP Google continuation", () => {
  test("requires the same origin, the transaction cookie, and the transaction CSRF value", async () => {
    const h = await harness()
    const started = await startAuthorization(h, await registerClient(h))
    const cookie = `yc_mcp_auth=${started.cookie}`
    const attempts: readonly [string, Request][] = [
      ["cross-site", form("/api/mcp/oauth/login", { csrf: started.csrf }, { ...sameOrigin, cookie, "sec-fetch-site": "cross-site" })],
      ["missing origin", form("/api/mcp/oauth/login", { csrf: started.csrf }, { cookie })],
      ["foreign origin", form("/api/mcp/oauth/login", { csrf: started.csrf }, { origin: "https://evil.example", cookie })],
      ["null origin", form("/api/mcp/oauth/login", { csrf: started.csrf }, { origin: "null", cookie })],
      ["wrong csrf", form("/api/mcp/oauth/login", { csrf: "wrong" }, { ...sameOrigin, cookie })],
      ["missing csrf", form("/api/mcp/oauth/login", {}, { ...sameOrigin, cookie })],
      ["csrf in cookie only", form("/api/mcp/oauth/login", {}, { ...sameOrigin, cookie: `${cookie}; csrf=${started.csrf}` })],
      ["no cookie", form("/api/mcp/oauth/login", { csrf: started.csrf }, sameOrigin)],
      ["unknown cookie", form("/api/mcp/oauth/login", { csrf: started.csrf }, { ...sameOrigin, cookie: "yc_mcp_auth=unknown" })],
      ["duplicate csrf", new Request(`${issuer}/api/mcp/oauth/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...sameOrigin, cookie }, body: `csrf=${started.csrf}&csrf=${started.csrf}` })],
      ["json body", new Request(`${issuer}/api/mcp/oauth/login`, { method: "POST", headers: { "content-type": "application/json", ...sameOrigin, cookie }, body: JSON.stringify({ csrf: started.csrf }) })],
      ["oversized body", form("/api/mcp/oauth/login", { csrf: started.csrf, padding: "x".repeat(5000) }, { ...sameOrigin, cookie })],
    ]
    for (const [label, request] of attempts) {
      const response = await h.router(request)
      expect({ label, redirected: response?.headers.get("location") ?? null, html: response?.headers.get("content-type") }).toEqual({
        label,
        redirected: null,
        html: "text/html; charset=utf-8",
      })
      expect(response?.status).toBeGreaterThanOrEqual(400)
    }
    const accepted = await login(h, started)
    expect(accepted?.status).toBe(302)
  })

  test("navigates to the static Google client with S256, state, and nonce bound to this transaction", async () => {
    const h = await harness()
    const started = await startAuthorization(h, await registerClient(h))
    const response = await login(h, started)
    expect(response?.status).toBe(302)
    const location = new URL(response?.headers.get("location") ?? "")
    expect(location.origin + location.pathname).toBe(`${testIssuer}/authorize`)
    expect(location.searchParams.get("response_type")).toBe("code")
    expect(location.searchParams.get("code_challenge_method")).toBe("S256")
    expect(location.searchParams.get("redirect_uri")).toBe(`${issuer}/api/mcp/oauth/google/callback`)
    expect(location.searchParams.get("client_id")).toBe(testEndpoints().clientId)
    expect(location.searchParams.get("state")?.length).toBeGreaterThan(10)
    expect(location.searchParams.get("nonce")?.length).toBeGreaterThan(10)
    expect(location.search).not.toContain(started.cookie)
    expect(location.search).not.toContain(started.csrf)
    expect(h.deviceNames).toEqual([])
    expect((await login(h, started))?.status).toBeGreaterThanOrEqual(400)
  })

  test("reports unconfigured Google sign-in without consuming the transaction", async () => {
    const h = await harness({ endpointOverrides: { clientId: "" } })
    const started = await startAuthorization(h, await registerClient(h))
    const response = await login(h, started)
    expect(response?.status).toBe(503)
    expect(response?.headers.get("location")).toBeNull()
  })

  test("is rate limited under the authorization key", async () => {
    const h = await harness({ rateLimit: (key) => !key.startsWith("mcp-authorize") })
    const response = await h.router(form("/api/mcp/oauth/login", { csrf: "x" }, sameOrigin))
    expect(response?.status).toBe(429)
  })
})

describe("MCP Google callback and final consent", () => {
  test("verifies the owner and shows the final consent with the device name", async () => {
    const h = await harness()
    const flow = await reachConsent(h)
    expect(flow.callback?.status).toBe(200)
    expect(flow.callback?.headers.get("cache-control")).toBe("no-store")
    expect(flow.html).toContain("Allow <bdi>Test Client</bdi> to control <bdi>Studio Mac</bdi>?")
    expect(flow.html).toContain('action="/api/mcp/oauth/consent"')
    expect(flow.html).toContain('value="allow"')
    expect(flow.html).toContain('value="deny"')
    expect(flow.html).toContain("autonomy modes (Manual, YOLO, or Auto for permissions, guardrails, and answers)")
    expect(flow.consentCsrf.length).toBeGreaterThan(10)
    expect(flow.consentCsrf).not.toBe(flow.started.csrf)
    expect(h.deviceNames).toEqual([{ ownerID: h.owner, deviceID: "dev_1" }])
  })

  test("escapes a hostile device name", async () => {
    const h = await harness({ deviceName: `<b onclick="x">Mac</b>` })
    const flow = await reachConsent(h)
    expect(flow.html).toContain("&lt;b onclick=&quot;x&quot;&gt;Mac&lt;/b&gt;")
    expect(flow.html).not.toContain("<b ")
  })

  test("falls back to a neutral name when the device has none", async () => {
    const h = await harness({ unnamed: true })
    const flow = await reachConsent(h)
    expect(flow.html).toContain("control <bdi>Unnamed device</bdi>?")
  })

  test("refuses callbacks without the transaction cookie or with a wrong or replayed state", async () => {
    const h = await harness()
    const clientID = await registerClient(h)
    const started = await startAuthorization(h, clientID)
    const location = (await login(h, started))?.headers.get("location") ?? ""
    h.setIDToken(await signedToken(h.identity.pair, testClaims({ nonce: new URL(location).searchParams.get("nonce"), sub: ownerSubject })))
    const state = new URL(location).searchParams.get("state") ?? ""
    const call = (query: string, cookie?: string) =>
      h.router(new Request(`${issuer}/api/mcp/oauth/google/callback?${query}`, { headers: cookie ? { cookie } : {} }))
    const results = [
      await call(`code=c&state=${state}`),
      await call(`code=c&state=${state}`, "yc_session=browser-session"),
      await call(`code=c&state=attacker`, `yc_mcp_auth=${started.cookie}`),
      await call(`code=c&state=${state}`, `yc_mcp_auth=${started.cookie}`),
    ]
    for (const response of results) {
      expect(response?.status).toBe(400)
      expect(response?.headers.get("content-type")).toContain("text/html")
      expect(await response?.text()).not.toContain("Allow access")
    }
    expect(h.deviceNames).toEqual([])
  })

  test("refuses duplicated callback parameters, Google errors, and a missing code", async () => {
    const h = await harness()
    for (const mutate of [
      (url: URL) => url.searchParams.append("state", url.searchParams.get("state") ?? ""),
      (url: URL) => url.searchParams.append("code", "second"),
      (url: URL) => url.searchParams.set("error", "access_denied"),
      (url: URL) => url.searchParams.delete("code"),
    ]) {
      const started = await startAuthorization(h, await registerClient(h))
      const location = (await login(h, started))?.headers.get("location") ?? ""
      h.setIDToken(await signedToken(h.identity.pair, testClaims({ nonce: new URL(location).searchParams.get("nonce"), sub: ownerSubject })))
      const url = new URL(`${issuer}/api/mcp/oauth/google/callback`)
      url.searchParams.set("code", "c")
      url.searchParams.set("state", new URL(location).searchParams.get("state") ?? "")
      mutate(url)
      const response = await h.router(new Request(url, { headers: { cookie: `yc_mcp_auth=${started.cookie}` } }))
      expect(response?.status).toBe(400)
    }
    expect(h.deviceNames).toEqual([])
  })

  test("refuses invalid, replayed-nonce, and forged ID tokens", async () => {
    const h = await harness()
    const other = await rsaIdentity()
    const tokens: ((nonce: string) => Promise<string>)[] = [
      async () => "not-a-jwt",
      async () => signedToken(h.identity.pair, testClaims({ nonce: "replayed", sub: ownerSubject })),
      async (nonce) => signedToken(h.identity.pair, testClaims({ nonce, sub: ownerSubject, aud: "other-client" })),
      async (nonce) => signedToken(other.pair, testClaims({ nonce, sub: ownerSubject })),
    ]
    for (const build of tokens) {
      const started = await startAuthorization(h, await registerClient(h))
      const location = (await login(h, started))?.headers.get("location") ?? ""
      const google = new URL(location)
      h.setIDToken(await build(google.searchParams.get("nonce") ?? ""))
      const response = await h.router(
        new Request(`${issuer}/api/mcp/oauth/google/callback?code=c&state=${google.searchParams.get("state")}`, { headers: { cookie: `yc_mcp_auth=${started.cookie}` } }),
      )
      expect(response?.status).toBeGreaterThanOrEqual(400)
      expect(await response?.text()).not.toContain("Allow access")
    }
    expect(h.deviceNames).toEqual([])
  })

  test("admits only allowlisted, verified owners of the device and never names the device otherwise", async () => {
    const cases: readonly Record<string, unknown>[] = [
      { email: "intruder@example.invalid" },
      { email_verified: false },
      { sub: "google-subject-stranger" },
      { email: undefined },
    ]
    for (const claims of cases) {
      const h = await harness()
      const started = await startAuthorization(h, await registerClient(h))
      const location = (await login(h, started))?.headers.get("location") ?? ""
      const response = await googleCallback(h, started.cookie, location, claims)
      expect({ claims, status: response?.status }).toEqual({ claims, status: 403 })
      const html = (await response?.text()) ?? ""
      expect(html).not.toContain("Allow access")
      expect(html).not.toContain("Studio")
      expect(html).not.toContain(testAllowedEmail)
      expect(h.deviceNames).toEqual([])
    }
  })

  test("grants nothing to a browser or invite session alone", async () => {
    const h = await harness()
    const signedIn = await h.auth.signIn({ provider: "google", subject: ownerSubject })
    const started = await startAuthorization(h, await registerClient(h))
    const cookie = `yc_session=${signedIn.token}`
    const callback = await h.router(new Request(`${issuer}/api/mcp/oauth/google/callback?code=c&state=x`, { headers: { cookie } }))
    expect(callback?.status).toBe(400)
    const consent = await h.router(form("/api/mcp/oauth/consent", { csrf: started.csrf, decision: "allow" }, { ...sameOrigin, cookie }))
    expect(consent?.status).toBe(400)
    expect(consent?.headers.get("location")).toBeNull()
    expect(h.deviceNames).toEqual([])
  })

  test("is rate limited under the authorization key", async () => {
    const h = await harness({ rateLimit: () => false })
    expect((await h.router(new Request(`${issuer}/api/mcp/oauth/google/callback?code=c&state=s`)))?.status).toBe(429)
  })
})

describe("MCP consent decision", () => {
  test("Allow redirects the one-use code, client state, and issuer to the validated URI", async () => {
    const h = await harness()
    const { allowed, target, code } = await issueCode(h)
    expect(allowed?.status).toBe(302)
    expect(target.origin + target.pathname).toBe(redirect)
    expect(target.searchParams.get("state")).toBe("client-state")
    expect(target.searchParams.get("iss")).toBe(issuer)
    expect(code.length).toBeGreaterThanOrEqual(43)
    expect(allowed?.headers.get("referrer-policy")).toBe("no-referrer")
    expect(allowed?.headers.get("cache-control")).toBe("no-store")
    expect(allowed?.headers.get("set-cookie")).toContain("yc_mcp_auth=;")
    expect(allowed?.headers.get("set-cookie")).toContain("Max-Age=0")
  })

  test("Deny redirects access_denied with state and issuer and issues no code", async () => {
    const h = await harness()
    const flow = await reachConsent(h)
    const denied = await decide(h, flow, "deny")
    const target = new URL(denied?.headers.get("location") ?? "")
    expect(denied?.status).toBe(302)
    expect(target.searchParams.get("error")).toBe("access_denied")
    expect(target.searchParams.get("state")).toBe("client-state")
    expect(target.searchParams.get("iss")).toBe(issuer)
    expect(target.searchParams.has("code")).toBe(false)
    expect((await decide(h, flow, "allow"))?.headers.get("location")).toBeNull()
  })

  test("requires the same origin, the transaction cookie, the consent CSRF value, and a known decision", async () => {
    const h = await harness()
    const flow = await reachConsent(h)
    const cookie = `yc_mcp_auth=${flow.started.cookie}`
    const attempts: readonly [string, Request][] = [
      ["cross-site", form("/api/mcp/oauth/consent", { csrf: flow.consentCsrf, decision: "allow" }, { ...sameOrigin, cookie, "sec-fetch-site": "cross-site" })],
      ["missing origin", form("/api/mcp/oauth/consent", { csrf: flow.consentCsrf, decision: "allow" }, { cookie })],
      ["foreign origin", form("/api/mcp/oauth/consent", { csrf: flow.consentCsrf, decision: "allow" }, { origin: "https://evil.example", cookie })],
      ["login csrf", form("/api/mcp/oauth/consent", { csrf: flow.started.csrf, decision: "allow" }, { ...sameOrigin, cookie })],
      ["wrong csrf", form("/api/mcp/oauth/consent", { csrf: "wrong", decision: "allow" }, { ...sameOrigin, cookie })],
      ["no cookie", form("/api/mcp/oauth/consent", { csrf: flow.consentCsrf, decision: "allow" }, sameOrigin)],
      ["unknown decision", form("/api/mcp/oauth/consent", { csrf: flow.consentCsrf, decision: "approve" }, { ...sameOrigin, cookie })],
      ["missing decision", form("/api/mcp/oauth/consent", { csrf: flow.consentCsrf }, { ...sameOrigin, cookie })],
      ["duplicate decision", new Request(`${issuer}/api/mcp/oauth/consent`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...sameOrigin, cookie }, body: `csrf=${flow.consentCsrf}&decision=deny&decision=allow` })],
    ]
    for (const [label, request] of attempts) {
      const response = await h.router(request)
      expect({ label, location: response?.headers.get("location") ?? null }).toEqual({ label, location: null })
      expect(response?.status).toBeGreaterThanOrEqual(400)
      expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8")
    }
    expect((await decide(h, flow, "allow"))?.status).toBe(302)
  })

  test("refuses a replayed Allow", async () => {
    const h = await harness()
    const flow = await reachConsent(h)
    expect((await decide(h, flow, "allow"))?.status).toBe(302)
    const replay = await decide(h, flow, "allow")
    expect(replay?.status).toBe(400)
    expect(replay?.headers.get("location")).toBeNull()
  })

  test("refuses Allow after the device switched off", async () => {
    const h = await harness()
    const flow = await reachConsent(h)
    await h.service.setDeviceEnabled({ deviceID: "dev_1", enabled: false, epoch: "epoch-bbbbbbbbbbbb" })
    const response = await decide(h, flow, "allow")
    expect(response?.status).toBe(400)
    expect(response?.headers.get("location")).toBeNull()
  })

  test("is rate limited under the authorization key", async () => {
    const h = await harness({ rateLimit: () => false })
    expect((await h.router(form("/api/mcp/oauth/consent", { csrf: "x", decision: "allow" }, sameOrigin)))?.status).toBe(429)
  })
})

describe("MCP token endpoint", () => {
  const resource = `${issuer}/api/mcp/devices/dev_1`

  test("exchanges the code with PKCE and returns a bearer pair", async () => {
    const h = await harness()
    const { flow, code } = await issueCode(h)
    const response = await h.router(
      tokenRequest({ grant_type: "authorization_code", code, client_id: flow.clientID, redirect_uri: redirect, code_verifier: verifier, resource }),
    )
    expect(response?.status).toBe(200)
    expect(response?.headers.get("cache-control")).toBe("no-store")
    expect(response?.headers.get("pragma")).toBe("no-cache")
    const body = (await response?.json()) as Record<string, unknown>
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 300, scope })
    expect(String(body.access_token).length).toBeGreaterThanOrEqual(43)
    expect(String(body.refresh_token).length).toBeGreaterThanOrEqual(43)
    expect(body.access_token).not.toBe(body.refresh_token)
  })

  test("rejects a wrong verifier, redirect, client, resource, and a replayed code", async () => {
    const h = await harness()
    const { flow, code } = await issueCode(h)
    const base = { grant_type: "authorization_code", code, client_id: flow.clientID, redirect_uri: redirect, code_verifier: verifier, resource }
    const cases: readonly [Record<string, string>, string][] = [
      [{ code_verifier: "w".repeat(43) }, "invalid_grant"],
      [{ redirect_uri: "https://client.example/other" }, "invalid_grant"],
      [{ client_id: "mcp_other" }, "invalid_grant"],
      [{ resource: `${issuer}/api/mcp/devices/dev_2` }, "invalid_target"],
      [{ code: "unknown" }, "invalid_grant"],
    ]
    for (const [overrides, error] of cases) {
      const response = await h.router(tokenRequest({ ...base, ...overrides }))
      expect({ overrides, status: response?.status, error: ((await response?.json()) as { error: string }).error }).toEqual({ overrides, status: 400, error })
      expect(response?.headers.get("cache-control")).toBe("no-store")
    }
    expect((await h.router(tokenRequest(base)))?.status).toBe(200)
    const replay = await h.router(tokenRequest(base))
    expect(replay?.status).toBe(400)
    expect(((await replay?.json()) as { error: string }).error).toBe("invalid_grant")
  })

  test("validates the request shape before calling the service", async () => {
    const h = await harness()
    const { flow, code } = await issueCode(h)
    const base = { grant_type: "authorization_code", code, client_id: flow.clientID, redirect_uri: redirect, code_verifier: verifier, resource }
    const error = async (response: Response | undefined) => ((await response?.json()) as { error: string }).error
    for (const missing of ["code", "client_id", "redirect_uri", "code_verifier"])
      expect(await error(await h.router(tokenRequest({ ...base, [missing]: undefined })))).toBe("invalid_request")
    expect(await error(await h.router(tokenRequest({ ...base, resource: undefined })))).toBe("invalid_target")
    expect(await error(await h.router(tokenRequest({ ...base, grant_type: "password" })))).toBe("unsupported_grant_type")
    expect(await error(await h.router(tokenRequest({ ...base, grant_type: undefined })))).toBe("invalid_request")
    const json = new Request(`${issuer}/api/mcp/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base) })
    expect(await error(await h.router(json))).toBe("invalid_request")
    const duplicate = new Request(`${issuer}/api/mcp/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `${new URLSearchParams(base).toString()}&code=other` })
    expect(await error(await h.router(duplicate))).toBe("invalid_request")
    const oversized = tokenRequest({ ...base, padding: "x".repeat(9000) })
    expect(await error(await h.router(oversized))).toBe("invalid_request")
    expect(await error(await h.router(tokenRequest(base, { authorization: "Basic Zm9vOmJhcg==" })))).toBe("invalid_client")
    expect(await error(await h.router(tokenRequest({ ...base, client_secret: "secret" })))).toBe("invalid_client")
    expect(await error(await h.router(tokenRequest({ ...base, client_assertion: "jwt", client_assertion_type: "x" })))).toBe("invalid_client")
    expect((await h.router(tokenRequest(base)))?.status).toBe(200)
  })

  test("rotates refresh tokens once and revokes the family on reuse", async () => {
    const h = await harness()
    const { clientID, tokens } = await issueTokens(h)
    const refresh = (token: string) => h.router(tokenRequest({ grant_type: "refresh_token", refresh_token: token, client_id: clientID, resource }))
    const rotated = await refresh(tokens.refresh_token)
    expect(rotated?.status).toBe(200)
    const next = (await rotated?.json()) as { access_token: string; refresh_token: string; token_type: string; scope: string }
    expect(next).toMatchObject({ token_type: "Bearer", scope })
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    const reuse = await refresh(tokens.refresh_token)
    expect(reuse?.status).toBe(400)
    expect(((await reuse?.json()) as { error: string }).error).toBe("invalid_grant")
    expect((await h.router(mcpPost(next.access_token)))?.status).toBe(401)
    expect(((await (await refresh(next.refresh_token))?.json()) as { error: string }).error).toBe("invalid_grant")
  })

  test("validates refresh requests and the exact resource", async () => {
    const h = await harness()
    const { clientID, tokens } = await issueTokens(h)
    const refresh = (fields: Record<string, string | undefined>) =>
      h.router(tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientID, resource, ...fields }))
    expect(((await (await refresh({ refresh_token: undefined }))?.json()) as { error: string }).error).toBe("invalid_request")
    expect(((await (await refresh({ client_id: undefined }))?.json()) as { error: string }).error).toBe("invalid_request")
    expect(((await (await refresh({ resource: undefined }))?.json()) as { error: string }).error).toBe("invalid_target")
    expect(((await (await refresh({ resource: `${issuer}/api/mcp/devices/dev_2` }))?.json()) as { error: string }).error).toBe("invalid_target")
    expect(((await (await refresh({ client_id: "mcp_other" }))?.json()) as { error: string }).error).toBe("invalid_grant")
    expect((await refresh({}))?.status).toBe(200)
  })

  test("is rate limited under its own key", async () => {
    const h = await harness({ rateLimit: () => false })
    const response = await h.router(tokenRequest({ grant_type: "authorization_code" }))
    expect(response?.status).toBe(429)
    expect(h.rateKeys).toEqual(["mcp-token:unknown"])
  })
})

describe("MCP revocation endpoint", () => {
  const revoke = (fields: Record<string, string | undefined>, headers: Record<string, string> = {}) =>
    form("/api/mcp/oauth/revoke", Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined)), headers)

  test("revokes through either token and reveals nothing about unknown tokens", async () => {
    const h = await harness()
    const { clientID, tokens } = await issueTokens(h)
    expect((await h.router(mcpPost(tokens.access_token)))?.status).toBe(200)
    const response = await h.router(revoke({ token: tokens.refresh_token, client_id: clientID, token_type_hint: "refresh_token" }))
    expect(response?.status).toBe(200)
    expect(response?.headers.get("cache-control")).toBe("no-store")
    expect((await h.router(mcpPost(tokens.access_token)))?.status).toBe(401)
    const unknown = await h.router(revoke({ token: "unknown-token-value", client_id: clientID }))
    expect(unknown?.status).toBe(200)
    expect(await unknown?.text()).toBe(await response?.text())
  })

  test("ignores a revocation from a different client", async () => {
    const h = await harness()
    const { tokens } = await issueTokens(h)
    expect((await h.router(revoke({ token: tokens.access_token, client_id: "mcp_other" })))?.status).toBe(200)
    expect((await h.router(mcpPost(tokens.access_token)))?.status).toBe(200)
  })

  test("validates the request and uses its own rate limit key", async () => {
    const h = await harness()
    expect((await h.router(revoke({ client_id: "mcp_x" })))?.status).toBe(400)
    expect((await h.router(revoke({ token: "t" })))?.status).toBe(400)
    expect((await h.router(revoke({ token: "t", client_id: "mcp_x" }, { authorization: "Basic Zm9vOmJhcg==" })))?.status).toBe(400)
    expect((await h.router(new Request(`${issuer}/api/mcp/oauth/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })))?.status).toBe(400)
    const limited = await harness({ rateLimit: () => false })
    expect((await limited.router(revoke({ token: "t", client_id: "mcp_x" })))?.status).toBe(429)
    expect(limited.rateKeys).toEqual(["mcp-revoke:unknown"])
  })
})

describe("MCP device resource", () => {
  test("challenges a missing, malformed, unknown, or non-bearer credential without forwarding", async () => {
    const h = await harness()
    const attempts: readonly Request[] = [
      mcpPost(undefined),
      mcpPost(undefined, "dev_1", { authorization: "Bearer" }),
      mcpPost(undefined, "dev_1", { authorization: "Bearer short" }),
      mcpPost(undefined, "dev_1", { authorization: "Basic dXNlcjpwYXNz" }),
      mcpPost("x".repeat(43)),
    ]
    for (const request of attempts) {
      const response = await h.router(request)
      expect(response?.status).toBe(401)
      expect(response?.headers.get("www-authenticate")).toBe(challenge("dev_1"))
      expect(response?.headers.get("cache-control")).toBe("no-store")
      expect(response?.headers.get("content-type")).toContain("application/json")
    }
    expect(h.forwarded).toEqual([])
  })

  test("never accepts cookie, query, or body credentials", async () => {
    const h = await harness()
    const { tokens } = await issueTokens(h)
    const signedIn = await h.auth.signIn({ provider: "google", subject: ownerSubject })
    const attempts: readonly Request[] = [
      mcpPost(undefined, "dev_1", { cookie: `yc_session=${signedIn.token}; yc_mcp_auth=${tokens.access_token}` }),
      new Request(`${issuer}/api/mcp/devices/dev_1?access_token=${tokens.access_token}`, { method: "POST", body: "{}" }),
      new Request(`${issuer}/api/mcp/devices/dev_1`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `access_token=${tokens.access_token}` }),
    ]
    for (const request of attempts) expect((await h.router(request))?.status).toBe(401)
    expect(h.forwarded).toEqual([])
  })

  test("forwards an authenticated request with only the verified principal", async () => {
    const h = await harness()
    const { clientID, tokens } = await issueTokens(h)
    const response = await h.router(mcpPost(tokens.access_token, "dev_1", { "x-ycoding-owner": "attacker" }))
    expect(response?.status).toBe(200)
    expect(await response?.text()).toBe('{"jsonrpc":"2.0"}')
    expect(response?.headers.get("cache-control")).toBe("no-store")
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff")
    expect(h.forwarded).toHaveLength(1)
    expect(h.forwarded[0]?.principal).toMatchObject({ ownerID: h.owner, deviceID: "dev_1", clientID, epoch })
    expect(JSON.stringify(h.forwarded[0]?.principal)).not.toContain(tokens.access_token)
    expect(h.forwarded[0]?.request.method).toBe("POST")
  })

  test("does not rate limit authenticated MCP traffic", async () => {
    const h = await harness()
    const { tokens } = await issueTokens(h)
    h.rateKeys.length = 0
    await h.router(mcpPost(tokens.access_token))
    expect(h.rateKeys).toEqual([])
  })

  test("refuses a token for another device resource with that resource's challenge", async () => {
    const h = await harness()
    const { tokens } = await issueTokens(h)
    const response = await h.router(mcpPost(tokens.access_token, "dev_2"))
    expect(response?.status).toBe(401)
    expect(response?.headers.get("www-authenticate")).toBe(challenge("dev_2"))
    expect(h.forwarded).toEqual([])
  })

  test("stops forwarding once MCP is off, the access token expires, or the grant is revoked", async () => {
    const off = await harness()
    const offTokens = await issueTokens(off)
    await off.service.setDeviceEnabled({ deviceID: "dev_1", enabled: false, epoch: "epoch-bbbbbbbbbbbb" })
    expect((await off.router(mcpPost(offTokens.tokens.access_token)))?.status).toBe(401)

    const expired = await harness()
    const expiredTokens = await issueTokens(expired)
    expired.advance(5 * 60_000)
    const response = await expired.router(mcpPost(expiredTokens.tokens.access_token))
    expect(response?.status).toBe(401)
    expect(response?.headers.get("www-authenticate")).toBe(challenge("dev_1"))

    const revoked = await harness()
    const revokedTokens = await issueTokens(revoked)
    await revoked.auth.revokeDevice({ deviceID: "dev_1", userID: revoked.owner })
    expect((await revoked.router(mcpPost(revokedTokens.tokens.access_token)))?.status).toBe(401)
    expect([...off.forwarded, ...expired.forwarded, ...revoked.forwarded]).toEqual([])
  })

  test("returns 403 with an insufficient-scope challenge when the service reports it", async () => {
    const h = await harness()
    const { tokens } = await issueTokens(h)
    const router = createMcpRouter({
      issuer,
      auth: { ...h.service, authenticateAccess: async () => ({ ok: false as const, reason: "insufficient_scope" as const }) },
      clients: createMcpClientResolver({ store: h.store, issuer, fetch: (async () => new Response("", { status: 500 })) as typeof fetch }),
      endpoints: testEndpoints(),
      allowedEmails: new Set(),
      fetch: (async () => new Response("", { status: 500 })) as typeof fetch,
      rateLimit: () => true,
      deviceName: async () => undefined,
      forward: async () => new Response(null),
    })
    const response = await router(mcpPost(tokens.access_token))
    expect(response?.status).toBe(403)
    expect(response?.headers.get("www-authenticate")).toContain('error="insufficient_scope"')
    expect(response?.headers.get("www-authenticate")).toContain('scope="ycoding:remote"')
  })
})

describe("MCP rate limit keys", () => {
  test("registration, authorization, token, and revocation use separate per-address keys", async () => {
    const h = await harness()
    await registerClient(h)
    const started = await startAuthorization(h, await registerClient(h))
    await login(h, started)
    await h.router(new Request(`${issuer}/api/mcp/oauth/google/callback?code=c&state=s`))
    await h.router(form("/api/mcp/oauth/consent", { csrf: "x", decision: "allow" }, sameOrigin))
    await h.router(tokenRequest({ grant_type: "authorization_code" }))
    await h.router(form("/api/mcp/oauth/revoke", { token: "t", client_id: "c" }))
    expect([...new Set(h.rateKeys)]).toEqual(["mcp-register:unknown", "mcp-authorize:unknown", "mcp-token:unknown", "mcp-revoke:unknown"])
  })

  test("keys on the connecting address", async () => {
    const h = await harness()
    await h.router(tokenRequest({ grant_type: "authorization_code" }, { "cf-connecting-ip": "203.0.113.9" }))
    expect(h.rateKeys).toEqual(["mcp-token:203.0.113.9"])
  })

  test("registration returns 429 before reading the body", async () => {
    const h = await harness({ rateLimit: () => false })
    const response = await h.router(new Request(`${issuer}/api/mcp/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
    expect(response?.status).toBe(429)
    expect(response?.headers.get("cache-control")).toBe("no-store")
  })
})
