export * as RemoteAppPreview from "./app-preview.ts"

export type Scope = {
  readonly ownerID: string
  readonly deviceID: string
  readonly sessionID: string
  readonly clientID: string
  readonly grantID: string
  readonly epoch: string
}

export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
export type DispatchInput = {
  readonly id: string
  readonly generation: string
  readonly scope: Scope
  readonly method: Method
  readonly path: string
  readonly headers: Record<string, string>
  readonly body?: Uint8Array
  readonly signal: AbortSignal
}
export type DispatchResult = {
  readonly status: number
  readonly headers: Readonly<Record<string, string | readonly string[]>>
  readonly body: Uint8Array
}

export type Options = {
  readonly origins: readonly string[]
  readonly frameAncestors: readonly string[]
  readonly authorize: (scope: Scope, signal: AbortSignal) => Promise<boolean>
  readonly dispatch: (input: DispatchInput) => Promise<DispatchResult>
  readonly now?: () => number
}

export type IssueInput = {
  readonly id: string
  readonly generation: string
  readonly scope: Scope
  readonly origin: string
  readonly entryPath: string
  readonly expiresAt: number
}
export type Lease = { readonly url: string; readonly origin: string; readonly expiresAt: number; readonly tag: string }
export type Category = "disabled" | "invalid_configuration" | "invalid_lease" | "origin_bound" | "unauthorized" | "forbidden" | "not_found" | "gone" | "too_large" | "upgrade_unsupported" | "method_unsupported" | "upstream_unavailable"

export class Failure extends globalThis.Error {
  override readonly name = "RemoteAppPreviewFailure"
  constructor(readonly category: Category) { super(category) }
}

type Registration = Omit<IssueInput, "scope"> & {
  readonly scope: Scope
  readonly tag: string
  readonly controller: AbortController
  ticketHash?: Uint8Array
  cookieHash?: Uint8Array
  timer?: ReturnType<typeof setTimeout>
}

const scopeKeys = ["ownerID", "deviceID", "sessionID", "clientID", "grantID", "epoch"] as const
const methods: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
export const requestHeaders: readonly string[] = ["accept", "accept-language", "content-type", "range", "if-range", "if-none-match", "if-modified-since", "origin", "referer"]
export const responseHeaders: readonly string[] = ["content-type", "content-disposition", "etag", "last-modified", "expires", "vary", "accept-ranges", "content-range", "content-language", "content-security-policy", "content-security-policy-report-only", "x-frame-options", "x-content-type-options", "permissions-policy", "location"]
export const cookieName = "__Host-ycoding-preview"
export const bootstrapPath = "/_ycoding/bootstrap"
export const leasePattern = /^\/_r\/([a-f0-9]{16})(\/.*)$/
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/
export const maxRequestBytes = 65_536
export const maxResponseBytes = 1_048_576

export function create(options: Options) {
  if (!Array.isArray(options.origins) || !Array.isArray(options.frameAncestors) || typeof options.authorize !== "function" || typeof options.dispatch !== "function") fail("invalid_configuration")
  const origins = new Set(options.origins.map(validateOrigin))
  const ancestors = [...new Set(options.frameAncestors.map(validateOrigin))]
  const now = options.now ?? Date.now
  const authorize = options.authorize
  const dispatch = options.dispatch
  const registrations = new Map<string, Registration>()
  const bindings = new Map<string, { id: string; generation: string; scope: Scope }>()
  const policy = `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'; worker-src 'none'; frame-ancestors ${ancestors.length ? ancestors.join(" ") : "'none'"}`
  let closed = false

  function invalidate(registration: Registration) {
    if (registration.timer !== undefined) clearTimeout(registration.timer)
    registration.ticketHash = undefined
    registration.cookieHash = undefined
    registration.controller.abort()
  }

  function current(registration: Registration) {
    if (closed || registration.controller.signal.aborted || registrations.get(registration.origin) !== registration) fail("gone")
    if (now() >= registration.expiresAt) {
      invalidate(registration)
      fail("gone")
    }
  }

  async function permitted(registration: Registration, signal: AbortSignal) {
    current(registration)
    const allowed = await abortable(() => authorize({ ...registration.scope }, signal), signal)
    current(registration)
    if (!allowed) {
      invalidate(registration)
      fail("forbidden")
    }
  }

  async function issue(input: IssueInput): Promise<Lease> {
    if (closed) fail("gone")
    if (!origins.size) fail("disabled")
    if (!/^app_[a-f0-9]{32}$/.test(input.id) || !/^generation_[a-f0-9]{32}$/.test(input.generation) || !origins.has(input.origin) || !validScope(input.scope) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now() || input.expiresAt > now() + 900_000) fail("invalid_lease")
    validatePath(input.entryPath, "invalid_lease")
    const binding = bindings.get(input.origin)
    if (binding && (binding.id !== input.id || binding.generation !== input.generation || !scopeKeys.every((key) => binding.scope[key] === input.scope[key]))) fail("origin_bound")
    const scope = Object.freeze({ ...input.scope })
    bindings.set(input.origin, { id: input.id, generation: input.generation, scope })
    const previous = registrations.get(input.origin)
    if (previous) invalidate(previous)
    const registration: Registration = { id: input.id, generation: input.generation, scope, origin: input.origin, entryPath: input.entryPath, expiresAt: input.expiresAt, tag: leaseTag(), controller: new AbortController() }
    registrations.set(input.origin, registration)
    registration.timer = setTimeout(() => invalidate(registration), Math.max(0, registration.expiresAt - now()))
    try {
      const ticket = token()
      registration.ticketHash = await hash(ticket)
      current(registration)
      return { url: `${registration.origin}${bootstrapPath}?ticket=${ticket}`, origin: registration.origin, expiresAt: registration.expiresAt, tag: registration.tag }
    } catch (error) {
      invalidate(registration)
      throw error instanceof Failure ? error : new Failure("upstream_unavailable")
    }
  }

  function revoke(input: { id: string; generation: string }) {
    for (const registration of registrations.values()) {
      if (registration.id === input.id && registration.generation === input.generation) invalidate(registration)
    }
  }

  function close() {
    closed = true
    for (const registration of registrations.values()) invalidate(registration)
  }

  async function fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      const registration = registrations.get(url.origin)
      if (!registration) fail("not_found")
      current(registration)
      if (request.headers.has("upgrade") || connectionTokens(request.headers).has("upgrade")) fail("upgrade_unsupported")
      const connection = connectSignals(request.signal, registration.controller.signal)
      try {
        if (url.pathname === bootstrapPath) {
          if (request.method !== "GET") fail("method_unsupported")
          const ticket = url.searchParams.get("ticket")
          if ([...url.searchParams.keys()].length !== 1 || ticket === null || !tokenPattern.test(ticket)) fail("unauthorized")
          const digest = await hash(ticket)
          current(registration)
          if (!sameHash(registration.ticketHash, digest)) fail("unauthorized")
          registration.ticketHash = undefined
          await permitted(registration, connection.signal)
          const credential = token()
          registration.cookieHash = await hash(credential)
          current(registration)
          return new Response(null, { status: 303, headers: {
            location: `/_r/${registration.tag}${registration.entryPath}`,
            "set-cookie": `${cookieName}=${credential}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${Math.max(0, Math.floor((registration.expiresAt - now()) / 1000))}`,
            "cache-control": "no-store, no-transform",
            "referrer-policy": "no-referrer",
          } })
        }
        const prefixed = leasePattern.exec(url.pathname)
        if (!prefixed) fail("not_found")
        if (prefixed[1] !== registration.tag) fail("gone")
        const path = validatePath(prefixed[2]! + url.search, "not_found")
        const credential = readCookie(request.headers)
        if (!credential || !sameHash(registration.cookieHash, await hash(credential))) fail("unauthorized")
        current(registration)
        if (!methods.includes(request.method)) fail("method_unsupported")
        if (request.method !== "GET" && request.method !== "HEAD" && request.headers.get("origin") !== registration.origin) fail("forbidden")
        await permitted(registration, connection.signal)
        const body = await readBody(request, connection.signal)
        current(registration)
        const forwarded = forwardHeaders(request.headers, requestHeaders)
        if (forwarded.origin !== registration.origin) delete forwarded.origin
        const scopeURL = `${registration.origin}/_r/${registration.tag}/`
        if (forwarded.referer?.startsWith(scopeURL)) forwarded.referer = `${registration.origin}/${forwarded.referer.slice(scopeURL.length)}`
        else delete forwarded.referer
        const result = await abortable(() => dispatch({
          id: registration.id,
          generation: registration.generation,
          scope: { ...registration.scope },
          method: request.method as Method,
          path,
          headers: forwarded,
          ...(body === undefined ? {} : { body }),
          signal: connection.signal,
        }), connection.signal)
        await permitted(registration, connection.signal)
        if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || !(result.body instanceof Uint8Array) || result.body.byteLength > maxResponseBytes) fail("upstream_unavailable")
        const upstream = new Headers()
        for (const [key, value] of Object.entries(result.headers)) {
          if (typeof value === "string") upstream.append(key, value)
          else for (const part of value) upstream.append(key, part)
        }
        if (upstream.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream") fail("upstream_unavailable")
        const hopHeaders = connectionTokens(upstream)
        if (["content-security-policy", "content-security-policy-report-only", "x-frame-options"].some((name) => hopHeaders.has(name))) fail("upstream_unavailable")
        const location = upstream.get("location")
        if (location !== null) validatePath(location, "upstream_unavailable")
        const headers = new Headers(forwardHeaders(upstream, responseHeaders))
        if (location !== null) headers.set("location", `/_r/${registration.tag}${location}`)
        headers.append("content-security-policy", policy)
        headers.set("cache-control", "no-store, no-transform")
        headers.set("referrer-policy", "no-referrer")
        headers.set("x-content-type-options", "nosniff")
        const noBody = request.method === "HEAD" || [204, 205, 304].includes(result.status)
        const length = upstream.get("content-length")
        if (request.method === "HEAD" && ![204, 205].includes(result.status) && !upstream.has("content-encoding") && length !== null && /^(0|[1-9][0-9]*)$/.test(length) && Number.isSafeInteger(Number(length)))
          headers.set("content-length", length)
        else if (![204, 205, 304].includes(result.status) && (request.method !== "HEAD" || result.body.byteLength > 0))
          headers.set("content-length", String(result.body.byteLength))
        return new Response(noBody ? null : new Uint8Array(result.body), { status: result.status, headers })
      } finally {
        connection.dispose()
      }
    } catch (error) {
      const category = error instanceof Failure ? error.category : "upstream_unavailable"
      return new Response(category, { status: status(category), headers: { "cache-control": "no-store, no-transform", "referrer-policy": "no-referrer", "content-type": "text/plain; charset=utf-8" } })
    }
  }

  return { issue, fetch, revoke, close }
}

export function allowedPath(value: string): boolean {
  try {
    validatePath(value, "not_found")
    return true
  } catch { return false }
}

function fail(category: Category): never { throw new Failure(category) }

function validateOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (url.origin !== value || value.includes("*") || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) fail("invalid_configuration")
    return value
  } catch { return fail("invalid_configuration") }
}

function validScope(scope: Scope): boolean {
  return typeof scope === "object" && scope !== null && Object.keys(scope).length === scopeKeys.length && scopeKeys.every((key) => {
    const value = scope[key]
    return typeof value === "string" && (key === "clientID" ? value.length > 0 && value.length <= 2048 && !/[\r\n\0]/.test(value) : /^[A-Za-z0-9_-]{1,256}$/.test(value))
  })
}

function validatePath(value: string, category: Category): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 4096 || !value.startsWith("/") || /[\x00-\x20\x7f\\#]/.test(value)) fail(category)
  let decoded = value
  for (let layer = 0; layer < 16; layer++) {
    const path = decoded.split("?")[0]!
    if (path.startsWith("//") || path === "/_ycoding" || path.startsWith("/_ycoding/") || path.split("/").some((part) => part === "." || part === "..") || /[\x00-\x1f\x7f-\x9f\\#]/.test(decoded) || /%(?:2f|5c|3f|23)/i.test(path) || /%(?![a-f0-9]{2})/i.test(decoded)) fail(category)
    const url = new URL(decoded, "https://preview.invalid")
    if ([...url.searchParams.keys()].some((key) => key.toLowerCase() === "ticket" || key.toLowerCase() === cookieName.toLowerCase())) fail(category)
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) return value
      decoded = next
    } catch { return fail(category) }
  }
  return fail(category)
}

function leaseTag(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function token(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

async function hash(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
}

function sameHash(left: Uint8Array | undefined, right: Uint8Array): boolean {
  if (left === undefined || left.length !== right.length) return false
  let mismatch = 0
  for (let index = 0; index < right.length; index++) mismatch |= left[index]! ^ right[index]!
  return mismatch === 0
}

function readCookie(headers: Headers): string | undefined {
  const values = (headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`))
  if (values.length !== 1) return undefined
  const value = values[0]!.slice(cookieName.length + 1)
  return tokenPattern.test(value) ? value : undefined
}

function connectionTokens(headers: Headers): Set<string> {
  return new Set((headers.get("connection") ?? "").toLowerCase().split(",").map((part) => part.trim()))
}

function forwardHeaders(headers: Headers, allowed: readonly string[]): Record<string, string> {
  const excluded = connectionTokens(headers)
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = excluded.has(key) ? null : headers.get(key)
    return value === null ? [] : [[key, value]]
  }))
}

function connectSignals(...signals: AbortSignal[]) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const signal of signals) {
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) controller.abort()
  }
  return { signal: controller.signal, dispose: () => { for (const signal of signals) signal.removeEventListener("abort", abort) } }
}

function abortable<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Failure("gone"))
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) {
      signal.removeEventListener("abort", abort)
      abort()
      return
    }
    Promise.resolve().then(run).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

async function readBody(request: Request, signal: AbortSignal): Promise<Uint8Array | undefined> {
  if (!request.body) return undefined
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    if (Number(request.headers.get("content-length")) > maxRequestBytes) fail("too_large")
    while (true) {
      const item = await abortable(() => reader.read(), signal)
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > maxRequestBytes) fail("too_large")
      chunks.push(item.value)
    }
    const output = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
    return output
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
}

function status(category: Category): number {
  switch (category) {
    case "unauthorized": return 401
    case "forbidden": return 403
    case "not_found": return 404
    case "gone": return 410
    case "too_large": return 413
    case "upgrade_unsupported": return 426
    case "method_unsupported": return 405
    case "upstream_unavailable": return 502
    default: return 503
  }
}
