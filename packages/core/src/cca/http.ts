export * as CcaHttp from "./http"

import http from "node:http"
import https from "node:https"
import type { CcaAuthorize } from "./authorization"
import { CcaExecutorError, type CcaAuthorizationGrant } from "./errors"

export const CCA_HTTP_NETWORK_ACTION = "webfetch"
export const MAX_HTTP_BODY_DELTA_BYTES = 1024 * 1024
export const MAX_HTTP_REDIRECTS = 10
export const HTTP_HEADER_ENV_DENYLIST: readonly string[] = [
  "CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN",
  "OPENAI_FEDERATION_RULE_ID",
  "OPENAI_IDENTITY_TOKEN_FILE",
  "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
  "OPENAI_API_KEY",
  "CODEX_GUARDIAN_DECISIONS_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_CONNECTORS_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "AZURE_FEDERATED_TOKEN_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
]

export interface CcaHttpHeader {
  readonly name: string
  readonly value: string
  readonly valueEnvVar?: string
}

export type CcaHttpRedirectPolicy = "follow" | "stop"

export interface CcaHttpRequestParams {
  readonly method: string
  readonly url: string
  readonly headers: readonly CcaHttpHeader[]
  readonly body?: Uint8Array
  readonly timeoutMs?: number
  readonly redirectPolicy: CcaHttpRedirectPolicy
  readonly requestId: string
  readonly streamResponse: boolean
}

export interface CcaHttpRequestResponse {
  readonly status: number
  readonly headers: readonly CcaHttpHeader[]
  readonly body: Uint8Array
}

export interface CcaHttpBodyDelta {
  readonly requestId: string
  readonly seq: number
  readonly delta: Uint8Array
  readonly done: boolean
  readonly error: string | null
}

export interface CcaHttpRequestContext {
  readonly signal: AbortSignal
  readonly emit: (delta: CcaHttpBodyDelta) => Promise<void> | void
}

export interface CcaHttpBodyStream {
  readonly start: () => Promise<void>
  readonly cancel: () => Promise<void>
}

export interface CcaHttpRequestOutcome {
  readonly response: CcaHttpRequestResponse
  readonly stream?: CcaHttpBodyStream
}

export interface CcaHttpOptions {
  readonly authorize: CcaAuthorize
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface CcaHttpHandler {
  readonly request: (params: CcaHttpRequestParams, ctx: CcaHttpRequestContext) => Promise<CcaHttpRequestOutcome>
  readonly close: () => Promise<void>
}

type Interruption = "timeout" | "cancel"

interface Flight {
  readonly streamId: string | undefined
  readonly finished: Promise<void>
  readonly markFinished: () => void
  readonly grants: CcaAuthorizationGrant[]
  interruption: Interruption | undefined
  request: http.ClientRequest | undefined
  response: http.IncomingMessage | undefined
  stopDeadline: () => void
  detach: () => void
  cancelPending: (() => Promise<void>) | undefined
  settled: Promise<boolean> | undefined
}

type PreparedHeader = readonly [name: string, value: string, envVar: string | undefined]

interface PreparedRequest {
  readonly method: string
  readonly url: URL
  readonly headers: readonly PreparedHeader[]
  readonly body: Uint8Array | undefined
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const VISIBLE_HEADER_VALUE = /^[\t\x20-\x7e]*$/
const URL_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/
const SPECIAL_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp", "file"])
const OPAQUE_HOST_FORBIDDEN = /[\0\t\n\r #/:<>?@[\\\]^|]/
const PERCENT_ESCAPE = /^%[0-9A-Fa-f]{2}$/
const UTF8 = new TextDecoder("utf-8", { fatal: true })
const MAX_TIMER_MS = 2_147_483_647
const BODY_ERROR = "error decoding response body"
const BODY_HEADERS = new Set(["transfer-encoding", "content-encoding", "content-type", "content-length"])
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "cookie2", "proxy-authorization", "www-authenticate"])

const invalidParams = (message: string) => new CcaExecutorError(-32602, message)
const internalError = (message: string) => new CcaExecutorError(-32603, message)
const permissionDenied = () => new CcaExecutorError(-32001, "Permission denied")
const sessionClosed = () => new CcaExecutorError(-32603, "Executor session closed")

const asciiLowercase = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase())

function endsInNumber(host: string): boolean {
  const labels = host.split(".")
  if (labels.length > 1 && labels.at(-1) === "") labels.pop()
  const last = labels.at(-1) ?? ""
  return /^[0-9]+$/.test(last) || /^0[xX][0-9A-Fa-f]*$/.test(last)
}

function hostParseError(host: string, scheme: string): string | undefined {
  if (host.startsWith("[")) {
    return host.endsWith("]") && URL.canParse(`http://${host}/`) ? undefined : "invalid IPv6 address"
  }
  if (!SPECIAL_SCHEMES.has(scheme)) return OPAQUE_HOST_FORBIDDEN.test(host) ? "invalid domain character" : undefined
  if (host === "") return scheme === "file" ? undefined : "empty host"
  if (URL.canParse(`http://${host}/`)) return undefined
  return endsInNumber(host) ? "invalid IPv4 address" : "invalid international domain name"
}

export function urlParseErrorText(input: string): string {
  const trimmed = input.replace(/^[\0-\x20]+|[\0-\x20]+$/g, "").replace(/[\t\n\r]/g, "")
  const match = URL_SCHEME.exec(trimmed)
  if (match === null) return "relative URL without a base"
  const scheme = match[1].toLowerCase()
  const special = SPECIAL_SCHEMES.has(scheme)
  const rest = trimmed.slice(match[0].length)
  const authorityStart = special ? rest.replace(/^[/\\]*/, "") : rest.startsWith("//") ? rest.slice(2) : undefined
  if (authorityStart === undefined) return "relative URL without a base"
  const authority = authorityStart.split(special ? /[/\\?#]/ : /[/?#]/, 1)[0]
  if (scheme === "file") return hostParseError(authority, scheme) ?? "invalid international domain name"
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1)
  const colon = hostPort.indexOf(":", hostPort.startsWith("[") ? Math.max(hostPort.indexOf("]"), 0) : 0)
  const host = colon === -1 ? hostPort : hostPort.slice(0, colon)
  const hostError = hostParseError(host, scheme)
  if (hostError !== undefined) return hostError
  const port = colon === -1 ? "" : hostPort.slice(colon + 1)
  if (!/^[0-9]*$/.test(port) || Number(port) > 65_535) return "invalid port number"
  return "invalid international domain name"
}

function percentDecode(value: string): string | undefined {
  const parts = value.split(/(%[0-9A-Fa-f]{2})/).map((part) =>
    PERCENT_ESCAPE.test(part) ? Buffer.from([Number.parseInt(part.slice(1), 16)]) : Buffer.from(part),
  )
  try {
    return UTF8.decode(Buffer.concat(parts))
  } catch {
    return undefined
  }
}

function takeCredentials(url: URL): string | undefined {
  if (url.username === "" && url.password === "") return undefined
  const username = percentDecode(url.username)
  const password = percentDecode(url.password)
  url.username = ""
  url.password = ""
  if (username === undefined || password === undefined) return undefined
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function headerEnvVars(headers: readonly PreparedHeader[]): string[] {
  return [...new Set(headers.flatMap(([, , envVar]) => (envVar === undefined ? [] : [envVar])))]
}

function prepare(params: CcaHttpRequestParams, env: Readonly<Record<string, string | undefined>>): PreparedRequest {
  if (!TOKEN.test(params.method)) throw invalidParams("http/request method is invalid: invalid HTTP method")
  let url: URL
  try {
    url = new URL(params.url)
  } catch {
    throw invalidParams(`http/request url is invalid: ${urlParseErrorText(params.url)}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidParams(`http/request only supports http and https URLs, got ${url.protocol.slice(0, -1)}`)
  }
  const credentials = takeCredentials(url)
  const headers = params.headers.map((header): PreparedHeader => {
    if (!TOKEN.test(header.name)) throw invalidParams("http/request header name is invalid: invalid HTTP header name")
    let value = header.value
    const envVar = header.valueEnvVar
    if (envVar !== undefined) {
      const lowered = asciiLowercase(envVar)
      if (HTTP_HEADER_ENV_DENYLIST.some((denied) => asciiLowercase(denied) === lowered)) {
        throw invalidParams(
          `http/request header ${header.name} cannot use executor environment variable ${envVar}`,
        )
      }
      const envValue = env[envVar]
      if (typeof envValue !== "string" || !Object.hasOwn(env, envVar)) {
        throw invalidParams(`http/request header ${header.name} requires executor environment variable ${envVar}`)
      }
      if (envValue === "") {
        throw invalidParams(
          `http/request header ${header.name} requires a non-empty executor environment variable ${envVar}`,
        )
      }
      value = `${value}${envValue}`
    }
    if (!VISIBLE_HEADER_VALUE.test(value)) {
      throw invalidParams(`http/request header value is invalid for ${header.name}: failed to parse header value`)
    }
    return [asciiLowercase(header.name), value, envVar]
  })
  if (credentials !== undefined && !headers.some(([name]) => name === "authorization")) {
    headers.unshift(["authorization", credentials, undefined])
  }
  return { method: params.method, url, headers, body: params.body }
}

function responseHeaders(raw: readonly string[]): CcaHttpHeader[] {
  const groups = new Map<string, string[]>()
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = asciiLowercase(raw[index])
    const values = groups.get(name) ?? []
    groups.set(name, values)
    const value = raw[index + 1]
    if (VISIBLE_HEADER_VALUE.test(value)) values.push(value)
  }
  return [...groups].flatMap(([name, values]) => values.map((value) => ({ name, value })))
}

function knownPort(url: URL) {
  return url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port
}

function referer(next: URL, previous: URL): string | undefined {
  if (next.protocol === "http:" && previous.protocol === "https:") return undefined
  const value = new URL(previous.href)
  value.hash = ""
  return value.href
}

function redirectLocation(response: http.IncomingMessage, base: URL): URL | undefined {
  const location = response.headers.location
  if (typeof location !== "string") return undefined
  try {
    return new URL(location, base)
  } catch {
    return undefined
  }
}

function deadline(timeoutMs: number, expire: () => void): () => void {
  const end = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout>
  const arm = () => {
    const remaining = Math.max(0, end - Date.now())
    timer = setTimeout(remaining > MAX_TIMER_MS ? arm : expire, Math.min(remaining, MAX_TIMER_MS))
    timer.unref?.()
  }
  arm()
  return () => clearTimeout(timer)
}

async function readAll(response: http.IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const chunk of response as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks)
}

export function createCcaHttpHandler(options: CcaHttpOptions): CcaHttpHandler {
  const env = options.env ?? process.env
  const httpAgent = new http.Agent({ keepAlive: true })
  const httpsAgent = new https.Agent({ keepAlive: true })
  const flights = new Set<Flight>()
  const streamIds = new Set<string>()
  let closed = false
  let releaseFailed = false

  const interrupt = (flight: Flight, interruption: Interruption) => {
    if (flight.interruption !== undefined) return
    flight.interruption = interruption
    flight.request?.destroy()
    flight.response?.destroy()
  }

  const settle = (flight: Flight): Promise<boolean> => {
    flight.settled ??= (async () => {
      flight.stopDeadline()
      flight.detach()
      flight.cancelPending = undefined
      const results = await Promise.allSettled(flight.grants.map((grant) => grant.release()))
      flights.delete(flight)
      if (flight.streamId !== undefined) streamIds.delete(flight.streamId)
      const released = results.every((result) => result.status === "fulfilled")
      if (!released) releaseFailed = true
      flight.markFinished()
      return released
    })()
    return flight.settled
  }

  const open = (ctx: CcaHttpRequestContext, streamId: string | undefined): Flight => {
    let markFinished = () => {}
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve
    })
    const flight: Flight = {
      streamId,
      finished,
      markFinished,
      grants: [],
      interruption: undefined,
      request: undefined,
      response: undefined,
      stopDeadline: () => {},
      detach: () => {},
      cancelPending: undefined,
      settled: undefined,
    }
    const onAbort = () => interrupt(flight, "cancel")
    ctx.signal.addEventListener("abort", onAbort, { once: true })
    flight.detach = () => ctx.signal.removeEventListener("abort", onAbort)
    flights.add(flight)
    if (streamId !== undefined) streamIds.add(streamId)
    return flight
  }

  const interrupted = (flight: Flight, url: URL) =>
    flight.interruption === "cancel" || closed
      ? sessionClosed()
      : internalError(`http/request failed: error sending request for url (${url.href})`)

  const authorizeHop = async (flight: Flight, request: PreparedRequest) => {
    const { method, url } = request
    const envVars = headerEnvVars(request.headers)
    let grant: CcaAuthorizationGrant
    try {
      grant = await options.authorize({
        action: CCA_HTTP_NETWORK_ACTION,
        resources: [url.href],
        metadata: envVars.length === 0 ? { method } : { method, headerEnvVars: envVars.join(",") },
      })
    } catch {
      throw permissionDenied()
    }
    if (!grant || typeof grant.release !== "function") throw permissionDenied()
    flight.grants.push(grant)
    if (closed || flight.interruption !== undefined) throw interrupted(flight, url)
  }

  const send = (flight: Flight, request: PreparedRequest) =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      const { url, headers, body } = request
      const has = (name: string) => headers.some(([header]) => header === name)
      const wire: string[] = []
      if (!has("host")) wire.push("host", url.host)
      for (const [name, value] of headers) wire.push(name, value)
      if (!has("accept")) wire.push("accept", "*/*")
      if (body !== undefined && !has("content-length")) wire.push("content-length", String(body.byteLength))
      const secure = url.protocol === "https:"
      const outgoing = (secure ? https : http).request(
        {
          hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"),
          port: knownPort(url),
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers: wire,
          setHost: false,
          agent: secure ? httpsAgent : httpAgent,
        },
        resolve,
      )
      flight.request = outgoing
      outgoing.on("error", reject)
      if (flight.interruption !== undefined) outgoing.destroy()
      outgoing.end(body)
    })

  const execute = async (
    flight: Flight,
    prepared: PreparedRequest,
    params: CcaHttpRequestParams,
  ): Promise<http.IncomingMessage> => {
    let current = prepared
    const visited: URL[] = []
    for (;;) {
      await authorizeHop(flight, current)
      if (visited.length === 0 && params.timeoutMs !== undefined) {
        flight.stopDeadline = deadline(params.timeoutMs, () => interrupt(flight, "timeout"))
      }
      let response: http.IncomingMessage
      try {
        response = await send(flight, current)
      } catch {
        throw interrupted(flight, current.url)
      }
      flight.response = response
      if (params.redirectPolicy === "stop") return response

      let { method, headers, body } = current
      const status = response.statusCode ?? 0
      if (status === 301 || status === 302 || status === 303) {
        body = undefined
        headers = headers.filter(([name]) => !BODY_HEADERS.has(name))
        if (method !== "GET" && method !== "HEAD") method = "GET"
      } else if (status !== 307 && status !== 308) {
        return response
      }
      const next = redirectLocation(response, current.url)
      if (next === undefined) return response
      takeCredentials(next)

      const refererValue = referer(next, current.url)
      if (refererValue !== undefined) {
        headers = [...headers.filter(([name]) => name !== "referer"), ["referer", refererValue, undefined]]
      }
      visited.push(current.url)
      response.destroy()
      flight.response = undefined
      if (visited.length > MAX_HTTP_REDIRECTS) {
        throw internalError(`http/request failed: error following redirect for url (${current.url.href})`)
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw internalError(`http/request failed: builder error for url (${next.href})`)
      }
      if (next.hostname !== current.url.hostname || knownPort(next) !== knownPort(current.url)) {
        headers = headers.filter(([name]) => !SENSITIVE_HEADERS.has(name))
      }
      current = { method, url: next, headers, body }
    }
  }

  const bodyStream = (
    flight: Flight,
    response: http.IncomingMessage,
    requestId: string,
    ctx: CcaHttpRequestContext,
  ): CcaHttpBodyStream => {
    let running: Promise<void> | undefined
    const emit = async (delta: CcaHttpBodyDelta) => {
      try {
        await ctx.emit(delta)
        return true
      } catch {
        return false
      }
    }
    const pump = async () => {
      let seq = 1
      try {
        for await (const chunk of response as AsyncIterable<Buffer>) {
          for (let offset = 0; offset < chunk.byteLength; offset += MAX_HTTP_BODY_DELTA_BYTES) {
            const delta = chunk.subarray(offset, offset + MAX_HTTP_BODY_DELTA_BYTES)
            if (!(await emit({ requestId, seq, delta, done: false, error: null }))) {
              response.destroy()
              return
            }
            seq++
          }
        }
      } catch {
        if (flight.interruption !== "cancel") {
          await emit({ requestId, seq, delta: new Uint8Array(), done: true, error: BODY_ERROR })
        }
        return
      }
      await emit({ requestId, seq, delta: new Uint8Array(), done: true, error: null })
    }
    const cancel = async () => {
      if (running === undefined) {
        running = (async () => {
          interrupt(flight, "cancel")
          await settle(flight)
        })()
        return running
      }
      interrupt(flight, "cancel")
      await running
    }
    flight.cancelPending = cancel
    return {
      start: () => {
        if (running === undefined) {
          flight.cancelPending = undefined
          running = pump().then(async () => {
            await settle(flight)
          })
        }
        return running
      },
      cancel,
    }
  }

  const request = async (
    params: CcaHttpRequestParams,
    ctx: CcaHttpRequestContext,
  ): Promise<CcaHttpRequestOutcome> => {
    if (closed || ctx.signal.aborted) throw sessionClosed()
    if (params.streamResponse && streamIds.has(params.requestId)) {
      throw invalidParams(`http/request streamResponse requestId \`${params.requestId}\` is already active`)
    }
    const flight = open(ctx, params.streamResponse ? params.requestId : undefined)
    let response: http.IncomingMessage
    try {
      response = await execute(flight, prepare(params, env), params)
    } catch (error) {
      await settle(flight)
      throw error
    }
    const head = { status: response.statusCode ?? 0, headers: responseHeaders(response.rawHeaders) }
    if (params.streamResponse) {
      return {
        response: { ...head, body: new Uint8Array() },
        stream: bodyStream(flight, response, params.requestId, ctx),
      }
    }
    let body: Uint8Array
    try {
      body = await readAll(response)
    } catch {
      const failure =
        flight.interruption === "cancel" || closed
          ? sessionClosed()
          : internalError(`failed to read http/request response body: ${BODY_ERROR}`)
      await settle(flight)
      throw failure
    }
    if (!(await settle(flight))) throw internalError("Internal error")
    return { response: { ...head, body } }
  }

  const close = async () => {
    closed = true
    const live = [...flights]
    for (const flight of live) {
      if (flight.cancelPending) void flight.cancelPending()
      else interrupt(flight, "cancel")
    }
    await Promise.all(live.map((flight) => flight.finished))
    httpAgent.destroy()
    httpsAgent.destroy()
    if (releaseFailed) throw internalError("Internal error")
  }

  return { request, close }
}
