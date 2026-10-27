import {
  RemoteAppPreview,
  maxPreviewHeaderChars,
  parsePreviewResult,
  previewCookie,
  sha256Hex,
  type PreviewInput,
  type PreviewMethod,
  type PreviewResult,
} from "../../../../packages/remote/src/index"
import { readBoundedText } from "../http"
import type { PreviewAccess, PreviewDevice, PreviewLeaseRecord } from "./directory-store"

export type PreviewWorkerDeps = {
  readonly origins: readonly string[]
  readonly directory: {
    readonly redeem: (ticketHash: string, origin: string) => Promise<PreviewAccess>
    readonly bind: (input: PreviewDevice & { readonly ticketHash: string; readonly cookieHash: string }) => Promise<boolean>
    readonly resolve: (cookieHash: string, leaseTag: string, origin: string) => Promise<PreviewAccess>
  }
  readonly forward: (device: PreviewDevice, input: PreviewInput, signal: AbortSignal) => Promise<Response>
}

type Relayed = { readonly result: PreviewResult; readonly body: Uint8Array<ArrayBuffer> } | Response

const maxResultChars = 4 * 1024 * 1024
const deviceStatuses = [400, 403, 413, 503, 504]
const refusals: Record<Exclude<PreviewAccess["state"], "valid">, readonly [number, string]> = {
  unbound: [404, "not_found"],
  ended: [410, "gone"],
  unknown: [401, "unauthorized"],
  expired: [410, "gone"],
  mismatch: [409, "lease_mismatch"],
  gone: [410, "gone"],
}

export function createPreviewWorker(deps: PreviewWorkerDeps) {
  const origins = deps.origins

  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (!origins.includes(url.origin)) return answer(404, "not_found")
    if (request.method !== "GET" && request.method !== "HEAD") return answer(405, "method_unsupported", { allow: "GET, HEAD" })
    if (request.headers.has("upgrade") || connectionTokens(request.headers).has("upgrade")) return answer(426, "upgrade_unsupported")
    const size = await bodySize(request)
    if (size > RemoteAppPreview.maxRequestBytes) return answer(413, "too_large")
    if (size > 0) return answer(400, "invalid_request")
    const headers = forwardedHeaders(request.headers)
    if (headers === undefined) return answer(431, "invalid_headers")
    const path = `${url.pathname}${url.search}`
    if (new TextEncoder().encode(path).byteLength > 4096) return answer(414, "too_large")
    const method: PreviewMethod = request.method === "HEAD" ? "HEAD" : "GET"
    if (url.pathname === RemoteAppPreview.bootstrapPath) return bootstrap(url, method, path, headers, request.signal)
    const prefixed = RemoteAppPreview.leasePattern.exec(url.pathname)
    if (!prefixed || !RemoteAppPreview.allowedPath(`${prefixed[2]}${url.search}`)) return answer(404, "not_found")
    const credential = readCookie(request.headers)
    if (credential === undefined) return answer(401, "unauthorized")
    const found = await deps.directory.resolve(await sha256Hex(credential), prefixed[1]!, url.origin)
    if (found.state !== "valid") return answer(...refusals[found.state])
    if (found.lease.origin !== url.origin || found.lease.leaseTag !== prefixed[1]) return answer(409, "lease_mismatch")
    const relayed = await relay(found.lease, { origin: url.origin, method, path, headers: { ...headers, cookie: `${RemoteAppPreview.cookieName}=${credential}` } }, request.signal)
    return relayed instanceof Response ? relayed : respond(method, relayed)
  }

  async function bootstrap(url: URL, method: PreviewMethod, path: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    if (method !== "GET") return answer(405, "method_unsupported", { allow: "GET" })
    const ticket = url.searchParams.get("ticket")
    if ([...url.searchParams.keys()].length !== 1 || ticket === null || !RemoteAppPreview.tokenPattern.test(ticket)) return answer(401, "unauthorized")
    const ticketHash = await sha256Hex(ticket)
    const found = await deps.directory.redeem(ticketHash, url.origin)
    if (found.state !== "valid") return answer(...refusals[found.state])
    if (found.lease.origin !== url.origin) return answer(401, "unauthorized")
    const relayed = await relay(found.lease, { origin: url.origin, method, path, headers }, signal)
    if (relayed instanceof Response) return relayed
    if (relayed.result.status !== 303) return respond(method, relayed)
    const location = relayed.result.headers.find(([name]) => name === "location")?.[1]
    if (location === undefined || !location.startsWith(`/_r/${found.lease.leaseTag}/`)) return answer(502, "upstream_unavailable")
    const cookies = relayed.result.headers.filter(([name]) => name === "set-cookie").map(([, value]) => value)
    const credential = cookies.length === 1 ? previewCookie(cookies[0]!.split(";")[0]!) : undefined
    if (credential === undefined) return answer(502, "upstream_unavailable")
    const bound = await deps.directory.bind({ ticketHash, ownerID: found.lease.ownerID, deviceID: found.lease.deviceID, cookieHash: await sha256Hex(credential) })
    return bound ? respond(method, relayed, cookies[0]) : answer(502, "upstream_unavailable")
  }

  async function relay(lease: PreviewLeaseRecord, input: PreviewInput, signal: AbortSignal): Promise<Relayed> {
    const response = await deps.forward({ ownerID: lease.ownerID, deviceID: lease.deviceID }, input, signal).catch(() => undefined)
    if (response === undefined) return answer(502, "upstream_unavailable")
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      return deviceStatuses.includes(response.status) ? answer(response.status, "unavailable") : answer(502, "upstream_unavailable")
    }
    const text = await readBoundedText(response.body, maxResultChars).catch(() => undefined)
    const result = text === undefined ? undefined : parsePreviewResult(parseJson(text))
    if (result === undefined) return answer(502, "upstream_unavailable")
    const body = Uint8Array.from(atob(result.body), (character) => character.charCodeAt(0))
    return body.byteLength > RemoteAppPreview.maxResponseBytes ? answer(502, "upstream_unavailable") : { result, body }
  }
}

function respond(method: PreviewMethod, relayed: { readonly result: PreviewResult; readonly body: Uint8Array<ArrayBuffer> }, cookie?: string): Response {
  const headers = new Headers()
  for (const [name, value] of relayed.result.headers) if (RemoteAppPreview.responseHeaders.includes(name)) headers.append(name, value)
  const length = relayed.result.headers.find(([name]) => name === "content-length")?.[1]
  if (method === "HEAD" && length !== undefined && /^(0|[1-9][0-9]{0,15})$/.test(length)) headers.set("content-length", length)
  if (cookie !== undefined) headers.append("set-cookie", cookie)
  headers.set("cache-control", "no-store, no-transform")
  headers.set("referrer-policy", "no-referrer")
  headers.set("x-content-type-options", "nosniff")
  const empty = method === "HEAD" || [204, 205, 304].includes(relayed.result.status)
  return new Response(empty ? null : relayed.body, { status: relayed.result.status, headers })
}

function answer(status: number, category: string, extra: Readonly<Record<string, string>> = {}): Response {
  return new Response(category, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store, no-transform", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", ...extra } })
}

function forwardedHeaders(headers: Headers): Record<string, string> | undefined {
  const excluded = connectionTokens(headers)
  const entries = RemoteAppPreview.requestHeaders.flatMap((name) => {
    const value = excluded.has(name) ? null : headers.get(name)
    return value === null ? [] : [[name, value] as const]
  })
  if (entries.some(([, value]) => value.length > maxPreviewHeaderChars || !/^[\t\x20-\x7e]*$/.test(value))) return undefined
  return Object.fromEntries(entries)
}

function readCookie(headers: Headers): string | undefined {
  const pairs = (headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${RemoteAppPreview.cookieName}=`))
  return pairs.length === 1 ? previewCookie(pairs[0]!) : undefined
}

function connectionTokens(headers: Headers): Set<string> {
  return new Set((headers.get("connection") ?? "").toLowerCase().split(",").map((part) => part.trim()))
}

async function bodySize(request: Request): Promise<number> {
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (!Number.isFinite(declared) || declared > RemoteAppPreview.maxRequestBytes) return RemoteAppPreview.maxRequestBytes + 1
  if (request.body === null) return 0
  const reader = request.body.getReader()
  let total = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) return total
    total += chunk.value.byteLength
    if (total > RemoteAppPreview.maxRequestBytes) {
      await reader.cancel().catch(() => undefined)
      return total
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
