export * as McpEventsHttp from "./protected-http"

import dns from "node:dns/promises"
import https from "node:https"
import { isIP } from "node:net"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { Context, Effect, Layer, Result } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export interface TransportRequest {
  readonly url: string
  readonly body: string
  readonly headers: Record<string, string>
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface TransportResponse {
  readonly status: number
  readonly body: string
}

export interface ConnectInput {
  readonly hostname: string
  readonly servername: string
  readonly ip: string
  readonly port: number
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly send: (request: TransportRequest) => Effect.Effect<TransportResponse, McpEvents.Failure>
}

const rejected = () => new McpEvents.Failure({ category: "callback_endpoint", reason: "endpoint_rejected" })
const unreachable = () => new McpEvents.Failure({ category: "callback_endpoint", reason: "endpoint_unreachable" })
const timedOut = () => new McpEvents.Failure({ category: "callback_endpoint", reason: "timeout" })

function ipv4Value(ip: string): number | undefined {
  const parts = ip.split(".")
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9][0-9]*)$/.test(part))) return undefined
  const nums = parts.map(Number)
  if (nums.some((n) => n > 255)) return undefined
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0
}

function inCidr4(value: number, base: string, bits: number): boolean {
  const baseValue = ipv4Value(base)
  if (baseValue === undefined) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (baseValue & mask)
}

const nonPublic4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]

function ipv6Groups(ip: string): number[] | undefined {
  let rest = ip.toLowerCase()
  if (rest.includes(".")) return undefined
  const halves = rest.split("::")
  if (halves.length > 2) return undefined
  const parse = (text: string) => (text === "" ? [] : text.split(":").map((part) => parseInt(part, 16)))
  if (halves.length === 1) {
    const groups = parse(rest)
    return groups.length === 8 && groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : undefined
  }
  const left = parse(halves[0])
  const right = parse(halves[1])
  if (left.length + right.length > 7) return undefined
  const groups = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right]
  return groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : undefined
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const value = ipv4Value(address)
    return value !== undefined && !nonPublic4.some(([base, bits]) => inCidr4(value, base, bits))
  }
  if (version !== 6) return false
  const groups = ipv6Groups(address)
  if (groups === undefined) return false
  if ((groups[0] & 0xe000) !== 0x2000) return false
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false
  if (groups[0] === 0x2001 && groups[1] === 0) return false
  if (groups[0] === 0x2001 && (groups[1] & 0xfff0) === 0x10) return false
  if (groups[0] === 0x2001 && (groups[1] & 0xfff0) === 0x20) return false
  if (groups[0] === 0x5f00) return false
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) return false
  return true
}

export function makeProtectedSend(deps: {
  readonly lookup: (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>
  readonly connect: (input: ConnectInput) => Promise<TransportResponse>
}): Interface["send"] {
  return (request) => Effect.tryPromise({
    try: (signal) => new Promise<TransportResponse>((resolve, reject) => {
      const controller = new AbortController()
      const deadline = Date.now() + Math.min(request.timeoutMs, 10_000)
      let settled = false
      const done = (result: TransportResponse | McpEvents.Failure) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        request.signal?.removeEventListener("abort", abort)
        if (result instanceof McpEvents.Failure) {
          reject(result)
          return
        }
        resolve(result)
      }
      const abort = () => {
        done(unreachable())
        controller.abort()
      }
      const timer = setTimeout(() => {
        done(timedOut())
        controller.abort()
      }, Math.max(0, deadline - Date.now()))
      signal.addEventListener("abort", abort, { once: true })
      request.signal?.addEventListener("abort", abort, { once: true })
      if (signal.aborted || request.signal?.aborted) return abort()
      const send = async () => {
        if (Buffer.byteLength(request.body, "utf8") > 262_144)
          throw new McpEvents.Failure({ category: "callback_endpoint", reason: "payload_too_large" })
        const parsed = Result.try(() => new URL(request.url))
        if (Result.isFailure(parsed)) throw rejected()
        const url = parsed.success
        if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hostname === "") throw rejected()
        const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname
        const addresses = isIP(hostname) !== 0
          ? [{ address: hostname, family: isIP(hostname) }]
          : await deps.lookup(hostname)
        if (settled) return
        if (addresses.length === 0) throw unreachable()
        if (addresses.some((entry) => !isPublicAddress(entry.address))) throw rejected()
        if (Date.now() >= deadline) throw timedOut()
        const response = await deps.connect({
          hostname,
          servername: hostname,
          ip: addresses[0].address,
          port: url.port === "" ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          headers: request.headers,
          body: request.body,
          timeoutMs: deadline - Date.now(),
          signal: controller.signal,
        })
        if (Buffer.byteLength(response.body, "utf8") > 262_144)
          throw new McpEvents.Failure({ category: "callback_endpoint", reason: "payload_too_large" })
        done(response)
      }
      void send().catch((error: unknown) => done(error instanceof McpEvents.Failure ? error : unreachable()))
    }),
    catch: (error) => error instanceof McpEvents.Failure ? error : unreachable(),
  })
}

const httpsConnect = (input: ConnectInput) => new Promise<TransportResponse>((resolve, reject) => {
  let settled = false
  const done = (fn: () => void) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abort)
    fn()
  }
  const abort = () => req.destroy(unreachable())
  const req = https.request(
    {
      host: input.ip,
      servername: input.servername,
      port: input.port,
      path: input.path,
      method: "POST",
      agent: false,
      headers: { ...input.headers, host: input.hostname, "content-length": String(Buffer.byteLength(input.body, "utf8")) },
    },
    (response) => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 262_144) {
          req.destroy(rejected())
          return
        }
        chunks.push(chunk)
      })
      response.on("end", () => done(() => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })))
      response.on("error", () => done(() => reject(unreachable())))
    },
  )
  const timer = setTimeout(() => req.destroy(timedOut()), input.timeoutMs)
  req.on("error", (error) => done(() => reject(error instanceof McpEvents.Failure ? error : unreachable())))
  if (input.signal !== undefined) {
    if (input.signal.aborted) return abort()
    input.signal.addEventListener("abort", abort, { once: true })
  }
  req.end(input.body)
})

export class Service extends Context.Service<Service, Interface>()("@ycoding/McpEventsTransport") {}

const layer = Layer.succeed(Service, Service.of({
  send: makeProtectedSend({
    lookup: (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
    connect: httpsConnect,
  }),
}))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

export const layerWith = (transport: Interface) => Layer.succeed(Service, Service.of(transport))
