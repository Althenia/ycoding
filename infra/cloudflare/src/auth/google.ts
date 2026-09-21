/**
 * Google OpenID Connect: authorization code + PKCE, token exchange, and ID token
 * validation against a verified JWKS key set.
 *
 * Only RS256 is accepted. Issuer, audience (plus `azp`), expiry, not-before,
 * issuance time, nonce, and subject are all checked; `exp` is compared strictly
 * so an expired token never authenticates a session.
 */

import { constantTimeEqual, decodeJwt, verifyRs256 } from "./crypto"
import type { JwksCache } from "./jwks"

export type GoogleEnv = {
  readonly GOOGLE_CLIENT_ID?: string
  readonly GOOGLE_CLIENT_SECRET?: string
  readonly GOOGLE_ISSUER?: string
  readonly GOOGLE_AUTHORIZATION_ENDPOINT?: string
  readonly GOOGLE_TOKEN_ENDPOINT?: string
  readonly GOOGLE_JWKS_URI?: string
}

export type GoogleEndpoints = {
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly jwksUri: string
  readonly clientId: string
  readonly clientSecret: string
}

export type GoogleIdentity = {
  readonly subject: string
  readonly email?: string
  readonly emailVerified: boolean
}

export type AuthFailureReason =
  | "malformed_token"
  | "unsupported_algorithm"
  | "unknown_key"
  | "jwks_unavailable"
  | "bad_signature"
  | "bad_issuer"
  | "bad_audience"
  | "missing_expiry"
  | "expired"
  | "issued_in_future"
  | "not_yet_valid"
  | "bad_nonce"
  | "missing_subject"
  | "token_exchange_failed"

export type AuthResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: AuthFailureReason }

const canonicalIssuers = new Set(["https://accounts.google.com", "accounts.google.com"])
const clockSkewSeconds = 60
const maxIdTokenChars = 8192

export function googleEndpoints(env: GoogleEnv): GoogleEndpoints {
  return {
    issuer: env.GOOGLE_ISSUER ?? "https://accounts.google.com",
    authorizationEndpoint: env.GOOGLE_AUTHORIZATION_ENDPOINT ?? "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: env.GOOGLE_TOKEN_ENDPOINT ?? "https://oauth2.googleapis.com/token",
    jwksUri: env.GOOGLE_JWKS_URI ?? "https://www.googleapis.com/oauth2/v3/certs",
    clientId: env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
  }
}

export function googleConfigured(env: GoogleEnv): boolean {
  return (env.GOOGLE_CLIENT_ID?.length ?? 0) > 0 && (env.GOOGLE_CLIENT_SECRET?.length ?? 0) > 0
}

export function authorizationUrl(
  endpoints: GoogleEndpoints,
  input: { readonly state: string; readonly nonce: string; readonly codeChallenge: string; readonly redirectUri: string },
): string {
  const url = new URL(endpoints.authorizationEndpoint)
  url.searchParams.set("client_id", endpoints.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", "openid email profile")
  url.searchParams.set("state", input.state)
  url.searchParams.set("nonce", input.nonce)
  url.searchParams.set("code_challenge", input.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("prompt", "select_account")
  return url.toString()
}

export async function exchangeCode(
  endpoints: GoogleEndpoints,
  fetchImpl: typeof fetch,
  input: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string },
): Promise<AuthResult<{ readonly idToken: string; readonly accessToken?: string }>> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    client_id: endpoints.clientId,
    client_secret: endpoints.clientSecret,
    redirect_uri: input.redirectUri,
  })
  try {
    const response = await fetchImpl(endpoints.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    })
    if (!response.ok) return { ok: false, reason: "token_exchange_failed" }
    const payload: unknown = await response.json()
    if (!isRecord(payload)) return { ok: false, reason: "token_exchange_failed" }
    const idToken = payload.id_token
    if (typeof idToken !== "string" || idToken.length === 0 || idToken.length > maxIdTokenChars)
      return { ok: false, reason: "token_exchange_failed" }
    const accessToken = typeof payload.access_token === "string" ? payload.access_token : undefined
    return { ok: true, value: accessToken === undefined ? { idToken } : { idToken, accessToken } }
  } catch {
    return { ok: false, reason: "token_exchange_failed" }
  }
}

export async function verifyIdToken(
  endpoints: GoogleEndpoints,
  input: {
    readonly idToken: string
    readonly nonce: string
    readonly keys: JwksCache
    readonly now?: number
  },
): Promise<AuthResult<GoogleIdentity>> {
  const decoded = decodeJwt(input.idToken)
  if (!decoded) return { ok: false, reason: "malformed_token" }
  if (decoded.header.alg !== "RS256") return { ok: false, reason: "unsupported_algorithm" }
  const kid = decoded.header.kid
  if (typeof kid !== "string" || kid.length === 0 || kid.length > 128) return { ok: false, reason: "unknown_key" }

  const key = await resolveKey(input.keys, kid)
  if (key === "unavailable") return { ok: false, reason: "jwks_unavailable" }
  if (key === undefined) return { ok: false, reason: "unknown_key" }
  if (!(await verifyRs256(key, decoded.signingInput, decoded.signature))) return { ok: false, reason: "bad_signature" }

  const claims = decoded.payload
  if (!isAcceptedIssuer(endpoints, claims.iss)) return { ok: false, reason: "bad_issuer" }
  if (!isAcceptedAudience(claims.aud, claims.azp, endpoints.clientId)) return { ok: false, reason: "bad_audience" }

  const now = Math.floor((input.now ?? Date.now()) / 1000)
  const expiresAt = numericClaim(claims.exp)
  if (expiresAt === undefined) return { ok: false, reason: "missing_expiry" }
  if (expiresAt <= now) return { ok: false, reason: "expired" }
  const issuedAt = numericClaim(claims.iat)
  if (issuedAt === undefined) return { ok: false, reason: "malformed_token" }
  if (issuedAt > now + clockSkewSeconds) return { ok: false, reason: "issued_in_future" }
  const notBefore = numericClaim(claims.nbf)
  if (notBefore !== undefined && notBefore > now + clockSkewSeconds) return { ok: false, reason: "not_yet_valid" }

  if (typeof claims.nonce !== "string" || !constantTimeEqual(claims.nonce, input.nonce))
    return { ok: false, reason: "bad_nonce" }
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255)
    return { ok: false, reason: "missing_subject" }

  const email = typeof claims.email === "string" && claims.email.length > 0 ? claims.email : undefined
  const emailVerified = claims.email_verified === true || claims.email_verified === "true"
  return { ok: true, value: email === undefined ? { subject: claims.sub, emailVerified } : { subject: claims.sub, email, emailVerified } }
}

async function resolveKey(keys: JwksCache, kid: string): Promise<JsonWebKey | undefined | "unavailable"> {
  try {
    return await keys.get(kid)
  } catch {
    return "unavailable"
  }
}

function isAcceptedIssuer(endpoints: GoogleEndpoints, issuer: unknown): boolean {
  if (typeof issuer !== "string") return false
  return canonicalIssuers.has(issuer) || issuer === endpoints.issuer
}

function isAcceptedAudience(audience: unknown, azp: unknown, clientId: string): boolean {
  if (clientId.length === 0) return false
  const audiences = typeof audience === "string" ? [audience] : Array.isArray(audience) ? audience : []
  if (!audiences.some((value) => value === clientId)) return false
  if (azp === undefined) return audiences.length === 1
  return azp === clientId
}

function numericClaim(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
