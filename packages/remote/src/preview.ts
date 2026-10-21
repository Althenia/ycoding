import { RemoteLimits, isWellFormedBase64 } from "./index.ts"
import { cookieName, maxResponseBytes, requestHeaders, tokenPattern } from "./app-preview.ts"

export const previewOperation = "preview.http"
export const previewRequestHeaders: readonly string[] = [...requestHeaders, "cookie"]
export const maxPreviewLeases = 64
export const maxPreviewOrigins = 64
export const maxPreviewHeaderChars = 2048
export const maxRegistrationMs = 3_600_000
export const leaseTagPattern = /^[a-f0-9]{16}$/
export type PreviewMethod = "GET" | "HEAD"
export type PreviewState = { readonly type: "preview.state"; readonly id: string; readonly origins: readonly string[] }
export type PreviewStateAck = { readonly type: "preview.state.ack"; readonly id: string; readonly enabled: boolean }
export type PreviewAllocate = { readonly type: "preview.allocate"; readonly id: string; readonly registration: string; readonly expiresAt: number }
export type PreviewAllocateAck =
  | { readonly type: "preview.allocate.ack"; readonly id: string; readonly origin: string }
  | { readonly type: "preview.allocate.ack"; readonly id: string; readonly reason: "exhausted" | "rejected" }
export type PreviewLease = { readonly type: "preview.lease"; readonly id: string; readonly origin: string; readonly ticketHash: string; readonly leaseTag: string; readonly registration: string; readonly expiresAt: number }
export type PreviewLeaseAck = { readonly type: "preview.lease.ack"; readonly id: string; readonly ok: boolean }
export type PreviewRevoke = { readonly type: "preview.revoke"; readonly ticketHash?: string; readonly registration?: string }
export type PreviewInput = { readonly origin: string; readonly method: PreviewMethod; readonly path: string; readonly headers: Readonly<Record<string, string>> }
export type PreviewRequest = { readonly type: "request"; readonly id: string; readonly operation: typeof previewOperation; readonly input: PreviewInput }
export type PreviewResult = { readonly status: number; readonly headers: readonly (readonly [string, string])[]; readonly body: string }

const hashPattern = /^[a-f0-9]{64}$/
const headerName = /^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/

export function parsePreviewState(raw: string): PreviewState | undefined {
  const value = decode(raw)
  if (!record(value) || !keys(value, ["type", "id", "origins"]) || value.type !== "preview.state" || !identifier(value.id)) return undefined
  const origins = previewOriginList(value.origins)
  return origins === undefined || origins.length === 0 ? undefined : { type: "preview.state", id: value.id, origins }
}

export function parsePreviewStateAck(raw: string): PreviewStateAck | undefined {
  const value = decode(raw)
  return record(value) && keys(value, ["type", "id", "enabled"]) && value.type === "preview.state.ack" && identifier(value.id) && typeof value.enabled === "boolean"
    ? { type: "preview.state.ack", id: value.id, enabled: value.enabled }
    : undefined
}

export function parsePreviewAllocate(raw: string): PreviewAllocate | undefined {
  const value = decode(raw)
  return record(value) && keys(value, ["type", "id", "registration", "expiresAt"]) && value.type === "preview.allocate" && identifier(value.id) &&
    typeof value.registration === "string" && hashPattern.test(value.registration) && typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0
    ? { type: "preview.allocate", id: value.id, registration: value.registration, expiresAt: value.expiresAt }
    : undefined
}

export function parsePreviewAllocateAck(raw: string): PreviewAllocateAck | undefined {
  const value = decode(raw)
  if (!record(value) || value.type !== "preview.allocate.ack" || !identifier(value.id)) return undefined
  if (keys(value, ["type", "id", "origin"]) && isPreviewOrigin(value.origin)) return { type: "preview.allocate.ack", id: value.id, origin: value.origin }
  if (keys(value, ["type", "id", "reason"]) && (value.reason === "exhausted" || value.reason === "rejected")) return { type: "preview.allocate.ack", id: value.id, reason: value.reason }
  return undefined
}

export function parsePreviewLease(raw: string): PreviewLease | undefined {
  const value = decode(raw)
  return record(value) && keys(value, ["type", "id", "origin", "ticketHash", "leaseTag", "registration", "expiresAt"]) && value.type === "preview.lease" && identifier(value.id) &&
    isPreviewOrigin(value.origin) && typeof value.ticketHash === "string" && hashPattern.test(value.ticketHash) &&
    typeof value.leaseTag === "string" && leaseTagPattern.test(value.leaseTag) && typeof value.registration === "string" && hashPattern.test(value.registration) &&
    typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0
    ? { type: "preview.lease", id: value.id, origin: value.origin, ticketHash: value.ticketHash, leaseTag: value.leaseTag, registration: value.registration, expiresAt: value.expiresAt }
    : undefined
}

export function parsePreviewLeaseAck(raw: string): PreviewLeaseAck | undefined {
  const value = decode(raw)
  return record(value) && keys(value, ["type", "id", "ok"]) && value.type === "preview.lease.ack" && identifier(value.id) && typeof value.ok === "boolean"
    ? { type: "preview.lease.ack", id: value.id, ok: value.ok }
    : undefined
}

export function parsePreviewRevoke(raw: string): PreviewRevoke | undefined {
  const value = decode(raw)
  if (!record(value) || !keys(value, ["type", "ticketHash", "registration"]) || value.type !== "preview.revoke") return undefined
  if (value.ticketHash !== undefined && value.registration !== undefined) return undefined
  if (value.ticketHash !== undefined) return typeof value.ticketHash === "string" && hashPattern.test(value.ticketHash) ? { type: "preview.revoke", ticketHash: value.ticketHash } : undefined
  if (value.registration !== undefined) return typeof value.registration === "string" && hashPattern.test(value.registration) ? { type: "preview.revoke", registration: value.registration } : undefined
  return { type: "preview.revoke" }
}

export function parsePreviewRequest(raw: string): PreviewRequest | undefined {
  const value = decode(raw)
  if (!record(value) || !keys(value, ["type", "id", "operation", "input"]) || value.type !== "request" || value.operation !== previewOperation || !identifier(value.id)) return undefined
  const input = parsePreviewInput(value.input)
  return input === undefined ? undefined : { type: "request", id: value.id, operation: previewOperation, input }
}

export function parsePreviewInput(value: unknown): PreviewInput | undefined {
  if (!record(value) || !keys(value, ["origin", "method", "path", "headers"]) || !isPreviewOrigin(value.origin) || (value.method !== "GET" && value.method !== "HEAD")) return undefined
  if (typeof value.path !== "string" || !value.path.startsWith("/") || new TextEncoder().encode(value.path).byteLength > 4096 || /[\x00-\x20\x7f]/.test(value.path)) return undefined
  if (!record(value.headers) || !Object.entries(value.headers).every(([name, field]) => previewRequestHeaders.includes(name) && typeof field === "string" && field.length <= maxPreviewHeaderChars && /^[\t\x20-\x7e]*$/.test(field))) return undefined
  const headers: Record<string, string> = Object.fromEntries(Object.entries(value.headers).map(([name, field]) => [name, String(field)]))
  if (headers.cookie !== undefined && !previewCookie(headers.cookie)) return undefined
  return { origin: value.origin, method: value.method, path: value.path, headers }
}

export function parsePreviewResult(value: unknown): PreviewResult | undefined {
  if (!record(value) || !keys(value, ["status", "headers", "body"]) || typeof value.status !== "number" || !Number.isInteger(value.status) || value.status < 200 || value.status > 599) return undefined
  if (!Array.isArray(value.headers) || value.headers.length > 64 || typeof value.body !== "string" || !isWellFormedBase64(value.body) || value.body.length > Math.ceil(maxResponseBytes / 3) * 4) return undefined
  const headers = value.headers.flatMap((entry): (readonly [string, string])[] => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && headerName.test(entry[0]) &&
    typeof entry[1] === "string" && entry[1].length <= 8192 && !/[\r\n\0]/.test(entry[1]) ? [[entry[0], entry[1]]] : [])
  return headers.length === value.headers.length ? { status: value.status, headers, body: value.body } : undefined
}

export function parsePreviewOrigins(value: string | undefined): readonly string[] {
  const entries = (value ?? "").split(/[\s,]+/).filter((entry) => entry.length > 0)
  return previewOriginList(entries) ?? []
}

export function sameOrigins(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((origin) => right.includes(origin))
}

export function previewCookie(value: string): string | undefined {
  const prefix = `${cookieName}=`
  if (!value.startsWith(prefix)) return undefined
  const token = value.slice(prefix.length)
  return tokenPattern.test(token) ? token : undefined
}

export function isPreviewOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || value.includes("*") || !URL.canParse(value)) return false
  const url = new URL(value)
  return url.origin === value && url.protocol === "https:" && !url.username && !url.password
}

export async function sha256Hex(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function previewOriginList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > maxPreviewOrigins || !value.every(isPreviewOrigin) || new Set(value).size !== value.length) return undefined
  return [...value]
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function decode(raw: string): unknown {
  if (raw.length > RemoteLimits.maxClientMessageChars) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}
