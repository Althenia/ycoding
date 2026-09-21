import { base64UrlEncode } from "../../src/auth/crypto"
import { googleEndpoints, type GoogleEndpoints } from "../../src/auth/google"

/** Test-only Google stand-in: real RSA signatures, no network. */

export const testClientID = "client-id.apps.googleusercontent.com"
export const testIssuer = "http://google.test"
/** Synthetic address used by the router tests; never a real account. */
export const testAllowedEmail = "owner@example.invalid"

export async function rsaIdentity(kid = "kid-1") {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" }
  return { pair, jwk }
}

export async function signedToken(
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

export function testEndpoints(overrides: Partial<GoogleEndpoints> = {}): GoogleEndpoints {
  return {
    ...googleEndpoints({
      GOOGLE_CLIENT_ID: testClientID,
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_ISSUER: testIssuer,
      GOOGLE_AUTHORIZATION_ENDPOINT: `${testIssuer}/authorize`,
      GOOGLE_TOKEN_ENDPOINT: `${testIssuer}/token`,
      GOOGLE_JWKS_URI: `${testIssuer}/certs`,
    }),
    ...overrides,
  }
}

export function testClaims(overrides: Record<string, unknown> = {}) {
  const issuedAt = Math.floor(Date.now() / 1000)
  return {
    iss: testIssuer,
    aud: testClientID,
    sub: "google-subject-1",
    iat: issuedAt,
    exp: issuedAt + 3600,
    email: testAllowedEmail,
    email_verified: true,
    ...overrides,
  }
}

/** Serves the JWKS and token endpoint for `testEndpoints()`. */
export function googleFetch(options: {
  readonly jwk: JsonWebKey
  readonly idToken: () => string
  readonly onToken?: () => void
}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url === `${testIssuer}/token`) {
      options.onToken?.()
      return Response.json({ id_token: options.idToken(), access_token: "access-token" })
    }
    if (url === `${testIssuer}/certs`) return Response.json({ keys: [options.jwk] })
    return new Response("not found", { status: 404 })
  }) as typeof fetch
}
