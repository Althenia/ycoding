import { randomToken } from "../crypto"
import type { McpClientRow, McpStore } from "./store"

export type McpClientRejection = "invalid_redirect_uri" | "invalid_client_metadata" | "registration_limit"

export type McpRegisteredClient = {
  readonly client_id: string
  readonly client_name: string
  readonly redirect_uris: readonly string[]
  readonly token_endpoint_auth_method: "none"
  readonly grant_types: readonly string[]
  readonly response_types: readonly string[]
  readonly client_id_issued_at: number
}

const maxRedirectUriChars = 2048
const maxRedirectUris = 10
const maxNameChars = 100
const maxDocumentBytes = 32 * 1024
const maxCachedDocuments = 128
const maxCacheMs = 5 * 60 * 1000
const defaultTimeoutMs = 5000
export const maxPendingClients = 10_000
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"])
const supportedGrantTypes = ["authorization_code", "refresh_token"]
const reservedSuffixes = [".localhost", ".local", ".internal", ".localdomain"]

export function validateRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxRedirectUriChars) return false
  if (value.includes("*") || value.includes("#") || /[\u0000-\u0020\u007f]/.test(value)) return false
  const url = parseUrl(value)
  if (!url || url.username !== "" || url.password !== "") return false
  if (url.protocol === "https:") return true
  return url.protocol === "http:" && loopbackHosts.has(url.hostname)
}

export function isLoopbackRedirect(uri: string): boolean {
  const url = parseUrl(uri)
  return url?.protocol === "http:" && loopbackHosts.has(url.hostname)
}

export function createMcpClientResolver(options: {
  readonly store: McpStore
  readonly issuer: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly maxClients?: number
}) {
  const now = options.now ?? Date.now
  const fetchImpl = options.fetch ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init))
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  const maxClients = options.maxClients ?? maxPendingClients
  const relayHost = parseUrl(options.issuer)?.hostname ?? ""
  const cache = new Map<string, { readonly client: McpClientRow; readonly expiresAt: number }>()

  const remember = (client: McpClientRow, ttlMs: number) => {
    cache.delete(client.id)
    if (ttlMs <= 0) return
    if (cache.size >= maxCachedDocuments) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(client.id, { client, expiresAt: now() + ttlMs })
  }

  return {
    async register(body: unknown) {
      const parsed = parseMetadata(body)
      if (typeof parsed === "string") return { ok: false as const, reason: parsed }
      if (isRecord(body) && body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none")
        return { ok: false as const, reason: "invalid_client_metadata" as const }
      const createdAt = now()
      const row: McpClientRow = {
        id: `mcp_${randomToken(16)}`,
        kind: "dcr",
        name: parsed.name,
        redirectUris: parsed.redirectUris,
        authMethod: "none",
        createdAt,
      }
      if (!(await options.store.saveClient(row, maxClients)))
        return { ok: false as const, reason: "registration_limit" as const }
      const registered: McpRegisteredClient = {
        client_id: row.id,
        client_name: row.name,
        redirect_uris: row.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: parsed.grantTypes,
        response_types: ["code"],
        client_id_issued_at: Math.floor(createdAt / 1000),
      }
      return { ok: true as const, value: registered }
    },

    async resolve(clientID: string) {
      const invalid = { ok: false as const, reason: "invalid_client" as const }
      if (!clientID.startsWith("https://")) {
        const stored = await options.store.findClient(clientID)
        return stored?.kind === "dcr" ? { ok: true as const, value: stored } : invalid
      }
      if (!isMetadataUrl(clientID, relayHost)) return invalid
      const cached = cache.get(clientID)
      if (cached && now() < cached.expiresAt) return { ok: true as const, value: cached.client }
      cache.delete(clientID)

      if (!(await options.store.findClient(clientID)) && (await options.store.countPendingClients()) >= maxClients)
        return invalid

      const fetched = await fetchDocument(fetchImpl, clientID, timeoutMs)
      if (!fetched) return invalid
      const client = readClientDocument(fetched.document, clientID, now())
      if (!client) return invalid
      if (!(await options.store.saveClient(client, maxClients))) return invalid
      remember(client, fetched.ttlMs)
      return { ok: true as const, value: client }
    },
  }
}

type ParsedMetadata = {
  readonly name: string
  readonly redirectUris: readonly string[]
  readonly grantTypes: readonly string[]
}

function parseMetadata(body: unknown): ParsedMetadata | McpClientRejection {
  if (!isRecord(body)) return "invalid_client_metadata"
  const name = cleanName(body.client_name)
  if (name === undefined) return "invalid_client_metadata"
  const uris = body.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > maxRedirectUris || !uris.every(validateRedirectUri))
    return "invalid_redirect_uri"
  const grantTypes = body.grant_types === undefined ? supportedGrantTypes : stringList(body.grant_types)
  if (!grantTypes?.includes("authorization_code")) return "invalid_client_metadata"
  const responseTypes = body.response_types === undefined ? ["code"] : stringList(body.response_types)
  if (!responseTypes?.includes("code")) return "invalid_client_metadata"
  return { name, redirectUris: uris, grantTypes: supportedGrantTypes.filter((type) => grantTypes.includes(type)) }
}

function readClientDocument(document: unknown, clientID: string, createdAt: number): McpClientRow | undefined {
  if (!isRecord(document) || document.client_id !== clientID) return undefined
  const parsed = parseMetadata(document)
  if (typeof parsed === "string") return undefined
  const plural = document.token_endpoint_auth_methods_supported
  const publicClient =
    plural === undefined
      ? document.token_endpoint_auth_method === "none"
      : Array.isArray(plural) && plural.includes("none")
  if (!publicClient) return undefined
  return {
    id: clientID,
    kind: "cimd",
    name: parsed.name,
    redirectUris: parsed.redirectUris,
    authMethod: "none",
    createdAt,
  }
}

function isMetadataUrl(value: string, relayHost: string): boolean {
  if (value.length > maxRedirectUriChars || /[\u0000-\u0020\u007f]/.test(value) || value.includes("#")) return false
  const url = parseUrl(value)
  if (!url || url.href !== value || url.protocol !== "https:" || url.username !== "" || url.password !== "")
    return false
  if (url.pathname === "/") return false
  const host = url.hostname
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false
  if (!host.includes(".") || host.endsWith(".") || host === "localhost") return false
  if (reservedSuffixes.some((suffix) => host.endsWith(suffix))) return false
  return relayHost === "" || (host !== relayHost && !host.endsWith(`.${relayHost}`))
}

async function fetchDocument(fetchImpl: typeof fetch, url: string, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
    const declared = Number(response.headers.get("content-length") ?? 0)
    if (
      response.status !== 200 ||
      response.redirected ||
      mediaType !== "application/json" ||
      declared > maxDocumentBytes
    ) {
      await response.body?.cancel()
      return undefined
    }
    const text = await readCapped(response)
    if (text === undefined) return undefined
    const document: unknown = JSON.parse(text)
    return { document, ttlMs: cacheLifetimeMs(response.headers.get("cache-control")) }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function readCapped(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > maxDocumentBytes) {
      await reader.cancel()
      return undefined
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function cacheLifetimeMs(header: string | null): number {
  const directives = (header ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim())
  if (directives.includes("no-store") || directives.includes("no-cache")) return 0
  const maxAge = directives.flatMap((value) => (value.startsWith("max-age=") ? [Number(value.slice(8))] : []))[0]
  if (maxAge === undefined || !Number.isFinite(maxAge) || maxAge <= 0) return 0
  return Math.min(maxAge * 1000, maxCacheMs)
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > maxNameChars * 4) return undefined
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  return name.length > 0 && [...name].length <= maxNameChars ? name : undefined
}

function stringList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : undefined
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
