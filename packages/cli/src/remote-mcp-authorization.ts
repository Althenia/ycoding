export * as RemoteMcpAuthorization from "./remote-mcp-authorization"

import { RemoteMcpEvents } from "@ycoding-ai/remote"
import { RemoteConfig } from "./remote-config"

export type Reason = "unsupported" | "unavailable" | "unauthorized" | "forbidden" | "rate_limited"

export class Error extends globalThis.Error {
  override readonly name = "RemoteMcpAuthorizationError"
  readonly reason: Reason
  readonly relay: boolean

  constructor(reason: Reason, relay = false) {
    super("Relay MCP authorization could not be completed")
    this.reason = reason
    this.relay = relay
  }
}

export type Credential = { readonly accessToken: string; readonly accessExpiresAt: number }
export type Fetcher = (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type Options = {
  readonly relayURL: string
  readonly deviceID: string
  readonly credential: () => Credential | undefined
  readonly allowed: (epoch?: string) => boolean
  readonly signal: () => AbortSignal
  readonly fetcher?: Fetcher
  readonly now?: () => number
}

const deadlineMs = 10_000
const maxResponseBytes = 8192
const deviceIDPattern = /^[A-Za-z0-9_-]{1,64}$/

function fail(reason: Reason): never {
  throw new Error(reason)
}

export function create(options: Options) {
  const origin = normalize(options.relayURL)
  if (!deviceIDPattern.test(options.deviceID)) fail("unavailable")
  const endpoint = `${origin}/api/devices/${encodeURIComponent(options.deviceID)}/mcp/events/authorize`
  const now = options.now ?? Date.now
  const fetcher = options.fetcher ?? globalThis.fetch

  async function authorize(
    request: RemoteMcpEvents.AuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<RemoteMcpEvents.AuthorizationResponse> {
    const parsed = RemoteMcpEvents.parseAuthorizationRequest(request)
    if (parsed === undefined) fail("unavailable")
    const epoch = parsed.action === "capabilities" ? undefined : parsed.epoch
    const generation = options.signal()
    if (signal?.aborted || generation.aborted) fail("unavailable")
    if (!options.allowed(epoch)) fail("unavailable")
    if (parsed.action !== "capabilities" && parsed.principal.deviceID !== options.deviceID) fail("forbidden")
    const credential = options.credential()
    if (credential === undefined || !usableToken(credential.accessToken)) fail("unauthorized")
    if (!Number.isSafeInteger(credential.accessExpiresAt) || now() >= credential.accessExpiresAt) fail("unauthorized")

    const combined = AbortSignal.any([AbortSignal.timeout(deadlineMs), generation, ...(signal === undefined ? [] : [signal])])
    const relay = () => !(signal?.aborted || generation.aborted)
    function failRelay(reason: Reason): never {
      throw new Error(reason, relay())
    }
    const response = await Promise.resolve()
      .then(() =>
        fetcher(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${credential.accessToken}` },
          redirect: "error",
          signal: combined,
          body: JSON.stringify(parsed),
        }),
      )
      .then((value) => value, (): Response => failRelay("unavailable"))

    if (response.status === 404) await discard(response).then(() => failRelay("unsupported"))
    if (response.status === 401) await discard(response).then(() => failRelay("unauthorized"))
    if (response.status === 403) await discard(response).then(() => failRelay("forbidden"))
    if (response.status === 429) await discard(response).then(() => failRelay("rate_limited"))
    if (response.status !== 200) await discard(response).then(() => failRelay("unavailable"))

    const result = RemoteMcpEvents.parseAuthorizationResponse(decode(await readBounded(response, combined, relay), relay))
    if (result === undefined || result.action !== parsed.action) failRelay("unavailable")
    if (options.signal() !== generation || generation.aborted || combined.aborted) fail("unavailable")
    if (options.credential() !== credential) fail("unavailable")
    if (!options.allowed(epoch)) fail("unavailable")
    if (now() >= credential.accessExpiresAt) fail("unauthorized")
    if (result.action !== "capabilities" && result.authorized) {
      if (result.expiresAt <= now()) failRelay("unavailable")
      if (parsed.action === "check" && result.grantID !== parsed.grantID) failRelay("unavailable")
    }
    return result
  }

  return { authorize }
}

function normalize(relayURL: string): string {
  try {
    return RemoteConfig.normalizeRelayURL(relayURL)
  } catch {
    return fail("unavailable")
  }
}

function usableToken(token: unknown): token is string {
  return typeof token === "string" && token.length > 0 && token.length <= maxResponseBytes && !/[\s\0-\x1f\x7f]/.test(token)
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().then(() => undefined, () => undefined)
}

async function readBounded(response: Response, signal: AbortSignal, relay: () => boolean): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    await discard(response)
    throw new Error("unavailable", relay())
  }
  if (response.body === null) throw new Error("unavailable", relay())
  const reader = response.body.getReader()
  let onAbort = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("unavailable", relay()))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  aborted.catch(() => undefined)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted])
      if (next.done) break
      total += next.value.byteLength
      if (total > maxResponseBytes) throw new Error("unavailable", relay())
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().then(() => undefined, () => undefined)
    if (error instanceof Error && error.reason === "unavailable") throw error
    throw new Error("unavailable", relay())
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function decode(bytes: Uint8Array, relay: () => boolean): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new Error("unavailable", relay())
  }
}
