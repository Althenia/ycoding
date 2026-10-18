const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const identity = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f]/.test(value)
const statuses = new Set(["ready", "unavailable", "expired", "revoked"])
const reasons = new Set(["preview_unconfigured", "not_registered", "access_unavailable", "expired", "revoked"])
const fields = new Set(["kind", "version", "appID", "sessionID", "expiresAt", "status", "reason"])

function approvedOrigin(value) {
  if (typeof value !== "string" || value.includes("*") || !URL.canParse(value)) return false
  const url = new URL(value)
  return url.origin === value && !url.username && !url.password && !url.hash && !url.search &&
    (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && !!url.port)
}

export function parsePreviewPolicy(text) {
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) && value.every(approvedOrigin) ? value : []
  } catch {
    return []
  }
}

export function validatePreview(result, policy, now = Date.now()) {
  if (!record(result) || result.isError === true || !record(result.structuredContent)) return
  const value = result.structuredContent
  if (Object.keys(value).some((key) => !fields.has(key)) || value.kind !== "local-http-app" || value.version !== 1 ||
    !identity(value.appID) || !identity(value.sessionID) || !statuses.has(value.status) ||
    value.reason !== undefined && !reasons.has(value.reason)) return
  if (value.expiresAt === null && value.status === "unavailable")
    return { appID: value.appID, sessionID: value.sessionID, expiresAt: null, status: value.status }
  if (typeof value.expiresAt !== "string") return
  const expires = Date.parse(value.expiresAt)
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== value.expiresAt) return
  const status = value.status === "ready" && expires <= now ? "expired" : value.status
  const lease = { appID: value.appID, sessionID: value.sessionID, expiresAt: value.expiresAt, status }
  if (status !== "ready") return lease
  if (!Array.isArray(policy) || policy.length === 0 || !policy.every(approvedOrigin)) return
  if (result._meta === undefined || record(result._meta) && result._meta.localApp === undefined) return lease
  const local = result._meta?.localApp
  if (!record(local) || !approvedOrigin(local.origin) || !policy.includes(local.origin) ||
    typeof local.url !== "string" || local.url.length > 8192 || !URL.canParse(local.url)) return
  const url = new URL(local.url)
  if (!local.url.startsWith(`${local.origin}/_ycoding/bootstrap?`) || url.origin !== local.origin ||
    url.pathname !== "/_ycoding/bootstrap" || url.username || url.password || local.url.includes("#") ||
    [...url.searchParams.keys()].length !== 1 || !url.searchParams.has("ticket") ||
    !/^[A-Za-z0-9_-]{1,2048}$/.test(url.searchParams.get("ticket"))) return
  return { ...lease, url: local.url }
}
