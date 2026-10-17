export * as TaskMCPAuth from "./auth"

import { createPublicKey, verify, type KeyObject } from "node:crypto"
import { Option, Schema } from "effect"

export const scope = "ycoding:tasks"

export type Config = {
  readonly issuer: string
  readonly jwksURL: string
  readonly resource: string
  readonly subject: string
}

const Short = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const Header = Schema.Struct({
  alg: Schema.Literal("RS256"),
  kid: Short,
  crit: Schema.optional(Schema.Never),
  b64: Schema.optional(Schema.Never),
})
const Claims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String).check(Schema.isMaxLength(32))]),
  sub: Short,
  exp: Schema.Finite,
  nbf: Schema.optional(Schema.Finite),
  scope: Schema.optional(Schema.String),
})
const JWKS = Schema.Struct({ keys: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(32)) })
const JWK = Schema.Struct({
  kty: Schema.Literal("RSA"),
  kid: Short,
  n: Schema.String.check(Schema.isMaxLength(1400), Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  e: Schema.String.check(Schema.isMaxLength(8), Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  alg: Schema.optional(Schema.Literal("RS256")),
  use: Schema.optional(Schema.Literal("sig")),
  key_ops: Schema.optional(Schema.Array(Schema.String)),
})
const decodeJSON = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeHeader = Schema.decodeUnknownOption(Header)
const decodeClaims = Schema.decodeUnknownOption(Claims)
const decodeJWKS = Schema.decodeUnknownOption(JWKS)
const decodeJWK = Schema.decodeUnknownOption(JWK)

/** Resource-server verification only. An external OAuth server owns login, consent, and token issuance. */
export function create(
  input: Config,
  options: {
    fetch?: (url: string, init: RequestInit) => Promise<Response>
    now?: () => number
  } = {},
) {
  const config = { ...input }
  const resource = checkedURL(config.resource)
  checkedURL(config.issuer)
  checkedURL(config.jwksURL)
  if (typeof config.subject !== "string" || !/^[^\s\x00-\x1f\x7f]{1,256}$/.test(config.subject))
    throw new Error("Invalid task MCP OAuth configuration")
  const metadataPath = `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`
  const metadataURL = new URL(metadataPath, resource).href
  const now = options.now ?? Date.now
  const requestKeys = options.fetch ?? fetch
  const cache = {
    keys: new Map<string, KeyObject>(),
    expires: 0,
    retryAt: 0,
    pending: undefined as Promise<void> | undefined,
  }

  function challenge(error?: "invalid_token" | "insufficient_scope") {
    return Response.json(
      { error: error ?? "unauthorized" },
      {
        status: error === "insufficient_scope" ? 403 : 401,
        headers: {
          "cache-control": "no-store",
          "www-authenticate":
            `Bearer resource_metadata="${metadataURL}", scope="${scope}"` +
            (error ? `, error="${error}", error_description="Task MCP authorization required"` : ""),
        },
      },
    )
  }

  async function key(kid: string) {
    if (now() < cache.expires && cache.keys.has(kid)) return cache.keys.get(kid)
    if (!cache.pending && now() >= cache.retryAt) {
      // A rotating/unknown kid cannot turn unauthenticated traffic into unbounded JWKS requests.
      cache.retryAt = now() + 60_000
      cache.pending = requestKeys(config.jwksURL, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      })
        .then(readKeys)
        .then((keys) => {
          if (!keys) return
          cache.keys = keys
          cache.expires = now() + 300_000
        })
        // Upstream failures are deliberately indistinguishable from unavailable verification keys.
        .catch(() => undefined)
        .finally(() => {
          cache.pending = undefined
        })
    }
    if (cache.pending) await cache.pending
    if (now() >= cache.expires) return undefined
    return cache.keys.get(kid)
  }

  async function authorize(request: Request): Promise<Response | undefined> {
    const authorization = request.headers.get("authorization")
    if (!authorization) return challenge()
    if (
      authorization.length > 16_391 ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)
    )
      return challenge("invalid_token")
    const parts = authorization.slice(7).split(".")
    const header = Option.getOrUndefined(decodeHeader(decodePart(parts[0])))
    const claims = Option.getOrUndefined(decodeClaims(decodePart(parts[1])))
    if (!header || !claims || claims.iss !== config.issuer || claims.sub !== config.subject)
      return challenge("invalid_token")
    const audience = typeof claims.aud === "string" ? [claims.aud] : claims.aud
    if (!audience.includes(config.resource) || claims.exp <= now() / 1000 || (claims.nbf ?? 0) > now() / 1000)
      return challenge("invalid_token")
    const publicKey = await key(header.kid)
    if (!publicKey || claims.exp <= now() / 1000) return challenge("invalid_token")
    const signature = Buffer.from(parts[2], "base64url")
    if (signature.toString("base64url") !== parts[2]) return challenge("invalid_token")
    if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, signature))
      return challenge("invalid_token")
    if (!claims.scope?.split(" ").includes(scope)) return challenge("insufficient_scope")
    return undefined
  }

  return {
    metadataPath,
    metadata: () =>
      Response.json({
        resource: config.resource,
        authorization_servers: [config.issuer],
        scopes_supported: [scope],
        bearer_methods_supported: ["header"],
      }),
    challenge,
    authorize: (request: Request) => authorize(request).catch(() => challenge("invalid_token")),
  }
}

function checkedURL(value: string) {
  if (typeof value !== "string" || value.length > 2048 || !URL.canParse(value))
    throw new Error("Invalid task MCP OAuth configuration")
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#") ||
    (url.href !== value && url.href !== `${value}/`)
  )
    throw new Error("Invalid task MCP OAuth configuration")
  return url
}

function decodePart(value: string) {
  const bytes = Buffer.from(value, "base64url")
  if (bytes.toString("base64url") !== value) return undefined
  return Option.getOrUndefined(decodeJSON(bytes.toString("utf8")))
}

async function readKeys(response: Response) {
  if (!response.ok) {
    await response.body?.cancel()
    return undefined
  }
  if (!response.body) return undefined
  if (Number(response.headers.get("content-length")) > 65_536) {
    await response.body.cancel()
    return undefined
  }
  const reader = response.body.getReader()
  const body = { size: 0, chunks: [] as Uint8Array[] }
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    body.size += chunk.value.byteLength
    if (body.size > 65_536) {
      await reader.cancel()
      return undefined
    }
    body.chunks.push(chunk.value)
  }
  reader.releaseLock()
  const decoded = Option.getOrUndefined(
    decodeJWKS(Option.getOrUndefined(decodeJSON(Buffer.concat(body.chunks).toString("utf8")))),
  )
  if (!decoded) return undefined
  const keys = new Map<string, KeyObject>()
  for (const value of decoded.keys) {
    const jwk = Option.getOrUndefined(decodeJWK(value))
    if (!jwk || (jwk.key_ops && !jwk.key_ops.includes("verify"))) continue
    if (keys.has(jwk.kid)) return undefined
    const key = publicKey(jwk)
    if (key) keys.set(jwk.kid, key)
  }
  return keys.size ? keys : undefined
}

function publicKey(jwk: typeof JWK.Type) {
  try {
    const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" })
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
    if (bits < 2048 || bits > 8192) return undefined
    return key
  } catch {
    return undefined
  }
}
