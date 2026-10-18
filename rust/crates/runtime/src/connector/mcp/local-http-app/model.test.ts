import { expect, test } from "bun:test"
import { parsePreviewPolicy, validatePreview } from "./model.js"

const origin = "https://preview.example.test"
const ticket = "fixture_token_0123456789"
const policy = [origin]
const now = Date.parse("2026-10-19T00:00:00.000Z")
const lease = {
  kind: "local-http-app",
  version: 1,
  appID: "app_fixture",
  sessionID: "ses_fixture",
  expiresAt: "2099-01-01T00:00:00.000Z",
  status: "ready",
}
const result = (url = `${origin}/_ycoding/bootstrap?ticket=${ticket}`) => ({
  structuredContent: lease,
  _meta: { localApp: { url, origin } },
})

test("preview policy admits only exact HTTPS origins or explicit loopback fixtures", () => {
  expect(parsePreviewPolicy(JSON.stringify([origin, "http://127.0.0.1:8123", "http://localhost:8124"]))).toEqual([
    origin,
    "http://127.0.0.1:8123",
    "http://localhost:8124",
  ])
  for (const value of [
    "null",
    "{}",
    "invalid",
    '["*"]',
    '["https://*.example.test"]',
    '["//example.test"]',
    '["http://example.test"]',
    '["https://preview.example.test/"]',
    '["https://user@preview.example.test"]',
    '["https://preview.example.test#x"]',
  ])
    expect(parsePreviewPolicy(value)).toEqual([])
})

test("ready views require private bootstrap metadata and an injected exact origin", () => {
  expect(validatePreview(result(), policy, now)).toHaveProperty("url", result()._meta.localApp.url)
  expect(validatePreview(result(), [], now)).toBeUndefined()
  expect(validatePreview({ structuredContent: lease }, policy, now)).not.toHaveProperty("url")
  for (const url of [
    "//preview.example.test/_ycoding/bootstrap?ticket=x",
    `${origin}/?ticket=${ticket}`,
    `${origin}/_ycoding/bootstrap?ticket=${ticket}#x`,
    `${origin}/_ycoding/bootstrap?ticket=${ticket}&x=1`,
    `${origin}/_ycoding/bootstrap?ticket=${ticket}&ticket=x`,
    `${origin}/_ycoding/bootstrap?ticket=`,
    `${origin}/_ycoding/bootstrap?ticket=${"a".repeat(2049)}`,
    `https://user:pass@preview.example.test/_ycoding/bootstrap?ticket=${ticket}`,
    `https://child.preview.example.test/_ycoding/bootstrap?ticket=${ticket}`,
    `${origin}/_ycoding/bootstrap?ticket=a%20b`,
  ])
    expect(validatePreview(result(url), policy, now)).toBeUndefined()
  expect(
    validatePreview(
      { ...result(), _meta: { localApp: { ...result()._meta.localApp, origin: "https://other.example.test" } } },
      policy,
      now,
    ),
  ).toBeUndefined()
})

test("preview DTO rejects malformed states, public bootstrap fields and host errors", () => {
  for (const override of [
    { kind: "other" },
    { version: 2 },
    { status: "success" },
    { sessionID: "" },
    { appID: null },
    { expiresAt: "tomorrow" },
    { expiresAt: "2026-02-30T00:00:00.000Z" },
    { url: "private-url" },
    { ticket },
    { reason: "unknown" },
    { ownerID: "owner_fixture" },
    { grantID: "grant_fixture" },
    { host: "127.0.0.1" },
    { port: 1234 },
  ])
    expect(validatePreview({ structuredContent: { ...lease, ...override } }, policy, now)).toBeUndefined()
  expect(validatePreview({ ...result(), isError: true }, policy, now)).toBeUndefined()
  expect(
    validatePreview({ structuredContent: { ...lease, expiresAt: "2000-01-01T00:00:00.000Z" } }, policy, now)?.status,
  ).toBe("expired")
  expect(
    validatePreview({ structuredContent: { ...lease, expiresAt: new Date(now).toISOString() } }, policy, now)?.status,
  ).toBe("expired")
  for (const status of ["unavailable", "expired", "revoked"])
    expect(validatePreview({ structuredContent: { ...lease, status } }, policy, now)?.status).toBe(status)
})

test("loopback bootstrap policy remains exact across host and port", () => {
  const local = "http://127.0.0.1:8123"
  const payload = {
    structuredContent: lease,
    _meta: { localApp: { origin: local, url: `${local}/_ycoding/bootstrap?ticket=${ticket}` } },
  }
  expect(validatePreview(payload, [local], now)).toHaveProperty("url", payload._meta.localApp.url)
  expect(validatePreview(payload, ["http://localhost:8123"], now)).toBeUndefined()
  expect(validatePreview(payload, ["http://127.0.0.1:8124"], now)).toBeUndefined()
})

test("only unknown unavailable leases may omit their expiry", () => {
  expect(
    validatePreview(
      { structuredContent: { ...lease, status: "unavailable", reason: "not_registered", expiresAt: null } },
      policy,
      now,
    ),
  ).toEqual({ appID: lease.appID, sessionID: lease.sessionID, status: "unavailable", expiresAt: null })
  for (const status of ["ready", "expired", "revoked"])
    expect(validatePreview({ structuredContent: { ...lease, status, expiresAt: null } }, policy, now)).toBeUndefined()
})
