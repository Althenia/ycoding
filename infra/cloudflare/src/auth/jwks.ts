/**
 * Bounded Google JWKS cache.
 *
 * Keys are cached per isolate. A miss for an unknown `kid` triggers at most one
 * refetch per `minRefetchMs` so a hostile or noisy caller cannot turn token
 * validation into unbounded provider traffic. A failed refetch keeps the last
 * good key set.
 */

export type JwksCache = {
  readonly get: (kid: string) => Promise<JsonWebKey | undefined>
}

export type JwksCacheOptions = {
  readonly jwksUri: string
  readonly fetch: typeof fetch
  readonly now?: () => number
  readonly ttlMs?: number
  readonly minRefetchMs?: number
  readonly maxKeys?: number
}

type SigningKey = JsonWebKey & { readonly kid: string }

export function createJwksCache(options: JwksCacheOptions): JwksCache {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? 300_000
  const minRefetchMs = options.minRefetchMs ?? 30_000
  const maxKeys = options.maxKeys ?? 16
  let keys = new Map<string, JsonWebKey>()
  let fetchedAt = 0
  const misses = new Map<string, number>()

  return {
    get: async (kid) => {
      const current = now()
      const cached = keys.get(kid)
      if (cached && current - fetchedAt < ttlMs) return cached
      const lastMiss = misses.get(kid)
      const expired = current - fetchedAt >= ttlMs
      if (expired || lastMiss === undefined || current - lastMiss >= minRefetchMs) {
        misses.set(kid, current)
        prune(misses, 64)
        const fetched = await fetchKeys(options, maxKeys)
        if (fetched) {
          keys = fetched
          fetchedAt = current
        }
      }
      return keys.get(kid)
    },
  }
}

async function fetchKeys(options: JwksCacheOptions, maxKeys: number): Promise<Map<string, JsonWebKey> | undefined> {
  // Bind to a local: workerd rejects calling the global fetch as a member reference.
  const fetchImpl = options.fetch
  try {
    const response = await fetchImpl(options.jwksUri, { headers: { accept: "application/json" } })
    if (!response.ok) return undefined
    const document: unknown = await response.json()
    if (!isRecord(document) || !Array.isArray(document.keys)) return undefined
    const keys = new Map<string, JsonWebKey>()
    for (const candidate of document.keys) {
      const key = signingKey(candidate)
      if (!key) continue
      keys.set(key.kid, key)
      if (keys.size >= maxKeys) break
    }
    return keys.size > 0 ? keys : undefined
  } catch {
    return undefined
  }
}

function signingKey(candidate: unknown): SigningKey | undefined {
  if (!isRecord(candidate)) return undefined
  if (candidate.kty !== "RSA") return undefined
  if (typeof candidate.kid !== "string" || candidate.kid.length === 0 || candidate.kid.length > 128) return undefined
  if (typeof candidate.n !== "string" || typeof candidate.e !== "string") return undefined
  if (candidate.use !== undefined && candidate.use !== "sig") return undefined
  if (candidate.alg !== undefined && candidate.alg !== "RS256") return undefined
  return { kty: "RSA", kid: candidate.kid, n: candidate.n, e: candidate.e, alg: "RS256", use: "sig" }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function prune(values: Map<string, number>, limit: number): void {
  while (values.size > limit) {
    const oldest = values.keys().next()
    if (oldest.done) return
    values.delete(oldest.value)
  }
}
