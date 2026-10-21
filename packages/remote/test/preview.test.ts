import { expect, test } from "bun:test"
import { RemoteLimits, parseAgentMessage, parseClientMessage, parseRelayToAgentMessage } from "../src/index"
import {
  parsePreviewAllocate,
  parsePreviewAllocateAck,
  parsePreviewLease,
  parsePreviewLeaseAck,
  parsePreviewOrigins,
  parsePreviewRequest,
  parsePreviewResult,
  parsePreviewRevoke,
  parsePreviewState,
  parsePreviewStateAck,
  sameOrigins,
  sha256Hex,
} from "../src/preview"

const origin = "https://preview.example.invalid"
const hash = "a".repeat(64)
const cookie = `__Host-ycoding-preview=${"c".repeat(43)}`
const request = { type: "request", id: "relay_1", operation: "preview.http", input: { origin, method: "GET", path: "/_r/0123456789abcdef/index.html?view=1", headers: { accept: "text/html", cookie } } } as const

test("agent preview controls carry only HTTPS origins, digests, a lease tag and expiries", () => {
  const state = { type: "preview.state", id: "state_1", origins: [origin, "https://preview-2.example.invalid"] } as const
  const allocate = { type: "preview.allocate", id: "allocate_1", registration: "b".repeat(64), expiresAt: 1_000 } as const
  const lease = { type: "preview.lease", id: "lease_1", origin, ticketHash: hash, leaseTag: "0123456789abcdef", registration: "b".repeat(64), expiresAt: 1_000 } as const
  expect(parsePreviewState(JSON.stringify(state))).toEqual(state)
  expect(parsePreviewAllocate(JSON.stringify(allocate))).toEqual(allocate)
  expect(parsePreviewLease(JSON.stringify(lease))).toEqual(lease)
  expect(parsePreviewRevoke('{"type":"preview.revoke"}')).toEqual({ type: "preview.revoke" })
  expect(parsePreviewRevoke(JSON.stringify({ type: "preview.revoke", ticketHash: hash }))).toEqual({ type: "preview.revoke", ticketHash: hash })
  expect(parsePreviewRevoke(JSON.stringify({ type: "preview.revoke", registration: hash }))).toEqual({ type: "preview.revoke", registration: hash })
  expect(parsePreviewRevoke(JSON.stringify({ type: "preview.revoke", ticketHash: hash, registration: hash }))).toBeUndefined()
  expect(parsePreviewRevoke(JSON.stringify({ type: "preview.revoke", ticketHash: "x" }))).toBeUndefined()
  expect(parsePreviewStateAck('{"type":"preview.state.ack","id":"state_1","enabled":false}')).toEqual({ type: "preview.state.ack", id: "state_1", enabled: false })
  expect(parsePreviewAllocateAck(JSON.stringify({ type: "preview.allocate.ack", id: "allocate_1", origin }))).toEqual({ type: "preview.allocate.ack", id: "allocate_1", origin })
  expect(parsePreviewAllocateAck('{"type":"preview.allocate.ack","id":"allocate_1","reason":"exhausted"}')).toEqual({ type: "preview.allocate.ack", id: "allocate_1", reason: "exhausted" })
  expect(parsePreviewAllocateAck(JSON.stringify({ type: "preview.allocate.ack", id: "allocate_1", origin, reason: "exhausted" }))).toBeUndefined()
  expect(parsePreviewAllocateAck(JSON.stringify({ type: "preview.allocate.ack", id: "allocate_1", origin: "https://*.example.invalid" }))).toBeUndefined()
  expect(parsePreviewLeaseAck('{"type":"preview.lease.ack","id":"lease_1","ok":true}')).toEqual({ type: "preview.lease.ack", id: "lease_1", ok: true })
  for (const origins of [[], ["http://preview.example.invalid"], ["https://preview.example.invalid/"], ["https://user@preview.example.invalid"], ["https://*.example.invalid"], [origin, origin],
    Array.from({ length: 65 }, (_, index) => `https://preview-${index}.example.invalid`)])
    expect(parsePreviewState(JSON.stringify({ ...state, origins }))).toBeUndefined()
  for (const change of [{ registration: "B".repeat(64) }, { registration: undefined }, { expiresAt: 0 }, { origin }])
    expect(parsePreviewAllocate(JSON.stringify({ ...allocate, ...change }))).toBeUndefined()
  for (const change of [{ ticketHash: "A".repeat(64) }, { ticketHash: "a".repeat(63) }, { leaseTag: "0123456789ABCDEF" }, { leaseTag: "0123456789abcde" }, { leaseTag: undefined }, { registration: "x" },
    { origin: "https://*.example.invalid" }, { expiresAt: 0 }, { expiresAt: 1.5 }, { ownerID: "owner" }, { ticket: "x".repeat(43) }])
    expect(parsePreviewLease(JSON.stringify({ ...lease, ...change }))).toBeUndefined()
  for (const frame of [state, allocate, lease]) {
    expect(parseAgentMessage(JSON.stringify(frame)).ok).toBe(false)
    expect(parseClientMessage(JSON.stringify(frame)).ok).toBe(false)
  }
})

test("configured preview origin lists are exact, distinct and disabled by any invalid entry", () => {
  expect(parsePreviewOrigins(undefined)).toEqual([])
  expect(parsePreviewOrigins("")).toEqual([])
  expect(parsePreviewOrigins(`${origin}, https://preview-2.example.invalid\nhttps://preview-3.example.invalid`)).toEqual([origin, "https://preview-2.example.invalid", "https://preview-3.example.invalid"])
  for (const value of [`${origin},https://*.example.invalid`, `${origin},http://preview-2.example.invalid`, `${origin},${origin}`, `${origin}/path`])
    expect(parsePreviewOrigins(value)).toEqual([])
  expect(sameOrigins([origin, "https://b.example.invalid"], ["https://b.example.invalid", origin])).toBe(true)
  expect(sameOrigins([origin], [origin, "https://b.example.invalid"])).toBe(false)
})

test("preview HTTP requests name an HTTPS origin, use GET or HEAD, and carry allowlisted headers with only the preview cookie", () => {
  expect(parsePreviewRequest(JSON.stringify(request))).toEqual(request)
  expect(parsePreviewRequest(JSON.stringify({ ...request, input: { ...request.input, method: "HEAD" } }))?.input.method).toBe("HEAD")
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "CONNECT"])
    expect(parsePreviewRequest(JSON.stringify({ ...request, input: { ...request.input, method } }))).toBeUndefined()
  for (const headers of [{ authorization: "Bearer synthetic" }, { cookie: "session=other" }, { cookie: `${cookie}; session=other` }, { "x-forwarded-host": "evil.example" }, { host: "127.0.0.1" },
    { upgrade: "websocket" }, { accept: "x".repeat(2049) }, { accept: "text/html\r\nx-injected: 1" }, { referer: "https://preview.example.invalid/é" }])
    expect(parsePreviewRequest(JSON.stringify({ ...request, input: { ...request.input, headers } }))).toBeUndefined()
  for (const path of ["index.html", "http://127.0.0.1:22/", "/a b", `/${"x".repeat(4096)}`])
    expect(parsePreviewRequest(JSON.stringify({ ...request, input: { ...request.input, path } }))).toBeUndefined()
  for (const origin of ["http://127.0.0.1:8767", "https://*.example.invalid", undefined])
    expect(parsePreviewRequest(JSON.stringify({ ...request, input: { ...request.input, origin } }))).toBeUndefined()
  for (const extra of [{ url: "http://127.0.0.1:22/" }, { body: "AA==" }])
    expect(parsePreviewRequest(JSON.stringify({ ...request, input: { ...request.input, ...extra } }))).toBeUndefined()
  expect(parsePreviewRequest(JSON.stringify({ ...request, input: { ...request.input, path: `/${"x".repeat(RemoteLimits.maxClientMessageChars)}` } }))).toBeUndefined()
  expect(parseRelayToAgentMessage(JSON.stringify(request)).ok).toBe(false)
  expect(parseClientMessage(JSON.stringify(request)).ok).toBe(false)
})

test("preview results bound status, header shape and the decoded 1 MiB body", () => {
  const result = { status: 303, headers: [["location", "/"], ["set-cookie", `${cookie}; Path=/`]] as [string, string][], body: "" }
  expect(parsePreviewResult(result)).toEqual(result)
  expect(parsePreviewResult({ ...result, body: Buffer.alloc(1_048_576).toString("base64") })).toBeDefined()
  for (const change of [{ status: 101 }, { status: 600 }, { headers: [["Bad Name", "x"]] }, { headers: [["x", "a\r\nb"]] }, { headers: [["x"]] },
    { body: "not base64" }, { body: Buffer.alloc(1_048_576 + 3).toString("base64") }, { extra: true }])
    expect(parsePreviewResult({ ...result, ...change })).toBeUndefined()
})

test("ticket digests are lowercase SHA-256 hex", async () => {
  expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
})
