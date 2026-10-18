export * as RemoteLocalApp from "./remote-local-app"

import { randomBytes } from "node:crypto"

export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
export type Owner = { ownerID: string; deviceID: string; sessionID: string }
export type Scope = Owner & { clientID: string; grantID: string; epoch: string }
export type Route = { path: string; match: "exact" | "prefix"; methods: Method[] }
export type Input = { sessionID: string; host: "127.0.0.1" | "[::1]"; port: number; entryPath: string; routes: Route[]; ttlMs?: number }
export type Registration = { id: string; generation: string; sessionID: string; expiresAt: number; entryPath: string; allowedMethods: Method[]; routes: Route[] }
export type Request = { id: string; generation: string; scope: Scope; method: Method; path: string; headers: HeadersInit; body?: Uint8Array; signal?: AbortSignal }
export type Result = { status: number; headers: Record<string, string | string[]>; body: Uint8Array }
export type Fetcher = (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type Options = {
  verifySession: (sessionID: string) => Promise<boolean>
  authorize: (scope: Scope, signal: AbortSignal) => Promise<boolean>
  now?: () => number
  fetcher?: Fetcher
}
export type Category = "invalid_registration" | "forbidden" | "not_found" | "expired" | "busy" | "unsupported_stream" | "upstream_unavailable" | "too_large" | "redirect_rejected"

export class Error extends globalThis.Error {
  override readonly name = "RemoteLocalAppError"
  readonly category: Category
  constructor(category: Category) {
    super(category)
    this.category = category
  }
}

type App = {
  metadata: Registration
  owner: Owner
  origin: string
  scope?: Scope
  previewOrigin?: string
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
  active: number
}

const methods: Method[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
const ownerKeys = ["ownerID", "deviceID", "sessionID"] as const
const scopeKeys = [...ownerKeys, "clientID", "grantID", "epoch"] as const
const requestHeaders = ["accept", "accept-language", "content-type", "if-none-match", "if-modified-since", "range", "if-range"]
const responseHeaders = ["content-type", "cache-control", "etag", "last-modified", "expires", "vary", "accept-ranges", "content-range", "content-language", "content-security-policy", "content-security-policy-report-only", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy"]
const maxResponse = 2 * 1024 * 1024

function fail(category: Category): never { throw new Error(category) }

export function create(options: Options) {
  if (typeof options.authorize !== "function" || typeof options.verifySession !== "function") fail("invalid_registration")
  const now = options.now ?? Date.now
  const fetcher = options.fetcher ?? fetch
  const apps = new Map<string, App>()
  const pending = new Set<{ sessionID: string; cancelled: boolean }>()
  let closed = false
  let active = 0

  function remove(app: App) {
    apps.delete(app.metadata.id)
    clearTimeout(app.timer)
    app.controller.abort()
  }

  function sweep() {
    for (const app of apps.values()) if (now() >= app.metadata.expiresAt) remove(app)
  }

  function lookup(id: string, owner?: Owner) {
    const app = apps.get(id)
    if (closed || !app) fail("not_found")
    if (owner && !sameOwner(owner, app.owner)) fail("forbidden")
    if (now() >= app.metadata.expiresAt) { remove(app); fail("expired") }
    return app
  }

  async function register(input: Input, owner: Owner): Promise<Registration> {
    validateRegistration(input, owner)
    if (closed) fail("not_found")
    sweep()
    if (apps.size + pending.size >= 64 || [...apps.values()].filter((app) => app.owner.sessionID === input.sessionID).length + [...pending].filter((item) => item.sessionID === input.sessionID).length >= 16) fail("busy")
    const snapshot = structuredClone(input)
    const identity = { ...owner }
    const reservation = { sessionID: input.sessionID, cancelled: false }
    pending.add(reservation)
    try {
      const verified = await Promise.resolve().then(() => options.verifySession(snapshot.sessionID)).catch(() => false)
      if (closed || reservation.cancelled) fail("not_found")
      if (!verified) fail("invalid_registration")
      const metadata: Registration = {
        id: `app_${randomBytes(16).toString("hex")}`,
        generation: `generation_${randomBytes(16).toString("hex")}`,
        sessionID: snapshot.sessionID,
        expiresAt: now() + (snapshot.ttlMs ?? 900_000),
        entryPath: snapshot.entryPath,
        allowedMethods: [...new Set(snapshot.routes.flatMap((route) => route.methods))],
        routes: snapshot.routes,
      }
      const app: App = { metadata, owner: identity, origin: `http://${snapshot.host}:${snapshot.port}`, controller: new AbortController(), active: 0 }
      apps.set(metadata.id, app)
      if (!options.now) {
        app.timer = setTimeout(() => remove(app), metadata.expiresAt - now())
        app.timer.unref()
      }
      return structuredClone(metadata)
    } finally { pending.delete(reservation) }
  }

  function publish(input: { id: string; generation: string; owner: Owner; scope: Scope; previewOrigin?: string }): Registration {
    const app = lookup(input.id, input.owner)
    if (!validIdentity(input.owner, ownerKeys) || !validIdentity(input.scope, scopeKeys) || !sameOwner(input.scope, app.owner) || input.generation !== app.metadata.generation) fail("forbidden")
    if (app.scope && !sameScope(input.scope, app.scope)) fail("forbidden")
    if (input.previewOrigin !== undefined) {
      if (!URL.canParse(input.previewOrigin)) fail("forbidden")
      const preview = new URL(input.previewOrigin)
      if (preview.origin !== input.previewOrigin || preview.username || preview.password ||
        (preview.protocol !== "https:" && !(preview.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(preview.hostname))) ||
        (app.previewOrigin !== undefined && app.previewOrigin !== input.previewOrigin)) fail("forbidden")
      app.previewOrigin = input.previewOrigin
    }
    app.scope = { ...input.scope }
    return structuredClone(app.metadata)
  }

  function revoke(input: { id: string; owner: Owner }): void {
    if (!validIdentity(input.owner, ownerKeys)) fail("forbidden")
    remove(lookup(input.id, input.owner))
  }

  function revokeSession(sessionID: string): void {
    for (const reservation of pending) if (reservation.sessionID === sessionID) reservation.cancelled = true
    for (const app of apps.values()) if (app.owner.sessionID === sessionID) remove(app)
  }

  function list(owner: Owner): Registration[] {
    if (!validIdentity(owner, ownerKeys)) fail("forbidden")
    sweep()
    return [...apps.values()].filter((app) => sameOwner(owner, app.owner)).map((app) => structuredClone(app.metadata))
  }

  function clear(): void {
    for (const reservation of pending) reservation.cancelled = true
    for (const app of apps.values()) remove(app)
  }

  function close(): void {
    clear()
    closed = true
  }

  async function dispatch(input: Request): Promise<Result> {
    if (!keys(input, ["id", "generation", "scope", "method", "path", "headers", "body", "signal"]) || !validIdentity(input.scope, scopeKeys)) fail("forbidden")
    const app = lookup(input.id, input.scope)
    if (input.generation !== app.metadata.generation || !app.scope || !sameScope(app.scope, input.scope)) fail("forbidden")
    const path = parsePath(input.path, "forbidden")
    if (!methods.includes(input.method) || !allows(app.metadata.routes, path, input.method)) fail("forbidden")
    if (input.body !== undefined && !(input.body instanceof Uint8Array)) fail("forbidden")
    if ((input.body?.byteLength ?? 0) > 256 * 1024) fail("too_large")
    if (input.body !== undefined && (input.method === "GET" || input.method === "HEAD")) fail("forbidden")
    const identity = { ...input.scope }
    const method = input.method
    const requestPath = input.path
    const body = input.body?.slice()
    const headers = forwardHeaders(input.headers, app)
    if (active >= 16 || app.active >= 4) fail("busy")
    const signal = AbortSignal.any([app.controller.signal, AbortSignal.timeout(Math.max(1, Math.min(15_000, app.metadata.expiresAt - now()))), ...(input.signal ? [input.signal] : [])])
    active++
    app.active++
    let response: Response | undefined
    try {
      if (!await abortable(() => options.authorize({ ...identity }, signal), signal)) fail("upstream_unavailable")
      if (now() >= app.metadata.expiresAt || app.controller.signal.aborted) fail("upstream_unavailable")
      const fetched = await abortable(() => Promise.resolve(fetcher(`${app.origin}${requestPath}`, {
        method, headers, body, redirect: "manual", signal,
      })).then((value) => {
        response = value
        if (signal.aborted) { void discard(value); fail("upstream_unavailable") }
        return value
      }), signal)
      if (fetched.status === 101 || fetched.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream") fail("unsupported_stream")
      const output = outputHeaders(fetched, app, requestPath, method)
      const bytes = await readBody(fetched, signal)
      if (!await abortable(() => options.authorize({ ...identity }, signal), signal)) fail("upstream_unavailable")
      if (app.controller.signal.aborted || now() >= app.metadata.expiresAt || signal.aborted) fail("upstream_unavailable")
      if (method !== "HEAD" && fetched.status !== 204 && fetched.status !== 304) output["content-length"] = String(bytes.byteLength)
      return { status: fetched.status, headers: output, body: bytes }
    } catch (error) {
      if (response) await discard(response)
      if (error instanceof Error) throw error
      return fail("upstream_unavailable")
    } finally { active--; app.active-- }
  }

  return { register, publish, revoke, list, dispatch, revokeSession, sweep, clear, close }
}

function keys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key))
}

function validIdentity(value: unknown, fields: readonly string[]): boolean {
  if (!keys(value, fields)) return false
  return fields.every((key) => {
    const field = value[key]
    if (key === "clientID") return typeof field === "string" && field.length > 0 && field.length <= 2048 && !/[\r\n\0]/.test(field)
    return typeof field === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(field)
  })
}

function sameOwner(left: Owner, right: Owner): boolean { return ownerKeys.every((key) => left[key] === right[key]) }
function sameScope(left: Scope, right: Scope): boolean { return scopeKeys.every((key) => left[key] === right[key]) }

function validateRegistration(input: Input, owner: Owner): void {
  if (!keys(input, ["sessionID", "host", "port", "entryPath", "routes", "ttlMs"]) || !validIdentity(owner, ownerKeys) || input.sessionID !== owner.sessionID || !["127.0.0.1", "[::1]"].includes(input.host)) fail("invalid_registration")
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || (input.ttlMs !== undefined && (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > 3_600_000))) fail("invalid_registration")
  if (!Array.isArray(input.routes) || input.routes.length === 0 || input.routes.length > 64) fail("invalid_registration")
  for (const route of input.routes) {
    if (!keys(route, ["path", "match", "methods"]) || typeof route.path !== "string" || route.path.includes("?") || route.path.includes("*") || !["exact", "prefix"].includes(route.match) || !Array.isArray(route.methods) || route.methods.length === 0 || route.methods.length > methods.length || !route.methods.every((method) => methods.includes(method))) fail("invalid_registration")
    parsePath(route.path, "invalid_registration")
  }
  if (!allows(input.routes, parsePath(input.entryPath, "invalid_registration"), "GET")) fail("invalid_registration")
}

function parsePath(value: string, category: Category): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 4096 || !value.startsWith("/") || value.startsWith("//") || /[\x00-\x20\x7f\\#]/.test(value) || /%(?![\da-f]{2})/i.test(value)) fail(category)
  const index = value.indexOf("?")
  const path = index < 0 ? value : value.slice(0, index)
  const query = index < 0 ? "" : value.slice(index + 1)
  let decoded = path
  let decodedQuery = query
  for (let layer = 0; layer < 16; layer++) {
    if (decoded.split("/").some((part) => part === "." || part === "..") || /[\x00-\x1f\x7f-\x9f\\]/.test(decoded) || /[\x00-\x1f\x7f\\]/.test(decodedQuery) || /%(?:2f|5c|3f|23)/i.test(decoded)) fail(category)
    const next = decodePath(decoded, category)
    const nextQuery = decodedQuery.replace(/%([\da-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    if (next === decoded && nextQuery === decodedQuery) return decoded
    decoded = next
    decodedQuery = nextQuery
  }
  return fail(category)
}

function decodePath(value: string, category: Category): string {
  try { return decodeURIComponent(value.replace(/%(?![\da-f]{2})/gi, "%25")) }
  catch { return fail(category) }
}

function allows(routes: Route[], path: string, method: Method): boolean {
  return routes.some((route) => {
    const registered = parsePath(route.path, "invalid_registration")
    return route.methods.includes(method) && (path === registered || (route.match === "prefix" && path.startsWith(registered.endsWith("/") ? registered : `${registered}/`)))
  })
}

function forwardHeaders(input: HeadersInit, app: App): Headers {
  try {
    const headers = new Headers(input)
    if (headers.has("upgrade") || headers.get("connection")?.split(",").some((token) => token.trim().toLowerCase() === "upgrade")) fail("unsupported_stream")
    const output = new Headers({ "accept-encoding": "identity" })
    for (const name of requestHeaders) {
      const value = headers.get(name)
      if (value !== null) output.set(name, value)
    }
    const preview = app.previewOrigin
    if (!preview) return output
    const origin = new URL(preview)
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== preview) fail("upstream_unavailable")
    if (headers.get("origin") === preview) output.set("origin", app.origin)
    const referer = headers.get("referer")
    if (referer?.startsWith(`${preview}/`)) {
      const path = referer.slice(preview.length)
      try {
        parsePath(path, "forbidden")
        if (new URL(referer).origin === preview) output.set("referer", `${app.origin}${path}`)
      } catch { return output }
    }
    return output
  } catch (error) {
    if (error instanceof Error) throw error
    return fail("forbidden")
  }
}

function outputHeaders(response: Response, app: App, path: string, method: Method): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {}
  const length = response.headers.get("content-length")
  if (method === "HEAD" && ![204, 205].includes(response.status) && !response.headers.has("content-encoding") && length !== null && /^(0|[1-9][0-9]*)$/.test(length) && Number.isSafeInteger(Number(length)))
    output["content-length"] = length
  for (const name of responseHeaders) {
    const value = response.headers.get(name)
    if (value !== null) output[name] = value
  }
  const disposition = response.headers.get("content-disposition")
  if (disposition && disposition.length <= 1024 && /^(inline|attachment)(?:;\s*filename="[^"/\\\x00-\x1f\x7f]*")?$/i.test(disposition)) output["content-disposition"] = disposition
  const location = response.headers.get("location")
  if (location !== null) {
    try {
      if (!location || /[\x00-\x20\x7f\\#]/.test(location) || location.startsWith("//")) fail("redirect_rejected")
      const absolute = /^[a-z][a-z\d+.-]*:/i.test(location)
      if (absolute && location !== app.origin && !location.startsWith(`${app.origin}/`) && !location.startsWith(`${app.origin}?`)) fail("redirect_rejected")
      const suffix = absolute ? location.slice(app.origin.length) : location
      const pathname = path.split("?")[0]!
      const candidate = absolute ? suffix.startsWith("/") ? suffix : `/${suffix}` : location.startsWith("/") ? location : `${pathname.slice(0, pathname.lastIndexOf("/") + 1)}${location}`
      parsePath(candidate, "redirect_rejected")
      const url = new URL(location, `${app.origin}${path}`)
      if (url.origin !== new URL(app.origin).origin || url.username || url.password || url.hash) fail("redirect_rejected")
      const effective = response.status === 303 && method !== "HEAD" || (response.status === 301 || response.status === 302) && method === "POST" ? "GET" : method
      if (!allows(app.metadata.routes, parsePath(`${url.pathname}${url.search}`, "redirect_rejected"), effective)) fail("redirect_rejected")
      output.location = `${url.pathname}${url.search}`
    } catch { fail("redirect_rejected") }
  }
  return output
}

function abortable<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("upstream_unavailable"))
    if (signal.aborted) { abort(); return }
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => {
      if (signal.aborted) fail("upstream_unavailable")
      return run()
    }).then((value) => {
      if (signal.aborted) abort()
      else resolve(value)
    }, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

async function discard(response: Response): Promise<void> {
  if (!response.body || response.body.locked) return
  await response.body.cancel().then(() => undefined, () => undefined)
}

async function readBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length") ?? "0") > maxResponse) fail("too_large")
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const result = await abortable(() => reader.read(), signal)
      if (result.done) break
      length += result.value.byteLength
      if (length > maxResponse) fail("too_large")
      chunks.push(result.value)
    }
  } catch (error) {
    await reader.cancel().then(() => undefined, () => undefined)
    throw error
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
