import { parseBearerToken } from "../../../packages/remote/src/index"
import { authorizationUrl, exchangeCode, verifyIdToken, type GoogleEndpoints } from "./auth/google"
import { createJwksCache } from "./auth/jwks"
import type { createMcpClientResolver } from "./auth/mcp/client"
import { mcpScope, type McpPrincipal, type createMcpAuthService } from "./auth/mcp/service"
import { consentResponse, errorResponse, noticeResponse } from "./mcp-consent"
import { apiError, clearCookie, clientAddress, isCrossSiteRequest, jsonResponse, readCookie, setCookie, withSecurityHeaders } from "./http"

export type McpRouterDeps = {
  readonly issuer: string
  readonly auth: ReturnType<typeof createMcpAuthService>
  readonly clients: ReturnType<typeof createMcpClientResolver>
  readonly endpoints: GoogleEndpoints
  readonly allowedEmails: ReadonlySet<string>
  readonly fetch: typeof fetch
  readonly rateLimit: (key: string) => boolean
  readonly now?: () => number
  readonly deviceName: (ownerID: string, deviceID: string) => Promise<string | undefined>
  readonly forward: (principal: McpPrincipal, request: Request) => Promise<Response>
}

type RateGroup = "mcp-register" | "mcp-authorize" | "mcp-token" | "mcp-revoke"

type Route = {
  readonly method: "GET" | "POST"
  readonly group?: RateGroup
  readonly browser?: true
  readonly handle: (request: Request, url: URL) => Promise<Response> | Response
}

const cookieName = "yc_mcp_auth"
const oauthPath = "/api/mcp/oauth"
const deviceIDPattern = "[A-Za-z0-9_-]{1,64}"
const devicePath = new RegExp(`^/api/mcp/devices/(${deviceIDPattern})$`)
const protectedResourcePath = new RegExp(`^/\\.well-known/oauth-protected-resource/api/mcp/devices/(${deviceIDPattern})$`)
const maxRegistrationBytes = 32 * 1024
const maxFormBytes = 8 * 1024
const maxBrowserFormBytes = 2 * 1024
const maxQueryChars = 8 * 1024
const maxFields = 32
const maxStateChars = 512
const redirectErrors = new Set(["unsupported_response_type", "invalid_request", "invalid_target", "invalid_scope"])
const tokenErrors = new Set(["invalid_request", "invalid_grant", "invalid_target", "invalid_client"])
const clientAuthFields = ["client_secret", "client_assertion", "client_assertion_type"]

const expiredPage = { title: "Request expired", message: "This authorization request is no longer valid." }
const refusedPage = { title: "Request refused", message: "This request did not come from the YCoding authorization page." }
const notAuthorizedPage = { title: "Not authorized", message: "This Google account cannot authorize access to this device." }
const googleFailedPage = { title: "Google sign-in failed", message: "Google sign-in did not complete." }
const googleUnavailablePage = { title: "Sign-in unavailable", message: "Google sign-in is not configured." }
const limitedPage = { title: "Too many requests", message: "Wait a minute before trying again." }

export function createMcpRouter(deps: McpRouterDeps) {
  const issuer = deps.issuer
  const origin = new URL(issuer).origin
  const now = deps.now ?? Date.now
  const googleCallback = `${issuer}/api/mcp/oauth/google/callback`
  const fetchImpl: typeof fetch = (input, init) => deps.fetch(input, init)
  const keys = createJwksCache({ jwksUri: deps.endpoints.jwksUri, fetch: fetchImpl })
  const clearTransaction = clearCookie(cookieName, oauthPath)

  const routes = new Map<string, Route>([
    ["/.well-known/oauth-authorization-server", { method: "GET", handle: () => authorizationServerMetadata() }],
    ["/api/mcp/oauth/register", { method: "POST", group: "mcp-register", handle: (request) => register(request) }],
    ["/api/mcp/oauth/authorize", { method: "GET", group: "mcp-authorize", browser: true, handle: (_request, url) => authorize(url) }],
    ["/api/mcp/oauth/login", { method: "POST", group: "mcp-authorize", browser: true, handle: (request) => login(request) }],
    ["/api/mcp/oauth/google/callback", { method: "GET", group: "mcp-authorize", browser: true, handle: (request, url) => callback(request, url) }],
    ["/api/mcp/oauth/consent", { method: "POST", group: "mcp-authorize", browser: true, handle: (request) => consent(request) }],
    ["/api/mcp/oauth/token", { method: "POST", group: "mcp-token", handle: (request) => token(request) }],
    ["/api/mcp/oauth/revoke", { method: "POST", group: "mcp-revoke", handle: (request) => revoke(request) }],
  ])

  const dynamicRoute = (pathname: string): Route | undefined => {
    const resourceDeviceID = protectedResourcePath.exec(pathname)?.[1]
    if (resourceDeviceID !== undefined) return { method: "GET", handle: () => protectedResourceMetadata(resourceDeviceID) }
    const deviceID = devicePath.exec(pathname)?.[1]
    if (deviceID !== undefined) return { method: "POST", handle: (request) => deviceResource(request, deviceID) }
    return undefined
  }

  const authorizationServerMetadata = () =>
    jsonResponse({
      issuer,
      authorization_endpoint: `${issuer}/api/mcp/oauth/authorize`,
      token_endpoint: `${issuer}/api/mcp/oauth/token`,
      registration_endpoint: `${issuer}/api/mcp/oauth/register`,
      revocation_endpoint: `${issuer}/api/mcp/oauth/revoke`,
      scopes_supported: [mcpScope],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    })

  const protectedResourceMetadata = (deviceID: string) =>
    jsonResponse({
      resource: deps.auth.resourceFor(deviceID),
      authorization_servers: [issuer],
      scopes_supported: [mcpScope],
      bearer_methods_supported: ["header"],
    })

  const bearerChallenge = (deviceID: string) =>
    `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/api/mcp/devices/${deviceID}", scope="${mcpScope}"`

  const deviceResource = async (request: Request, deviceID: string): Promise<Response> => {
    const bearer = parseBearerToken(request.headers.get("authorization"))
    if (bearer === undefined) return challenge(401, deviceID, "Access token is required")
    const authenticated = await deps.auth.authenticateAccess({ token: bearer, resource: deps.auth.resourceFor(deviceID) })
    if (!authenticated.ok) {
      if (authenticated.reason === "insufficient_scope")
        return challenge(403, deviceID, "Access token does not grant this scope", `Bearer error="insufficient_scope", resource_metadata="${issuer}/.well-known/oauth-protected-resource/api/mcp/devices/${deviceID}", scope="${mcpScope}"`)
      return challenge(401, deviceID, "Access token is not valid")
    }
    const forwarded = await deps.forward(authenticated.value, request)
    const headers = new Headers(forwarded.headers)
    headers.set("cache-control", "no-store")
    return withSecurityHeaders(new Response(forwarded.body, { status: forwarded.status, statusText: forwarded.statusText, headers }))
  }

  const challenge = (status: 401 | 403, deviceID: string, message: string, header = bearerChallenge(deviceID)) => {
    const response = apiError(status, status === 401 ? "unauthorized" : "forbidden", message)
    response.headers.set("www-authenticate", header)
    return response
  }

  const register = async (request: Request): Promise<Response> => {
    if (mediaType(request) !== "application/json") return oauthError(400, "invalid_client_metadata", "Expected a JSON registration body")
    const text = await readText(request, maxRegistrationBytes)
    if (text === undefined) return oauthError(413, "invalid_client_metadata", "Registration body is too large")
    const registered = await deps.clients.register(parseJson(text))
    if (registered.ok) return jsonResponse(registered.value, { status: 201 })
    if (registered.reason === "registration_limit") return oauthError(429, "temporarily_unavailable", "Client registration capacity is exhausted")
    return oauthError(400, registered.reason, "Client registration metadata is not valid")
  }

  const authorize = async (url: URL): Promise<Response> => {
    const params = url.search.length > maxQueryChars ? undefined : uniqueFields(url.searchParams)
    if (params === undefined) return oauthError(400, "invalid_request", "Authorization request is malformed")
    const started = await deps.auth.startAuthorization({
      clientID: params.get("client_id"),
      redirectUri: params.get("redirect_uri"),
      responseType: params.get("response_type"),
      resource: params.get("resource"),
      scope: params.get("scope"),
      state: params.get("state"),
      codeChallenge: params.get("code_challenge"),
      codeChallengeMethod: params.get("code_challenge_method"),
    })
    if (!started.ok) {
      if (started.redirectable) {
        const error = redirectErrors.has(started.reason) ? started.reason : "invalid_request"
        return oauthRedirect(callbackTarget(params.get("redirect_uri") ?? "", { error }, params.get("state")), [])
      }
      return oauthError(400, started.reason === "invalid_client" || started.reason === "invalid_redirect_uri" ? started.reason : "invalid_request", "Authorization request is not valid")
    }
    return noticeResponse(
      {
        clientName: started.value.client.name,
        redirectUri: started.value.redirectUri,
        resource: deps.auth.resourceFor(started.value.deviceID),
        expiresInMinutes: Math.max(1, Math.ceil((started.value.expiresAt - now()) / 60_000)),
        csrfToken: started.value.csrfToken,
      },
      [setCookie(cookieName, started.value.cookieToken, { maxAgeSeconds: Math.max(1, Math.ceil((started.value.expiresAt - now()) / 1000)), path: oauthPath })],
    )
  }

  const login = async (request: Request): Promise<Response> => {
    if (!isSameOriginPost(request)) return errorResponse(403, refusedPage)
    const cookieToken = readCookie(request.headers.get("cookie"), cookieName)
    const fields = await readForm(request, maxBrowserFormBytes)
    const csrfToken = fields?.get("csrf")
    if (cookieToken === undefined || csrfToken === undefined) return errorResponse(400, expiredPage, [clearTransaction])
    if (deps.endpoints.clientId.length === 0 || deps.endpoints.clientSecret.length === 0) return errorResponse(503, googleUnavailablePage)
    const continued = await deps.auth.continueToGoogle({ cookieToken, csrfToken })
    if (!continued.ok) return transactionFailure(continued.reason)
    return oauthRedirect(
      new URL(authorizationUrl(deps.endpoints, { state: continued.value.state, nonce: continued.value.nonce, codeChallenge: continued.value.codeChallenge, redirectUri: googleCallback })),
      [],
    )
  }

  const callback = async (request: Request, url: URL): Promise<Response> => {
    const cookieToken = readCookie(request.headers.get("cookie"), cookieName)
    const params = uniqueFields(url.searchParams)
    if (cookieToken === undefined || params === undefined) return errorResponse(400, expiredPage, [clearTransaction])
    const taken = await deps.auth.takeGoogleCallback({ cookieToken, state: params.get("state") ?? "" })
    if (!taken.ok) return errorResponse(400, expiredPage, [clearTransaction])
    const code = params.get("code")
    if (params.has("error") || code === undefined || code.length === 0) return errorResponse(400, googleFailedPage, [clearTransaction])
    const exchanged = await exchangeCode(deps.endpoints, fetchImpl, { code, codeVerifier: taken.value.codeVerifier, redirectUri: googleCallback })
    if (!exchanged.ok) return errorResponse(400, googleFailedPage, [clearTransaction])
    const identity = await verifyIdToken(deps.endpoints, { idToken: exchanged.value.idToken, nonce: taken.value.nonce, keys })
    if (!identity.ok) return errorResponse(400, googleFailedPage, [clearTransaction])
    const bound = await deps.auth.bindOwner({ cookieToken, identity: identity.value, allowlist: deps.allowedEmails })
    if (!bound.ok) {
      if (bound.reason === "not_allowed" || bound.reason === "not_owner") return errorResponse(403, notAuthorizedPage, [clearTransaction])
      return errorResponse(400, expiredPage, [clearTransaction])
    }
    const view = await deps.auth.describeAuthorization(cookieToken)
    if (!view.ok || view.value.stage !== "consent" || view.value.deviceID === undefined) return errorResponse(400, expiredPage, [clearTransaction])
    const deviceName = await deps.deviceName(bound.value.ownerID, view.value.deviceID)
    return consentResponse(
      {
        clientName: view.value.client.name,
        redirectUri: view.value.redirectUri,
        resource: view.value.resource,
        deviceName: deviceName ?? "Unnamed device",
        csrfToken: bound.value.csrfToken,
      },
      [],
    )
  }

  const consent = async (request: Request): Promise<Response> => {
    if (!isSameOriginPost(request)) return errorResponse(403, refusedPage)
    const cookieToken = readCookie(request.headers.get("cookie"), cookieName)
    const fields = await readForm(request, maxBrowserFormBytes)
    const csrfToken = fields?.get("csrf")
    const decision = fields?.get("decision")
    if (cookieToken === undefined || csrfToken === undefined) return errorResponse(400, expiredPage, [clearTransaction])
    if (decision !== "allow" && decision !== "deny") return errorResponse(400, refusedPage)
    const decided = await deps.auth.decideConsent({ cookieToken, csrfToken, decision })
    if (!decided.ok) return transactionFailure(decided.reason)
    const result = decided.value
    const params: Record<string, string> = result.kind === "allow" ? { code: result.code } : { error: result.error }
    return oauthRedirect(callbackTarget(result.redirectUri, params, result.state), [clearTransaction])
  }

  const token = async (request: Request): Promise<Response> => {
    const fields = await readForm(request, maxFormBytes)
    if (fields === undefined) return oauthError(400, "invalid_request", "Token request is malformed")
    if (rejectsClientAuthentication(request, fields)) return oauthError(400, "invalid_client", "Only public clients without client authentication are supported")
    const grantType = fields.get("grant_type")
    if (grantType === undefined) return oauthError(400, "invalid_request", "grant_type is required")
    const issued =
      grantType === "authorization_code"
        ? await exchange(fields)
        : grantType === "refresh_token"
          ? await refresh(fields)
          : oauthError(400, "unsupported_grant_type", "Unsupported grant type")
    return issued
  }

  const exchange = async (fields: ReadonlyMap<string, string>): Promise<Response> => {
    const code = fields.get("code")
    const clientID = fields.get("client_id")
    const redirectUri = fields.get("redirect_uri")
    const codeVerifier = fields.get("code_verifier")
    if (code === undefined || clientID === undefined || redirectUri === undefined || codeVerifier === undefined)
      return oauthError(400, "invalid_request", "code, client_id, redirect_uri, and code_verifier are required")
    const resource = fields.get("resource")
    if (resource === undefined) return oauthError(400, "invalid_target", "resource is required")
    return tokenResponse(await deps.auth.exchangeCode({ code, clientID, redirectUri, codeVerifier, resource }))
  }

  const refresh = async (fields: ReadonlyMap<string, string>): Promise<Response> => {
    const refreshToken = fields.get("refresh_token")
    const clientID = fields.get("client_id")
    if (refreshToken === undefined || clientID === undefined) return oauthError(400, "invalid_request", "refresh_token and client_id are required")
    const resource = fields.get("resource")
    if (resource === undefined) return oauthError(400, "invalid_target", "resource is required")
    return tokenResponse(await deps.auth.refresh({ refreshToken, clientID, resource }))
  }

  const tokenResponse = (issued: Awaited<ReturnType<typeof deps.auth.exchangeCode>>): Response => {
    if (!issued.ok) return oauthError(400, tokenErrors.has(issued.reason) ? issued.reason : "invalid_grant", "Token request was refused")
    const response = jsonResponse({
      access_token: issued.value.accessToken,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.floor((issued.value.accessExpiresAt - now()) / 1000)),
      refresh_token: issued.value.refreshToken,
      scope: issued.value.scope,
    })
    response.headers.set("pragma", "no-cache")
    return response
  }

  const revoke = async (request: Request): Promise<Response> => {
    const fields = await readForm(request, maxFormBytes)
    if (fields === undefined) return oauthError(400, "invalid_request", "Revocation request is malformed")
    if (rejectsClientAuthentication(request, fields)) return oauthError(400, "invalid_client", "Only public clients without client authentication are supported")
    const presented = fields.get("token")
    const clientID = fields.get("client_id")
    if (presented === undefined || clientID === undefined) return oauthError(400, "invalid_request", "token and client_id are required")
    await deps.auth.revoke({ token: presented, clientID })
    return jsonResponse({})
  }

  const isSameOriginPost = (request: Request) => !isCrossSiteRequest(request) && request.headers.get("origin") === origin

  const oauthRedirect = (target: URL, cookies: readonly string[]): Response => {
    const headers = new Headers({ location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" })
    for (const cookie of cookies) headers.append("set-cookie", cookie)
    return withSecurityHeaders(new Response(null, { status: 302, headers }))
  }

  const callbackTarget = (redirectUri: string, params: Record<string, string>, state: string | undefined): URL => {
    const target = new URL(redirectUri)
    for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value)
    if (state !== undefined && state.length <= maxStateChars) target.searchParams.set("state", state)
    target.searchParams.set("iss", issuer)
    return target
  }

  const transactionFailure = (reason: string): Response =>
    reason === "bad_csrf" ? errorResponse(403, refusedPage) : errorResponse(400, expiredPage, [clearTransaction])

  const handle = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url)
    if (!inNamespace(url.pathname)) return undefined
    const route = routes.get(url.pathname) ?? dynamicRoute(url.pathname)
    if (route === undefined) return apiError(404, "not_found", "Not found")
    if (request.method !== route.method) {
      const response = apiError(405, "invalid_message", "Method not allowed")
      response.headers.set("allow", route.method)
      return response
    }
    if (route.group !== undefined && !deps.rateLimit(`${route.group}:${clientAddress(request)}`))
      return route.browser ? errorResponse(429, limitedPage) : oauthError(429, "temporarily_unavailable", "Too many requests")
    return route.handle(request, url)
  }

  return handle
}

function inNamespace(pathname: string): boolean {
  return ["/api/mcp", "/.well-known"].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function oauthError(status: number, error: string, description: string): Response {
  return jsonResponse({ error, error_description: description }, { status })
}

function mediaType(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
}

function uniqueFields(params: URLSearchParams): Map<string, string> | undefined {
  const fields = new Map<string, string>()
  for (const [name, value] of params) {
    if (fields.has(name) || fields.size >= maxFields) return undefined
    fields.set(name, value)
  }
  return fields
}

async function readForm(request: Request, maxBytes: number): Promise<Map<string, string> | undefined> {
  if (mediaType(request) !== "application/x-www-form-urlencoded") return undefined
  const text = await readText(request, maxBytes)
  return text === undefined ? undefined : uniqueFields(new URLSearchParams(text))
}

async function readText(request: Request, maxBytes: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > maxBytes) return undefined
  if (request.body === null) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return undefined
    }
    chunks.push(next.value)
  }
  return new Blob(chunks).text()
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function rejectsClientAuthentication(request: Request, fields: ReadonlyMap<string, string>): boolean {
  return request.headers.has("authorization") || clientAuthFields.some((name) => fields.has(name))
}
