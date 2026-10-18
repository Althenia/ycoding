import { describe, expect, test } from "bun:test"
import { parseMcpRequest, type McpResponse } from "../../../packages/remote/src/index"
import { createMemoryMcpStore } from "../src/auth/mcp/memory-store"
import type { McpGrantRow, McpStore } from "../src/auth/mcp/store"
import { createMcpAuthority, createMcpRelay, type McpGrant } from "../src/relay/mcp"

const resource = "https://relay.test/api/mcp/devices/device"
const now = 5_000
const trusted = { ownerID: "owner", deviceID: "device", resource }
const principal = { ownerID: "owner", deviceID: "device", clientID: "client" }
const grant: McpGrant = { grantID: "g1", epoch: "e1", resource, accessExpiresAt: 9_000, principal }
const reply: McpResponse = { status: 200, contentType: "application/json", body: '{"jsonrpc":"2.0","id":1,"result":{}}' }

let seedSequence = 0

async function seedGrant(store: McpStore, id: string, overrides: Partial<McpGrantRow> = {}) {
  const row: McpGrantRow = { id, clientID: "client", deviceID: "device", ownerID: "owner", resource, scope: "ycoding:remote", epoch: "e1", consentedAt: 1, expiresAt: 100_000, ...overrides }
  const tx = `tx-${id}-${(seedSequence += 1)}`
  await store.insertAuthorization({
    id: tx, clientID: "client", deviceID: "device", resource, scope: "ycoding:remote", redirectUri: "https://c.test/cb", codeChallenge: "x",
    stage: "consent", csrfHash: "csrf", ownerID: row.ownerID, epoch: "e1", createdAt: 1, expiresAt: 10_000,
  })
  expect(await store.allowConsent({ id: tx, csrfHash: "csrf", now: 2, grant: row, code: { hash: `c-${tx}`, grantID: id, redirectUri: "https://c.test/cb", codeChallenge: "x", createdAt: 1, expiresAt: 100 } })).toBe(true)
}

async function harness(overrides: Partial<McpGrantRow> = {}) {
  const store = createMemoryMcpStore()
  await store.setDevice({ deviceID: "device", enabled: true, epoch: "e1", now: 1 })
  await seedGrant(store, "g1", overrides)
  let deviceAccount = true
  const authority = createMcpAuthority({
    store,
    now: () => now,
    authorizeDevice: async (deviceID) =>
      deviceAccount && deviceID === "device" ? { ok: true, value: { userID: "owner" } } : { ok: false, reason: "revoked_device" },
  })
  const sent: string[] = []
  let sequence = 0
  const relay = createMcpRelay({
    now: () => now,
    newID: () => `m${(sequence += 1)}`,
    send: (_agentID, frame) => { sent.push(frame) },
    authorize: authority.authorize,
    authorizeDevice: authority.authorizeDevice,
    validateGate: authority.validateGate,
    revokeGrants: authority.revokeGrants,
    persistState: (_agentID, state) => authority.persistState("device", state),
    authorizeGrant: authority.authorizeGrant,
    timeoutMs: 60_000,
  })
  const open = async (agentID = "a1") => {
    await relay.setAgent({ agentID, ownerID: "owner", deviceID: "device" })
    expect(await relay.handleState(agentID, { type: "mcp.state", id: "s1", enabled: true, epoch: "e1" })).toBe("acknowledged")
  }
  const call = (callGrant: McpGrant = grant) =>
    relay.request({ grant: callGrant, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', headers: { "content-type": "application/json" } }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
  const settle = async () => {
    for (let index = 0; index < 400; index++) await Promise.resolve()
  }
  return {
    store, relay, sent, open, call, settle,
    revokeDeviceAccount: () => { deviceAccount = false },
  }
}

describe("MCP events grant authorization", () => {
  test("capabilities probe reports support without any grant state", async () => {
    const h = await harness()
    expect(await h.relay.authorizeEvent(trusted, { action: "capabilities" })).toEqual({ action: "capabilities", supported: true })
  })

  test("resolve returns the exact pending grant and its expiry while the forwarded frame keeps the 3-field principal", async () => {
    const h = await harness()
    await h.open()
    const result = h.call()
    await h.settle()
    const forwarded = h.sent.filter((frame) => (JSON.parse(frame) as { type?: string }).type === "request")
    expect(forwarded).toHaveLength(1)
    const frame = parseMcpRequest(forwarded[0])
    expect(frame?.input.principal).toEqual(principal)
    expect(forwarded[0]).not.toContain("g1")
    expect(await h.relay.authorizeEvent(trusted, { action: "resolve", requestID: "m1", principal, epoch: "e1" })).toEqual({
      action: "resolve",
      authorized: true,
      grantID: "g1",
      expiresAt: 100_000,
    })
    expect(h.relay.handleResponse("a1", { type: "response", id: "m1", ok: true, value: reply })).toBe("accepted")
    expect(await result).toEqual({ ok: true, value: reply })
    expect(await h.relay.authorizeEvent(trusted, { action: "resolve", requestID: "m1", principal, epoch: "e1" })).toEqual({
      action: "resolve",
      authorized: false,
      reason: "not_found",
    })
  })

  test("resolve refuses a missing request and principal or epoch mismatches without settling the request", async () => {
    const h = await harness()
    await h.open()
    const result = h.call()
    await h.settle()
    expect(await h.relay.authorizeEvent(trusted, { action: "resolve", requestID: "missing", principal, epoch: "e1" })).toEqual({ action: "resolve", authorized: false, reason: "not_found" })
    expect(await h.relay.authorizeEvent(trusted, { action: "resolve", requestID: "m1", principal: { ...principal, clientID: "other" }, epoch: "e1" })).toEqual({ action: "resolve", authorized: false, reason: "forbidden" })
    expect(await h.relay.authorizeEvent(trusted, { action: "resolve", requestID: "m1", principal: { ...principal, ownerID: "intruder" }, epoch: "e1" })).toEqual({ action: "resolve", authorized: false, reason: "forbidden" })
    expect(await h.relay.authorizeEvent(trusted, { action: "resolve", requestID: "m1", principal: { ...principal, deviceID: "other" }, epoch: "e1" })).toEqual({ action: "resolve", authorized: false, reason: "forbidden" })
    expect(await h.relay.authorizeEvent(trusted, { action: "resolve", requestID: "m1", principal, epoch: "e0" })).toEqual({ action: "resolve", authorized: false, reason: "unauthorized" })
    expect(await h.relay.authorizeEvent({ ownerID: "intruder", deviceID: "device", resource }, { action: "resolve", requestID: "m1", principal, epoch: "e1" })).toEqual({ action: "resolve", authorized: false, reason: "forbidden" })
    h.relay.handleResponse("a1", { type: "response", id: "m1", ok: true, value: reply })
    expect(await result).toEqual({ ok: true, value: reply })
  })

  test("resolve revalidates the grant in D1 at resolve time and fails after revocation or agent replacement", async () => {
    const revoked = await harness()
    await revoked.open()
    const first = revoked.call()
    await revoked.settle()
    await revoked.store.revokeGrant("g1", 3)
    expect(await revoked.relay.authorizeEvent(trusted, { action: "resolve", requestID: "m1", principal, epoch: "e1" })).toEqual({ action: "resolve", authorized: false, reason: "unauthorized" })
    revoked.relay.handleResponse("a1", { type: "response", id: "m1", ok: true, value: reply })
    await first

    const replaced = await harness()
    await replaced.open()
    const second = replaced.call()
    await replaced.settle()
    await replaced.relay.setAgent({ agentID: "a2", ownerID: "owner", deviceID: "device" })
    expect(await replaced.relay.authorizeEvent(trusted, { action: "resolve", requestID: "m1", principal, epoch: "e1" })).toEqual({ action: "resolve", authorized: false, reason: "unavailable" })
    expect((await second).ok).toBe(false)
  })

  test("resolve refuses a pending grant whose resource is a cross-origin alias of the canonical device resource", async () => {
    const crossOrigin = "https://other-origin.example/api/mcp/devices/device"
    const h = await harness({ resource: crossOrigin })
    await h.open()
    const result = h.call({ ...grant, resource: crossOrigin })
    await h.settle()
    expect(await h.relay.authorizeEvent(trusted, { action: "resolve", requestID: "m1", principal, epoch: "e1" })).toEqual({
      action: "resolve",
      authorized: false,
      reason: "unauthorized",
    })
    h.relay.handleResponse("a1", { type: "response", id: "m1", ok: true, value: reply })
    expect(await result).toEqual({ ok: true, value: reply })
  })

  test("check validates the exact grant fresh before each delivery and never revives an old grant by binding", async () => {
    const h = await harness()
    expect(await h.relay.authorizeEvent(trusted, { action: "check", grantID: "g1", principal, epoch: "e1" })).toEqual({ action: "check", authorized: true, grantID: "g1", expiresAt: 100_000 })
    expect(await h.relay.authorizeEvent(trusted, { action: "check", grantID: "missing", principal, epoch: "e1" })).toEqual({ action: "check", authorized: false, reason: "not_found" })
    await h.store.revokeGrant("g1", 3)
    await seedGrant(h.store, "g2")
    expect(await h.relay.authorizeEvent(trusted, { action: "check", grantID: "g1", principal, epoch: "e1" })).toEqual({ action: "check", authorized: false, reason: "unauthorized" })
    expect(await h.relay.authorizeEvent(trusted, { action: "check", grantID: "g2", principal, epoch: "e1" })).toEqual({ action: "check", authorized: true, grantID: "g2", expiresAt: 100_000 })
  })

  test.each([
    ["expired grant", { expiresAt: now }, "unauthorized"],
    ["wrong scope", { scope: "other" }, "unauthorized"],
    ["wrong resource", { resource: "https://relay.test/api/mcp/devices/other" }, "unauthorized"],
    ["cross-origin resource with the same path", { resource: "https://other-origin.example/api/mcp/devices/device" }, "unauthorized"],
    ["wrong client", { clientID: "other" }, "forbidden"],
    ["wrong owner", { ownerID: "intruder" }, "forbidden"],
    ["wrong grant device", { deviceID: "other" }, "forbidden"],
    ["stale grant epoch", { epoch: "e0" }, "unauthorized"],
  ] as const)("check refuses a %s", async (_name, overrides, reason) => {
    const h = await harness(overrides)
    expect(await h.relay.authorizeEvent(trusted, { action: "check", grantID: "g1", principal, epoch: "e1" })).toEqual({ action: "check", authorized: false, reason })
  })

  test("check refuses a disabled MCP device, a stale supplied epoch, and a revoked device account", async () => {
    const h = await harness()
    expect(await h.relay.authorizeEvent(trusted, { action: "check", grantID: "g1", principal, epoch: "e0" })).toEqual({ action: "check", authorized: false, reason: "unauthorized" })
    await h.store.setDevice({ deviceID: "device", enabled: false, epoch: "e1", now: 3 })
    expect(await h.relay.authorizeEvent(trusted, { action: "check", grantID: "g1", principal, epoch: "e1" })).toEqual({ action: "check", authorized: false, reason: "not_found" })
    await h.store.setDevice({ deviceID: "device", enabled: true, epoch: "e1", now: 4 })
    await seedGrant(h.store, "g1")
    h.revokeDeviceAccount()
    expect(await h.relay.authorizeEvent(trusted, { action: "check", grantID: "g1", principal, epoch: "e1" })).toEqual({ action: "check", authorized: false, reason: "forbidden" })
  })

  test("resolve and check are read-only: repeated calls leave the grant, device, and credentials untouched", async () => {
    const h = await harness()
    await h.open()
    const result = h.call()
    await h.settle()
    const before = { grant: await h.store.findGrant("g1"), device: await h.store.getDevice("device") }
    for (let index = 0; index < 3; index++) {
      expect(await h.relay.authorizeEvent(trusted, { action: "resolve", requestID: "m1", principal, epoch: "e1" })).toMatchObject({ authorized: true })
      expect(await h.relay.authorizeEvent(trusted, { action: "check", grantID: "g1", principal, epoch: "e1" })).toMatchObject({ authorized: true })
    }
    expect({ grant: await h.store.findGrant("g1"), device: await h.store.getDevice("device") }).toEqual(before)
    h.relay.handleResponse("a1", { type: "response", id: "m1", ok: true, value: reply })
    expect(await result).toEqual({ ok: true, value: reply })
  })
})
