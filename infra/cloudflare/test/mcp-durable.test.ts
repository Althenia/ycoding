import { describe, expect, test } from "bun:test"
import { createMemoryMcpStore } from "../src/auth/mcp/memory-store"
import type { McpGrantRow, McpStore } from "../src/auth/mcp/store"
import { McpLimits } from "../../../packages/remote/src/index"
import { createMcpAuthority, mcpFailureStatus, parseMcpForward, readBoundedText, type McpGrant } from "../src/relay/mcp"
import { authorizationBodyBytes } from "../src/relay/mcp-events"

const resource = "https://relay.test/api/mcp/devices/device"
const now = 5_000

async function seed(store: McpStore, overrides: Partial<McpGrantRow> = {}) {
  await store.setDevice({ deviceID: "device", enabled: true, epoch: "e1", now: 1 })
  await store.insertAuthorization({
    id: "tx", clientID: "client", deviceID: "device", resource, scope: "ycoding:remote", redirectUri: "https://c.test/cb", codeChallenge: "x",
    stage: "consent", csrfHash: "csrf", ownerID: "owner", epoch: "e1", createdAt: 1, expiresAt: 10_000,
  })
  const grant: McpGrantRow = { id: "g1", clientID: "client", deviceID: "device", ownerID: "owner", resource, scope: "ycoding:remote", epoch: "e1", consentedAt: 1, expiresAt: 100_000, ...overrides }
  expect(await store.allowConsent({ id: "tx", csrfHash: "csrf", now: 2, grant, code: { hash: "c", grantID: "g1", redirectUri: "https://c.test/cb", codeChallenge: "x", createdAt: 1, expiresAt: 100 } })).toBe(true)
}

function authority(store: McpStore, userID = "owner") {
  return createMcpAuthority({
    store,
    now: () => now,
    authorizeDevice: async (deviceID) => (deviceID === "device" ? { ok: true, value: { userID } } : { ok: false, reason: "unknown_device" }),
  })
}

const grant: McpGrant = { grantID: "g1", epoch: "e1", resource, accessExpiresAt: 9_000, principal: { ownerID: "owner", deviceID: "device", clientID: "client" } }

describe("forward headers", () => {
  const headers = (extra: Record<string, string> = {}) => new Headers({
    "x-ycoding-mcp-owner": "owner", "x-ycoding-mcp-device": "device", "x-ycoding-mcp-client": "https://c.test/id.json",
    "x-ycoding-mcp-grant": "g1", "x-ycoding-mcp-epoch": "e1", "x-ycoding-mcp-resource": resource, "x-ycoding-mcp-expires": "9000",
    "content-type": "application/json", accept: "application/json", authorization: "Bearer secret", cookie: "a=b", ...extra,
  })

  test("builds the grant from trusted headers and forwards only allowlisted protocol headers", () => {
    const forward = parseMcpForward(headers({ "mcp-protocol-version": "2026-07-28" }))
    expect(forward).toEqual({
      grant: { grantID: "g1", epoch: "e1", resource, accessExpiresAt: 9000, principal: { ownerID: "owner", deviceID: "device", clientID: "https://c.test/id.json" } },
      headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2026-07-28" },
    })
    expect(JSON.stringify(forward)).not.toContain("secret")
  })

  test.each(["owner", "device", "client", "grant", "epoch", "resource", "expires"])("rejects a request missing the %s trust header", (name) => {
    const incomplete = headers()
    incomplete.delete(`x-ycoding-mcp-${name}`)
    expect(parseMcpForward(incomplete)).toBeUndefined()
  })

  test.each(["0", "-1", "soon", "1.5"])("rejects expiry %s", (value) => {
    expect(parseMcpForward(headers({ "x-ycoding-mcp-expires": value }))).toBeUndefined()
  })
})

describe("failure status", () => {
  test.each([
    ["unauthorized", 401], ["forbidden", 403], ["message_too_large", 413], ["rate_limited", 429], ["agent_unavailable", 503],
    ["invalid_message", 400], ["outcome_unknown", 502], ["unknown_operation", 502], ["internal_error", 502],
  ] as const)("maps %s to %i", (code, status) => {
    expect(mcpFailureStatus(code)).toBe(status)
  })
})

describe("authority", () => {
  test("accepts a live grant bound to its resource, owner, client, device and enabled epoch", async () => {
    const store = createMemoryMcpStore()
    await seed(store)
    expect(await authority(store).authorize(grant)).toEqual({ ok: true })
  })

  test.each([
    ["unknown grant", { grantID: "other" }, "unknown_grant"],
    ["foreign resource", { resource: "https://relay.test/api/mcp/devices/other" }, "resource_mismatch"],
    ["foreign owner", { principal: { ownerID: "intruder", deviceID: "device", clientID: "client" } }, "principal_mismatch"],
    ["foreign client", { principal: { ownerID: "owner", deviceID: "device", clientID: "other" } }, "principal_mismatch"],
    ["foreign device", { principal: { ownerID: "owner", deviceID: "other", clientID: "client" } }, "principal_mismatch"],
    ["stale epoch", { epoch: "e0" }, "epoch_mismatch"],
  ] as const)("refuses a %s", async (_name, change, reason) => {
    const store = createMemoryMcpStore()
    await seed(store)
    expect(await authority(store).authorize({ ...grant, ...change })).toEqual({ ok: false, reason })
  })

  test("refuses a revoked, expired, or disabled-device grant and a device re-enabled under a new epoch", async () => {
    const revoked = createMemoryMcpStore()
    await seed(revoked)
    await revoked.revokeGrant("g1", 3)
    expect(await authority(revoked).authorize(grant)).toEqual({ ok: false, reason: "revoked_grant" })

    const expired = createMemoryMcpStore()
    await seed(expired, { expiresAt: now })
    expect(await authority(expired).authorize(grant)).toEqual({ ok: false, reason: "expired_grant" })

    const disabled = createMemoryMcpStore()
    await seed(disabled)
    await disabled.setDevice({ deviceID: "device", enabled: false, epoch: "e1", now: 3 })
    expect(await authority(disabled).authorize(grant)).toMatchObject({ ok: false })

    const reenabled = createMemoryMcpStore()
    await seed(reenabled)
    await reenabled.setDevice({ deviceID: "device", enabled: true, epoch: "e2", now: 3 })
    expect(await authority(reenabled).authorize(grant)).toMatchObject({ ok: false })
  })

  test("device authority requires the admitted device to belong to the principal's owner", async () => {
    const store = createMemoryMcpStore()
    expect(await authority(store).authorizeDevice(grant.principal)).toEqual({ ok: true })
    expect(await authority(store, "someone-else").authorizeDevice(grant.principal)).toEqual({ ok: false, reason: "not_owner" })
    expect(await authority(store).authorizeDevice({ ...grant.principal, deviceID: "gone" })).toEqual({ ok: false, reason: "unknown_device" })
  })

  test("persisting a state switches the device, retiring grants of a changed epoch and keeping grants of the same epoch", async () => {
    const store = createMemoryMcpStore()
    await seed(store)
    const ports = authority(store)
    await ports.persistState("device", { id: "s", enabled: true, epoch: "e1" })
    expect(await ports.authorize(grant)).toEqual({ ok: true })
    await ports.persistState("device", { id: "s", enabled: true, epoch: "e2" })
    expect(await store.findGrant("g1")).toBeUndefined()
    expect(await store.getDevice("device")).toMatchObject({ enabled: true, epoch: "e2" })
  })

  test("revoking for a disable deletes device grants, and an enable leaves them to the epoch-aware switch", async () => {
    const store = createMemoryMcpStore()
    await seed(store)
    const ports = authority(store)
    await ports.revokeGrants("device", "e1")
    expect(await store.findGrant("g1")).toBeDefined()
    await ports.revokeGrants("device")
    expect(await store.findGrant("g1")).toBeUndefined()
  })
})


describe("bounded body", () => {
  const stream = (chunks: readonly Uint8Array[]) => new ReadableStream<Uint8Array>({
    start: (controller) => {
      chunks.forEach((chunk) => controller.enqueue(chunk))
      controller.close()
    },
  })
  const bytes = (text: string) => new TextEncoder().encode(text)

  test("reads a body up to the byte cap and decodes multibyte text across chunks", async () => {
    const encoded = bytes("héllo✓")
    expect(await readBoundedText(stream([encoded.slice(0, 2), encoded.slice(2, 7), encoded.slice(7)]), encoded.byteLength)).toBe("héllo✓")
    expect(await readBoundedText(null, 10)).toBe("")
  })

  test("refuses a stream that exceeds the byte cap without a declared length and cancels it", async () => {
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(bytes("x".repeat(1024))),
      cancel: () => { cancelled = true },
    })
    expect(await readBoundedText(source, McpLimits.bodyChars * 4)).toBeUndefined()
    expect(cancelled).toBe(true)
  })

  test("a body exactly at the cap is accepted and one byte over is refused", async () => {
    expect(await readBoundedText(stream([bytes("abcd")]), 4)).toBe("abcd")
    expect(await readBoundedText(stream([bytes("abcde")]), 4)).toBeUndefined()
  })

  test("Events authorization enforces the exact byte cap and cancels unbounded excess", async () => {
    expect(authorizationBodyBytes).toBe(32768)
    const text = "😀".repeat(8192)
    const encoded = bytes(text)
    expect(await readBoundedText(stream([encoded.slice(0, 3), encoded.slice(3)]), authorizationBodyBytes)).toBe(text)
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(encoded)
        controller.enqueue(bytes("x"))
      },
      cancel: () => { cancelled = true },
    })
    expect(await readBoundedText(source, authorizationBodyBytes)).toBeUndefined()
    expect(cancelled).toBe(true)
  })
})
