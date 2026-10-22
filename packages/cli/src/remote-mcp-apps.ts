export * as RemoteMcpApps from "./remote-mcp-apps"

import type { McpEvents } from "@ycoding-ai/schema/mcp-events"
import previewHTML from "../script/local-http-app/index.html" with { type: "text" }
import { RemoteLocalApp } from "./remote-local-app"

export const previewURI = "ui://ycoding/local-http-app/v1.html"
export type Operation = "local.app.register" | "local.app.list" | "local.app.revoke" | "local.app.open" | "local.app.status" | "local.app.http"
export type Reason = "preview_unconfigured" | "not_registered" | "access_unavailable" | "expired" | "revoked"
export type View = { kind: "local-http-app"; version: 1; appID: string; sessionID: string; expiresAt: string | null; status: "ready" | "unavailable" | "expired" | "revoked"; reason?: Reason }
export type Result = { value: unknown; metadata?: { localApp: { url: string; origin: string } } }
export type Preview = {
  origins: () => readonly string[]
  issue: (input: { registration: RemoteLocalApp.Registration; scope: RemoteLocalApp.Scope; signal: AbortSignal }) => Promise<{ url: string; origin: string; expiresAt: number }>
  revoke: (input: { id: string; generation: string }) => void
  clear: () => void
}
export type Options = {
  registry: ReturnType<typeof RemoteLocalApp.create>
  resolve: (context: McpEvents.RequestContext, signal: AbortSignal) => Promise<McpEvents.Principal>
  preview?: Preview
  html?: string
  now?: () => number
}
export type FailureReason = Reason | "invalid_params" | "too_large" | "busy" | "unsupported_stream" | "upstream_unavailable" | "redirect_rejected" | "preview_exhausted" | "rate_limited" | "authorization_unavailable"
export class Error extends globalThis.Error {
  override readonly name = "RemoteMcpAppsError"
  readonly reason: FailureReason
  constructor(reason: FailureReason) { super(reason); this.reason = reason }
}

type RegistrationInput = Omit<RemoteLocalApp.Input, "sessionID">
type Parsed =
  | { operation: "local.app.register"; sessionID: string; input: RegistrationInput }
  | { operation: "local.app.list"; sessionID: string }
  | { operation: "local.app.revoke"; sessionID: string; input: { id: string } }
  | { operation: "local.app.status"; sessionID: string; input: { id: string } }
  | { operation: "local.app.open"; sessionID: string; input: { id: string; generation: string } }
  | { operation: "local.app.http"; sessionID: string; input: { id: string; generation: string; method: RemoteLocalApp.Method; path: string; headers?: Record<string, string>; body?: string } }
type Lease = { registration: RemoteLocalApp.Registration; scope: RemoteLocalApp.Scope; expiresAt?: number; revoked: boolean }

const policy = '<script id="preview-policy" type="application/json">[]</script>'
const identityKeys = ["ownerID", "deviceID", "clientID", "grantID", "epoch"] as const
const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const
const appPattern = "^app_[a-f0-9]{32}$"
const generationPattern = "^generation_[a-f0-9]{32}$"
const sessionPattern = "^ses[A-Za-z0-9_-]+$"
const base64Pattern = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
const text = (maxLength: number, pattern?: string) => ({ type: "string", minLength: 1, maxLength, ...(pattern ? { pattern } : {}) })
const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: "object" as const, properties, required, additionalProperties: false })
const idSchema = text(36, appPattern)
const generationSchema = text(43, generationPattern)
const routeSchema = object({ path: text(4096), match: { enum: ["exact", "prefix"] }, methods: { type: "array", items: { enum: methods }, minItems: 1, maxItems: 7 } })
const inputs: Record<Exclude<Operation, "local.app.list">, ReturnType<typeof object>> = {
  "local.app.register": object({ host: { enum: ["127.0.0.1", "[::1]"] }, port: { type: "integer", minimum: 1, maximum: 65535 }, entryPath: text(4096), routes: { type: "array", items: routeSchema, minItems: 1, maxItems: 64 }, ttlMs: { type: "integer", minimum: 1, maximum: 3_600_000 } }, ["host", "port", "entryPath", "routes"]),
  "local.app.revoke": object({ id: idSchema }),
  "local.app.open": object({ id: idSchema, generation: generationSchema }),
  "local.app.status": object({ id: idSchema }),
  "local.app.http": object({ id: idSchema, generation: generationSchema, method: { enum: methods }, path: text(4096), headers: { type: "object", maxProperties: 64, propertyNames: text(128, "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$"), additionalProperties: { type: "string", maxLength: 8192 } }, body: { type: "string", maxLength: 87384, pattern: base64Pattern } }, ["id", "generation", "method", "path"]),
}
const descriptions: Record<Operation, string> = {
  "local.app.register": "Register an explicit Session-owned loopback HTTP app with bounded routes and methods. Registration does not open a preview.",
  "local.app.list": "List safe registration metadata for this Session and authorized client scope.",
  "local.app.revoke": "Revoke a registered local HTTP app and abort its active requests.",
  "local.app.open": "Open a registered HTTP app when a trusted preview issuer is configured. Preview access stays in private UI metadata.",
  "local.app.status": "Read a local HTTP app lease without creating or extending preview access.",
  "local.app.http": "Send one bounded HTTP request to a registered app's permitted route and method. Binary request and response bodies use base64.",
}
export const tools = (Object.keys(descriptions) as Operation[]).map((operation) => ({
  name: operation.replaceAll(".", "_"), operation, description: descriptions[operation],
  inputSchema: object({ sessionID: text(128, sessionPattern), ...(operation === "local.app.list" ? {} : { input: inputs[operation] }) }),
  annotations: { readOnlyHint: operation === "local.app.list" || operation === "local.app.status", destructiveHint: operation === "local.app.revoke" || operation === "local.app.http", idempotentHint: operation === "local.app.list" || operation === "local.app.status" || operation === "local.app.revoke", openWorldHint: false as const },
  ...(operation === "local.app.open" ? { _meta: { ui: { resourceUri: previewURI } } } : {}),
}))

function fail(reason: FailureReason): never { throw new Error(reason) }

export function create(options: Options) {
  const now = options.now ?? Date.now
  const leases = new Map<string, Lease>()
  let lifecycle = new AbortController()
  let closed = false

  function remember(registration: RemoteLocalApp.Registration, scope: RemoteLocalApp.Scope): Lease {
    const prior = leases.get(registration.id)
    if (prior) {
      if (!sameScope(prior.scope, scope)) fail("access_unavailable")
      return prior
    }
    if (leases.size >= 64) {
      const settled = [...leases].find(([, lease]) => lease.revoked || (lease.expiresAt ?? lease.registration.expiresAt) <= now())
      if (!settled) fail("busy")
      leases.delete(settled[0])
    }
    const lease = { registration: structuredClone(registration), scope: { ...scope }, revoked: false }
    leases.set(registration.id, lease)
    return lease
  }

  function inspect(id: string, scope: RemoteLocalApp.Scope) {
    const lease = leases.get(id)
    if (lease && !sameScope(lease.scope, scope)) return { view: view(id, scope.sessionID, null, "access_unavailable") }
    const registration = options.registry.list(owner(scope)).find((app) => app.id === id)
    const expiry = lease?.expiresAt ?? registration?.expiresAt ?? lease?.registration.expiresAt ?? null
    if (!registration || lease?.revoked) {
      const reason = lease ? expiry !== null && expiry <= now() && !lease.revoked ? "expired" : "revoked" : "not_registered"
      if (lease && reason === "revoked") lease.revoked = true
      return { view: view(id, scope.sessionID, expiry, reason) }
    }
    if (expiry !== null && expiry <= now()) return { registration, view: view(id, scope.sessionID, expiry, "expired") }
    if (!options.preview) return { registration, view: view(id, scope.sessionID, expiry, "preview_unconfigured") }
    return { registration, view: view(id, scope.sessionID, expiry, lease?.expiresAt ? undefined : "access_unavailable") }
  }

  async function fresh(context: McpEvents.RequestContext, signal: AbortSignal, sessionID: string, prior?: RemoteLocalApp.Scope) {
    const principal = await abortable(() => options.resolve(structuredClone(context), signal), signal)
    if (!validPrincipal(principal) || principal.ownerID !== context.principal.ownerID || principal.deviceID !== context.principal.deviceID || principal.clientID !== context.principal.clientID || principal.epoch !== context.epoch) fail("access_unavailable")
    const scope = { ...principal, sessionID }
    if (prior && !sameScope(prior, scope)) fail("access_unavailable")
    return scope
  }

  async function execute(operation: Operation, raw: unknown, context: McpEvents.RequestContext, inputSignal: AbortSignal): Promise<Result> {
    const args = parse(operation, raw)
    if (closed || !validContext(context) || !(inputSignal instanceof AbortSignal)) fail("access_unavailable")
    const signal = AbortSignal.any([inputSignal, lifecycle.signal])
    const ctx = structuredClone(context)
    try {
      const scope = await fresh(ctx, signal, args.sessionID)
      if (args.operation === "local.app.register") {
        const registration = await abortable(() => options.registry.register({ ...args.input, sessionID: args.sessionID }, owner(scope)).then((registration) => {
          if (signal.aborted) {
            options.registry.revoke({ id: registration.id, owner: owner(scope) })
            fail("access_unavailable")
          }
          return registration
        }), signal)
        try {
          await fresh(ctx, signal, args.sessionID, scope)
          if (!options.registry.list(owner(scope)).some((app) => app.id === registration.id)) fail("not_registered")
          remember(registration, scope)
          return { value: registration }
        } catch (error) {
          if (options.registry.list(owner(scope)).some((app) => app.id === registration.id)) options.registry.revoke({ id: registration.id, owner: owner(scope) })
          throw error
        }
      }
      if (args.operation === "local.app.list") return { value: options.registry.list(owner(scope)).filter((app) => !leases.has(app.id) || sameScope(leases.get(app.id)!.scope, scope)) }
      const current = inspect(args.input.id, scope)
      if (args.operation === "local.app.status") return { value: current.view }
      if (!current.registration) {
        if (args.operation === "local.app.open") return { value: current.view }
        return fail(current.view.reason ?? "not_registered")
      }
      if (args.operation === "local.app.revoke") {
        const lease = remember(current.registration, scope)
        options.registry.revoke({ id: args.input.id, owner: owner(scope) })
        options.preview?.revoke({ id: args.input.id, generation: current.registration.generation })
        lease.revoked = true
        return { value: view(args.input.id, scope.sessionID, lease.expiresAt ?? lease.registration.expiresAt, "revoked") }
      }
      if (args.input.generation !== current.registration.generation) fail("access_unavailable")
      if (args.operation === "local.app.open") {
        if (!options.preview || approvedOrigins(options.preview).length === 0) return { value: view(args.input.id, scope.sessionID, current.registration.expiresAt, "preview_unconfigured") }
        const capability = await abortable(() => options.preview!.issue({ registration: structuredClone(current.registration!), scope: { ...scope }, signal }), signal)
        await fresh(ctx, signal, args.sessionID, scope)
        const latest = inspect(args.input.id, scope)
        if (!latest.registration) return { value: latest.view }
        validateCapability(capability, approvedOrigins(options.preview), latest.registration, now())
        const lease = remember(latest.registration, scope)
        options.registry.publish({ id: args.input.id, generation: args.input.generation, owner: owner(scope), scope, previewOrigin: capability.origin })
        lease.expiresAt = capability.expiresAt
        return { value: view(args.input.id, scope.sessionID, lease.expiresAt), metadata: { localApp: { url: capability.url, origin: capability.origin } } }
      }
      remember(current.registration, scope)
      options.registry.publish({ id: args.input.id, generation: args.input.generation, owner: owner(scope), scope })
      const response = await options.registry.dispatch({ id: args.input.id, generation: args.input.generation, scope, method: args.input.method, path: args.input.path, headers: args.input.headers ?? {}, ...(args.input.body === undefined ? {} : { body: new Uint8Array(Buffer.from(args.input.body, "base64")) }), signal })
      await fresh(ctx, signal, args.sessionID, scope)
      if (!inspect(args.input.id, scope).registration) fail("access_unavailable")
      if (response.body.byteLength > 1_048_576) fail("too_large")
      const value = { status: response.status, headers: response.headers, body: Buffer.from(response.body).toString("base64") }
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2 * 1024 * 1024) fail("too_large")
      return { value }
    } catch (error) {
      if (error instanceof Error) throw error
      if (error instanceof RemoteLocalApp.Error) return fail(engineReason(error.category))
      return fail("access_unavailable")
    }
  }

  function list() { return closed ? [] : [{ uri: previewURI, name: "Local HTTP app", mimeType: "text/html;profile=mcp-app" }] }
  function read(uri: string) {
    if (closed || uri !== previewURI) return undefined
    const origins = options.preview ? approvedOrigins(options.preview) : []
    const html = options.html ?? String(previewHTML)
    if (html.split(policy).length !== 2) fail("access_unavailable")
    const json = JSON.stringify(origins).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    return { contents: [{ uri: previewURI, mimeType: "text/html;profile=mcp-app", text: html.replace(policy, `<script id="preview-policy" type="application/json">${json}</script>`), _meta: { ui: { prefersBorder: true, csp: { frameDomains: origins, connectDomains: [], resourceDomains: [] } } } }] }
  }
  function clear() {
    lifecycle.abort()
    lifecycle = new AbortController()
    options.registry.clear()
    options.preview?.clear()
    for (const lease of leases.values()) lease.revoked = true
  }
  function close() {
    clear()
    closed = true
    options.registry.close()
    leases.clear()
  }
  return { execute, list, read, clear, close }
}

function view(appID: string, sessionID: string, expiresAt: number | null, reason?: Reason): View {
  return { kind: "local-http-app", version: 1, appID, sessionID, expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(), status: reason === "expired" || reason === "revoked" ? reason : reason ? "unavailable" : "ready", ...(reason ? { reason } : {}) }
}
function owner(scope: RemoteLocalApp.Scope): RemoteLocalApp.Owner { return { ownerID: scope.ownerID, deviceID: scope.deviceID, sessionID: scope.sessionID } }
function sameScope(left: RemoteLocalApp.Scope, right: RemoteLocalApp.Scope) { return left.sessionID === right.sessionID && identityKeys.every((key) => left[key] === right[key]) }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function exact(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): value is Record<string, unknown> { return record(value) && Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => key in value) }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value) }
function isMethod(value: unknown): value is RemoteLocalApp.Method { return methods.some((method) => method === value) }
function validHeaders(value: unknown): value is Record<string, string> {
  return record(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, field]) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key) && typeof field === "string" && field.length <= 8192 && !/[\0\r\n]/.test(field))
}
function validPrincipal(value: unknown): value is McpEvents.Principal {
  return exact(value, identityKeys) && [value.ownerID, value.deviceID, value.grantID, value.epoch].every(identifier) && typeof value.clientID === "string" && value.clientID.length > 0 && value.clientID.length <= 2048 && !/[\r\n\0]/.test(value.clientID)
}
function validContext(value: unknown): value is McpEvents.RequestContext {
  return exact(value, ["requestID", "principal", "epoch"]) && identifier(value.requestID) && identifier(value.epoch) && exact(value.principal, ["ownerID", "deviceID", "clientID"]) && validPrincipal({ ...value.principal, epoch: value.epoch, grantID: "validation" })
}
function boundedPath(value: unknown): value is string { return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(value) && new TextEncoder().encode(value).byteLength <= 4096 }
function validRegistration(value: unknown): value is RegistrationInput {
  return exact(value, ["host", "port", "entryPath", "routes", "ttlMs"], ["host", "port", "entryPath", "routes"]) && (value.host === "127.0.0.1" || value.host === "[::1]") && typeof value.port === "number" && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535 && boundedPath(value.entryPath) && (value.ttlMs === undefined || typeof value.ttlMs === "number" && Number.isInteger(value.ttlMs) && value.ttlMs > 0 && value.ttlMs <= 3_600_000) && Array.isArray(value.routes) && value.routes.length > 0 && value.routes.length <= 64 && value.routes.every((route) => exact(route, ["path", "match", "methods"]) && boundedPath(route.path) && !/[?*]/.test(route.path) && (route.match === "exact" || route.match === "prefix") && Array.isArray(route.methods) && route.methods.length > 0 && route.methods.length <= 7 && route.methods.every(isMethod))
}
function parse(operation: Operation, raw: unknown): Parsed {
  if (!Object.hasOwn(descriptions, operation) || !exact(raw, operation === "local.app.list" ? ["sessionID"] : ["sessionID", "input"]) || typeof raw.sessionID !== "string" || raw.sessionID.length > 128 || !new RegExp(sessionPattern).test(raw.sessionID)) fail("invalid_params")
  try { if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 128 * 1024) fail("invalid_params") }
  catch { return fail("invalid_params") }
  const sessionID = raw.sessionID
  if (operation === "local.app.list") return { operation, sessionID }
  const input = raw.input
  if (operation === "local.app.register") {
    if (!validRegistration(input)) fail("invalid_params")
    return { operation, sessionID, input: structuredClone(input) }
  }
  const fields = operation === "local.app.http" ? ["id", "generation", "method", "path", "headers", "body"] : operation === "local.app.open" ? ["id", "generation"] : ["id"]
  const required = operation === "local.app.http" ? ["id", "generation", "method", "path"] : fields
  if (!exact(input, fields, required) || typeof input.id !== "string" || !new RegExp(appPattern).test(input.id)) fail("invalid_params")
  if (operation === "local.app.revoke") return { operation, sessionID, input: { id: input.id } }
  if (operation === "local.app.status") return { operation, sessionID, input: { id: input.id } }
  if (typeof input.generation !== "string" || !new RegExp(generationPattern).test(input.generation)) fail("invalid_params")
  if (operation === "local.app.open") return { operation, sessionID, input: { id: input.id, generation: input.generation } }
  if (!isMethod(input.method) || !boundedPath(input.path)) fail("invalid_params")
  if (input.headers !== undefined && !validHeaders(input.headers)) fail("invalid_params")
  if (input.body !== undefined && (typeof input.body !== "string" || input.body.length > 87384 || !new RegExp(base64Pattern).test(input.body) || Buffer.from(input.body, "base64").byteLength > 65_536 || Buffer.from(input.body, "base64").toString("base64") !== input.body)) fail("invalid_params")
  return { operation, sessionID, input: { id: input.id, generation: input.generation, method: input.method, path: input.path, ...(input.headers === undefined ? {} : { headers: structuredClone(input.headers) }), ...(typeof input.body === "string" ? { body: input.body } : {}) } }
}

function approvedOrigins(preview: Preview): string[] {
  try {
    const origins = preview.origins()
    if (!Array.isArray(origins) || origins.length > 64) fail("access_unavailable")
    return origins.map((origin) => {
      if (typeof origin !== "string" || origin.length > 2048) fail("access_unavailable")
      const url = new URL(origin)
      if (url.origin !== origin || url.hostname.includes("*") || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) fail("access_unavailable")
      return origin
    })
  } catch { return fail("access_unavailable") }
}
function validateCapability(value: unknown, origins: string[], registration: RemoteLocalApp.Registration, now: number): asserts value is { url: string; origin: string; expiresAt: number } {
  try {
    if (!exact(value, ["url", "origin", "expiresAt"]) || typeof value.url !== "string" || value.url.length > 4096 || /[\x00-\x20\x7f\\#]/.test(value.url) || /%(?![\da-f]{2})/i.test(value.url) || typeof value.origin !== "string" || !origins.includes(value.origin) || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > registration.expiresAt) fail("access_unavailable")
    const url = new URL(value.url)
    const entries = [...url.searchParams]
    const entry = entries[0]
    if (url.origin !== value.origin || url.username || url.password || url.hash || url.pathname !== "/_ycoding/bootstrap" || !value.url.startsWith(`${value.origin}/_ycoding/bootstrap?ticket=`) || entries.length !== 1 || !entry || entry[0] !== "ticket" || !entry[1].trim() || entry[1].length > 512 || /[\x00-\x1f\x7f]/.test(entry[1])) fail("access_unavailable")
  } catch { fail("access_unavailable") }
}
function engineReason(category: RemoteLocalApp.Category): FailureReason {
  if (category === "invalid_registration") return "invalid_params"
  if (category === "forbidden") return "access_unavailable"
  if (category === "not_found") return "not_registered"
  return category
}
function abortable<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("access_unavailable"))
    if (signal.aborted) { abort(); return }
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => { if (signal.aborted) fail("access_unavailable"); return run() }).then((value) => { if (signal.aborted) abort(); else resolve(value) }, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
