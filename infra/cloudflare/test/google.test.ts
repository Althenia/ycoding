import { describe, expect, test } from "bun:test"
import { base64UrlEncode } from "../src/auth/crypto"
import { createJwksCache } from "../src/auth/jwks"
import { authorizationUrl, exchangeCode, googleEndpoints, verifyIdToken } from "../src/auth/google"

const clientId = "client-id.apps.googleusercontent.com"
const redirectUri = "https://ycoding.althenia.app/api/auth/google/callback"
const nonce = "nonce-value"

const endpoints = googleEndpoints({ GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: "secret" })

async function rsaIdentity(kid = "kid-1") {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" }
  return { pair, jwk }
}

async function signedToken(
  pair: CryptoKeyPair,
  claims: Record<string, unknown>,
  options: { readonly alg?: string; readonly kid?: string } = {},
) {
  const header = { alg: options.alg ?? "RS256", kid: options.kid ?? "kid-1", typ: "JWT" }
  const signingInput = `${base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)))}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)))}`
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(signingInput)),
  )
  return `${signingInput}.${base64UrlEncode(signature)}`
}

function claimsFor(overrides: Record<string, unknown> = {}) {
  const issuedAt = Math.floor(Date.now() / 1000)
  return {
    iss: "https://accounts.google.com",
    aud: clientId,
    sub: "google-subject-1",
    nonce,
    iat: issuedAt,
    exp: issuedAt + 3600,
    email: "user@example.com",
    email_verified: true,
    ...overrides,
  }
}

describe("google oidc endpoints", () => {
  test("defaults to the Google endpoints and honours non-secret overrides", () => {
    expect(endpoints).toEqual({
      issuer: "https://accounts.google.com",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      clientId,
      clientSecret: "secret",
    })
    const overridden = googleEndpoints({
      GOOGLE_CLIENT_ID: clientId,
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_ISSUER: "http://127.0.0.1:8788",
      GOOGLE_JWKS_URI: "http://127.0.0.1:8788/certs",
    })
    expect(overridden.issuer).toBe("http://127.0.0.1:8788")
    expect(overridden.jwksUri).toBe("http://127.0.0.1:8788/certs")
  })

  test("builds a PKCE authorization URL with state, nonce, and account selection", () => {
    const url = new URL(authorizationUrl(endpoints, { state: "state-1", nonce, codeChallenge: "challenge-1", redirectUri }))
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: "state-1",
      nonce,
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      prompt: "select_account",
    })
  })
})

describe("google token exchange", () => {
  test("sends the verifier and returns the id token", async () => {
    const calls: Request[] = []
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push(new Request(input as RequestInfo, init))
      return Response.json({ id_token: "id-token", access_token: "access-token" })
    }
    const result = await exchangeCode(endpoints, fakeFetch, { code: "code-1", codeVerifier: "verifier-1", redirectUri })
    expect(result).toEqual({ ok: true, value: { idToken: "id-token", accessToken: "access-token" } })

    const body = await calls[0]!.text()
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token")
    expect(calls[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      code_verifier: "verifier-1",
      client_id: clientId,
      client_secret: "secret",
      redirect_uri: redirectUri,
    })
  })

  test("fails closed on provider errors and missing id tokens", async () => {
    const rejected = await exchangeCode(endpoints, async () => new Response("nope", { status: 400 }), {
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri,
    })
    expect(rejected).toEqual({ ok: false, reason: "token_exchange_failed" })

    const empty = await exchangeCode(endpoints, async () => Response.json({ access_token: "only-access" }), {
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri,
    })
    expect(empty).toEqual({ ok: false, reason: "token_exchange_failed" })

    const threw = await exchangeCode(
      endpoints,
      async () => {
        throw new Error("network down")
      },
      { code: "code-1", codeVerifier: "verifier-1", redirectUri },
    )
    expect(threw).toEqual({ ok: false, reason: "token_exchange_failed" })
  })
})

describe("google id token validation", () => {
  test("accepts a correctly signed token", async () => {
    const { pair, jwk } = await rsaIdentity()
    const token = await signedToken(pair, claimsFor())
    const result = await verifyIdToken(endpoints, {
      idToken: token,
      nonce,
      keys: { get: async (kid) => (kid === "kid-1" ? jwk : undefined) },
    })
    expect(result).toEqual({
      ok: true,
      value: { subject: "google-subject-1", email: "user@example.com", emailVerified: true },
    })
  })

  test("rejects tampered payloads and non-RS256 algorithms", async () => {
    const { pair, jwk } = await rsaIdentity()
    const token = await signedToken(pair, claimsFor())
    const [header, , signature] = token.split(".")
    const tampered = `${header}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(claimsFor({ sub: "attacker" }))))}.${signature}`
    const keys = { get: async (kid: string) => (kid === "kid-1" ? jwk : undefined) }

    expect(await verifyIdToken(endpoints, { idToken: tampered, nonce, keys })).toEqual({ ok: false, reason: "bad_signature" })
    expect(
      await verifyIdToken(endpoints, { idToken: await signedToken(pair, claimsFor(), { alg: "none" }), nonce, keys }),
    ).toEqual({ ok: false, reason: "unsupported_algorithm" })
    expect(
      await verifyIdToken(endpoints, { idToken: await signedToken(pair, claimsFor(), { alg: "HS256" }), nonce, keys }),
    ).toEqual({ ok: false, reason: "unsupported_algorithm" })
    expect(await verifyIdToken(endpoints, { idToken: "not-a-jwt", nonce, keys })).toEqual({
      ok: false,
      reason: "malformed_token",
    })
  })

  test("requires a resolvable JWKS key", async () => {
    const { pair } = await rsaIdentity("kid-1")
    const token = await signedToken(pair, claimsFor(), { kid: "kid-unknown" })
    expect(await verifyIdToken(endpoints, { idToken: token, nonce, keys: { get: async () => undefined } })).toEqual({
      ok: false,
      reason: "unknown_key",
    })
    expect(
      await verifyIdToken(endpoints, {
        idToken: token,
        nonce,
        keys: {
          get: async () => {
            throw new Error("jwks fetch failed")
          },
        },
      }),
    ).toEqual({ ok: false, reason: "jwks_unavailable" })
  })

  test("validates issuer, audience, and azp", async () => {
    const { pair, jwk } = await rsaIdentity()
    const keys = { get: async (kid: string) => (kid === "kid-1" ? jwk : undefined) }
    const issuedAt = Math.floor(Date.now() / 1000)

    expect(
      await verifyIdToken(endpoints, {
        idToken: await signedToken(pair, claimsFor({ iss: "https://accounts.evil.example" })),
        nonce,
        keys,
      }),
    ).toEqual({ ok: false, reason: "bad_issuer" })
    expect(
      await verifyIdToken(endpoints, {
        idToken: await signedToken(pair, claimsFor({ iss: "accounts.google.com" })),
        nonce,
        keys,
      }),
    ).toEqual({ ok: true, value: { subject: "google-subject-1", email: "user@example.com", emailVerified: true } })
    expect(
      await verifyIdToken(endpoints, { idToken: await signedToken(pair, claimsFor({ aud: "other-client" })), nonce, keys }),
    ).toEqual({ ok: false, reason: "bad_audience" })
    expect(
      await verifyIdToken(endpoints, {
        idToken: await signedToken(pair, claimsFor({ aud: [clientId, "other-client"], azp: "other-client" })),
        nonce,
        keys,
      }),
    ).toEqual({ ok: false, reason: "bad_audience" })
    expect(
      await verifyIdToken(endpoints, {
        idToken: await signedToken(pair, claimsFor({ aud: [clientId, "other-client"], azp: clientId })),
        nonce,
        keys,
      }),
    ).toEqual({ ok: true, value: { subject: "google-subject-1", email: "user@example.com", emailVerified: true } })
    expect(
      await verifyIdToken(endpoints, { idToken: await signedToken(pair, claimsFor({ exp: issuedAt - 5 })), nonce, keys }),
    ).toEqual({ ok: false, reason: "expired" })
    expect(
      await verifyIdToken(endpoints, { idToken: await signedToken(pair, claimsFor({ exp: undefined })), nonce, keys }),
    ).toEqual({ ok: false, reason: "missing_expiry" })
    expect(
      await verifyIdToken(endpoints, { idToken: await signedToken(pair, claimsFor({ iat: issuedAt + 3600 })), nonce, keys }),
    ).toEqual({ ok: false, reason: "issued_in_future" })
    expect(
      await verifyIdToken(endpoints, { idToken: await signedToken(pair, claimsFor({ nbf: issuedAt + 3600 })), nonce, keys }),
    ).toEqual({ ok: false, reason: "not_yet_valid" })
  })

  test("binds the nonce and requires a subject", async () => {
    const { pair, jwk } = await rsaIdentity()
    const keys = { get: async (kid: string) => (kid === "kid-1" ? jwk : undefined) }
    expect(
      await verifyIdToken(endpoints, {
        idToken: await signedToken(pair, claimsFor({ nonce: "replayed-nonce" })),
        nonce,
        keys,
      }),
    ).toEqual({ ok: false, reason: "bad_nonce" })
    expect(
      await verifyIdToken(endpoints, { idToken: await signedToken(pair, claimsFor({ nonce: undefined })), nonce, keys }),
    ).toEqual({ ok: false, reason: "bad_nonce" })
    expect(
      await verifyIdToken(endpoints, { idToken: await signedToken(pair, claimsFor({ sub: undefined })), nonce, keys }),
    ).toEqual({ ok: false, reason: "missing_subject" })
  })

  test("reports an unverified email without failing authentication", async () => {
    const { pair, jwk } = await rsaIdentity()
    const result = await verifyIdToken(endpoints, {
      idToken: await signedToken(pair, claimsFor({ email_verified: false, email: undefined })),
      nonce,
      keys: { get: async (kid) => (kid === "kid-1" ? jwk : undefined) },
    })
    expect(result).toEqual({ ok: true, value: { subject: "google-subject-1", emailVerified: false } })
  })
})

describe("jwks cache", () => {
  const key = (kid: string) => ({ kty: "RSA", kid, alg: "RS256", use: "sig", n: "abc", e: "AQAB" })

  test("caches keys, refetches for an unknown kid, and rate-limits refetches", async () => {
    let now = 1_000
    let fetches = 0
    const cache = createJwksCache({
      jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      fetch: async () => {
        fetches += 1
        return Response.json({ keys: [key("kid-1")] })
      },
      now: () => now,
      ttlMs: 100,
      minRefetchMs: 50,
    })

    expect(await cache.get("kid-1")).toMatchObject({ kid: "kid-1" })
    expect(fetches).toBe(1)
    expect(await cache.get("kid-1")).toMatchObject({ kid: "kid-1" })
    expect(fetches).toBe(1)

    expect(await cache.get("kid-unknown")).toBeUndefined()
    expect(fetches).toBe(2)
    expect(await cache.get("kid-unknown")).toBeUndefined()
    expect(fetches).toBe(2)

    now += 200
    expect(await cache.get("kid-1")).toMatchObject({ kid: "kid-1" })
    expect(fetches).toBe(3)
  })

  test("keeps the last good keys when the provider fails", async () => {
    let failing = false
    const cache = createJwksCache({
      jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      fetch: async () => (failing ? new Response("nope", { status: 500 }) : Response.json({ keys: [key("kid-1")] })),
      now: () => Date.now(),
      ttlMs: 0,
      minRefetchMs: 0,
    })
    expect(await cache.get("kid-1")).toMatchObject({ kid: "kid-1" })
    failing = true
    expect(await cache.get("kid-1")).toMatchObject({ kid: "kid-1" })
  })

  test("ignores keys without a kid and rejects an unbounded key set", async () => {
    const cache = createJwksCache({
      jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      fetch: async () =>
        Response.json({ keys: [{ kty: "RSA", n: "abc", e: "AQAB" }, ...Array.from({ length: 64 }, (_, index) => key(`kid-${index}`))] }),
      now: () => Date.now(),
      ttlMs: 1_000,
      minRefetchMs: 1_000,
    })
    expect(await cache.get("kid-0")).toMatchObject({ kid: "kid-0" })
    expect(await cache.get("kid-63")).toBeUndefined()
  })
})
