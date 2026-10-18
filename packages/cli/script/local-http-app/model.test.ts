import { expect, test } from "bun:test"
import { parsePreviewPolicy, validatePreview } from "./model.js"

const origin = "https://preview.example.test"
const policy = [origin]
const ticket = "fixture_token_0123456789"
const lease = { kind: "local-http-app", version: 1, appID: "app_fixture", sessionID: "ses_fixture", expiresAt: "2099-01-01T00:00:00.000Z", status: "ready" }
const result = (url = `${origin}/_ycoding/bootstrap?ticket=${ticket}`) => ({ structuredContent: lease, _meta: { localApp: { url, origin } } })

test("policy accepts exact HTTPS origins and explicit loopback HTTP fixtures only", () => {
  expect(parsePreviewPolicy(JSON.stringify([origin, "http://127.0.0.1:8123", "http://localhost:8124"]))).toEqual([origin, "http://127.0.0.1:8123", "http://localhost:8124"])
  for (const value of ["null", "{}", "invalid", '["*"]', '["https://*.example.test"]', '["//example.test"]', '["http://example.test"]', '["https://preview.example.test/"]', '["https://user@preview.example.test"]', '["https://preview.example.test#x"]'])
    expect(parsePreviewPolicy(value)).toEqual([])
})

test("ready envelopes admit only hidden bootstrap URLs and explicit policy", () => {
  expect(validatePreview(result(), policy)).toHaveProperty("url", result()._meta.localApp.url)
  expect(validatePreview(result(), [])).toBeUndefined()
  expect(validatePreview({ structuredContent: lease }, policy)).not.toHaveProperty("url")
  for (const url of ["//preview.example.test/_ycoding/bootstrap?ticket=x", `${origin}/?ticket=${ticket}`, `${origin}/_ycoding/bootstrap?ticket=${ticket}#x`, `${origin}/_ycoding/bootstrap?ticket=${ticket}&x=1`, `${origin}/_ycoding/bootstrap?ticket=${ticket}&ticket=x`, `${origin}/_ycoding/bootstrap?ticket=`, `${origin}/_ycoding/bootstrap?ticket=${"a".repeat(2049)}`, `https://user:pass@preview.example.test/_ycoding/bootstrap?ticket=${ticket}`, `https://child.preview.example.test/_ycoding/bootstrap?ticket=${ticket}`, `${origin}/_ycoding/bootstrap?ticket=a%20b`])
    expect(validatePreview(result(url), policy)).toBeUndefined()
  expect(validatePreview({ ...result(), _meta: { localApp: { ...result()._meta.localApp, origin: "https://other.example.test" } } }, policy)).toBeUndefined()
})

test("DTO rejects malformed states, leaked fields, errors, identities, and expiry", () => {
  for (const override of [{ kind: "agent-eval-dashboard" }, { version: 2 }, { status: "success" }, { sessionID: "" }, { appID: null }, { expiresAt: "tomorrow" }, { expiresAt: "2026-02-30T00:00:00.000Z" }, { url: "secret" }, { ticket }, { reason: "unknown" }])
    expect(validatePreview({ structuredContent: { ...lease, ...override } }, policy)).toBeUndefined()
  expect(validatePreview({ ...result(), isError: true }, policy)).toBeUndefined()
  expect(validatePreview({ structuredContent: { ...lease, expiresAt: "2000-01-01T00:00:00.000Z" } }, policy)?.status).toBe("expired")
  for (const status of ["unavailable", "expired", "revoked"])
    expect(validatePreview({ structuredContent: { ...lease, status } }, policy)?.status).toBe(status)
})

test("HTTP bootstrap is permitted only for an exactly injected loopback origin", () => {
  const local = "http://127.0.0.1:8123"
  const payload = { structuredContent: lease, _meta: { localApp: { origin: local, url: `${local}/_ycoding/bootstrap?ticket=${ticket}` } } }
  expect(validatePreview(payload, [local])).toHaveProperty("url", payload._meta.localApp.url)
  expect(validatePreview(payload, ["http://localhost:8123"])).toBeUndefined()
})

test("unknown unavailable leases have no expiry; other states require an ISO expiry", () => {
  expect(validatePreview({ structuredContent: { ...lease, status: "unavailable", reason: "not_registered", expiresAt: null } }, policy)).toEqual({ appID: lease.appID, sessionID: lease.sessionID, status: "unavailable", expiresAt: null })
  for (const status of ["ready", "expired", "revoked"])
    expect(validatePreview({ structuredContent: { ...lease, status, expiresAt: null } }, policy)).toBeUndefined()
})
