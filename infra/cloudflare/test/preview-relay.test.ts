import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { RemoteLimits } from "../../../packages/remote/src/index"
import { createPreviewDirectoryStore } from "../src/preview/directory-store"
import { createPreviewRelay, type PreviewRelayDeps } from "../src/relay/preview"

const pool = ["https://preview-1.example.invalid", "https://preview-2.example.invalid"]
const agent = { agentID: "agent_1", ownerID: "owner_a", deviceID: "device_a" }
const input = { origin: pool[0]!, method: "GET", path: "/_r/0123456789abcdef/index.html", headers: { accept: "text/html" } } as const
const hash = (character: string) => character.repeat(64)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function fixture(options: Partial<PreviewRelayDeps> = {}) {
  let time = 1_000_000
  let sequence = 0
  let authorized = true
  const sent: string[] = []
  const persisted: boolean[] = []
  const database = new Database(":memory:")
  const store = createPreviewDirectoryStore({
    sql: { exec: (query, ...bindings) => ({ toArray: () => database.prepare(query).all(...(bindings as never[])) }) },
    transactionSync: (operation) => database.transaction(operation)(),
  }, () => time)
  const relay = createPreviewRelay({
    origins: pool,
    directory: {
      allocate: async (request) => store.allocate(request),
      register: async (lease) => store.register(lease),
      revoke: async (target) => store.revoke(target),
    },
    send: (_agentID, frame) => { sent.push(frame) },
    persist: (_agentID, value) => { persisted.push(value) },
    authorizeDevice: async () => authorized,
    now: () => time,
    newID: () => `relay_${++sequence}`,
    timeoutMs: 1_000,
    ...options,
  })
  const frames = () => sent.map((frame) => JSON.parse(frame) as Record<string, unknown>)
  const route = (frame: unknown) => relay.route(agent.agentID, JSON.stringify(frame))
  const advertise = (origins: readonly string[] = pool) => route({ type: "preview.state", id: "state_1", origins })
  const allocate = (registration = hash("a")) => route({ type: "preview.allocate", id: `allocate_${registration[0]}`, registration, expiresAt: time + 3_600_000 })
  const lease = (origin = pool[0]!, ticketHash = hash("1"), registration = hash("a")) =>
    route({ type: "preview.lease", id: `lease_${ticketHash[0]}`, origin, ticketHash, leaseTag: ticketHash.slice(0, 16), registration, expiresAt: time + 60_000 })
  return { relay, store, sent, frames, persisted, route, advertise, allocate, lease, deny: () => { authorized = false } }
}

const request = (f: ReturnType<typeof fixture>, signal?: AbortSignal) =>
  f.relay.request({ ownerID: agent.ownerID, deviceID: agent.deviceID, input, ...(signal === undefined ? {} : { signal }) })

test("an agent that never advertised preview receives no preview frame", async () => {
  const f = fixture()
  f.relay.setAgent(agent)
  await expect(request(f)).rejects.toMatchObject({ status: 503 })
  expect(f.sent).toEqual([])
  expect(await f.relay.route(agent.agentID, '{"type":"pong"}')).toBe("core")
  expect(await f.relay.route(agent.agentID, JSON.stringify({ type: "response", id: "relay_9", ok: true, value: {} }))).toBe("core")
})

test("an empty origin pool declines the capability, every allocation and every lease", async () => {
  const f = fixture({ origins: [] })
  f.relay.setAgent(agent)
  await f.advertise()
  await f.allocate()
  await f.lease()
  expect(f.frames()).toEqual([
    { type: "preview.state.ack", id: "state_1", enabled: false },
    { type: "preview.allocate.ack", id: "allocate_a", reason: "rejected" },
    { type: "preview.lease.ack", id: "lease_1", ok: false },
  ])
  await expect(request(f)).rejects.toMatchObject({ status: 503 })
})

test("the capability is enabled only for the exact configured origin set", async () => {
  const f = fixture()
  f.relay.setAgent(agent)
  await f.advertise([pool[0]!])
  expect(f.frames().at(-1)).toEqual({ type: "preview.state.ack", id: "state_1", enabled: false })
  await f.advertise([pool[1]!, pool[0]!])
  expect(f.frames().at(-1)).toEqual({ type: "preview.state.ack", id: "state_1", enabled: true })
  expect(f.persisted).toEqual([false, true])
  expect(await f.route({ type: "preview.state", id: "state_2", origins: ["https://*.example.invalid"] })).toBe("invalid")
  expect(await f.relay.route("agent_stale", JSON.stringify({ type: "preview.state", id: "state_3", origins: pool }))).toBe("invalid")
})

test("allocations bind distinct origins to the socket's device, then exhaust the pool", async () => {
  const f = fixture()
  f.relay.setAgent(agent)
  await f.advertise()
  await f.allocate(hash("a"))
  await f.allocate(hash("a"))
  await f.allocate(hash("b"))
  await f.allocate(hash("c"))
  expect(f.frames().slice(1)).toEqual([
    { type: "preview.allocate.ack", id: "allocate_a", origin: pool[0] },
    { type: "preview.allocate.ack", id: "allocate_a", origin: pool[0] },
    { type: "preview.allocate.ack", id: "allocate_b", origin: pool[1] },
    { type: "preview.allocate.ack", id: "allocate_c", reason: "exhausted" },
  ])
  await f.lease(pool[0], hash("1"), hash("a"))
  await f.lease(pool[1], hash("2"), hash("a"))
  expect(f.frames().slice(-2)).toEqual([{ type: "preview.lease.ack", id: "lease_1", ok: true }, { type: "preview.lease.ack", id: "lease_2", ok: false }])
  expect(f.store.redeem(hash("1"), pool[0]!)).toMatchObject({ state: "valid", lease: { ownerID: "owner_a", deviceID: "device_a" } })
})

test("revocation, re-advertisement and agent purge end bindings without freeing their origins", async () => {
  const f = fixture()
  f.relay.setAgent(agent)
  await f.advertise()
  await f.allocate(hash("a"))
  await f.lease(pool[0], hash("1"), hash("a"))
  await f.route({ type: "preview.revoke", registration: hash("a") })
  expect(f.store.redeem(hash("1"), pool[0]!).state).toBe("ended")
  await f.allocate(hash("b"))
  await f.lease(pool[1], hash("2"), hash("b"))
  await f.advertise()
  expect(f.store.redeem(hash("2"), pool[1]!).state).toBe("ended")
  await f.allocate(hash("c"))
  expect(f.frames().at(-1)).toEqual({ type: "preview.allocate.ack", id: "allocate_c", reason: "exhausted" })
  const cleared = f.relay.clearAgent(agent.agentID)
  expect(cleared).toEqual(agent)
  await f.relay.purge(cleared!)
  expect(f.relay.clearAgent(agent.agentID)).toBeUndefined()
})

test("requests use relay IDs, reassemble chunked responses and validate the result", async () => {
  const f = fixture()
  f.relay.setAgent(agent)
  await f.advertise()
  const pending = request(f)
  await flush()
  expect(f.frames().at(-1)).toEqual({ type: "request", id: "relay_1", operation: "preview.http", input })
  const text = JSON.stringify({ status: 200, headers: [["content-type", "text/html"]], body: Buffer.from("<p>fixture</p>").toString("base64") })
  expect(await f.route({ type: "response", id: "relay_1", ok: true, value: text.slice(0, 20), chunk: { index: 0, last: false } })).toBe("handled")
  expect(await f.route({ type: "response", id: "relay_1", ok: true, value: text.slice(20), chunk: { index: 1, last: true } })).toBe("handled")
  expect(await pending).toEqual(JSON.parse(text))
  const invalid = request(f)
  await flush()
  expect(await f.route({ type: "response", id: "relay_2", ok: true, value: { status: 200, headers: [], body: "%%%" } })).toBe("violation")
  await expect(invalid).rejects.toMatchObject({ status: 502 })
  expect(f.frames().at(-1)).toEqual({ type: "cancel", id: "relay_2" })
})

test("requests fail closed for foreign devices, unlisted origins, revoked devices, cancellation, timeouts and disconnects", async () => {
  const f = fixture()
  f.relay.setAgent(agent)
  await f.advertise()
  const before = f.sent.length
  await expect(f.relay.request({ ownerID: "owner_b", deviceID: agent.deviceID, input })).rejects.toMatchObject({ status: 403 })
  await expect(f.relay.request({ ...agent, input: { ...input, origin: "https://other.example.invalid" } })).rejects.toMatchObject({ status: 403 })
  await expect(f.relay.request({ ...agent, input: { ...input, method: "POST" as "GET" } })).rejects.toMatchObject({ status: 400 })
  expect(f.sent.length).toBe(before)
  const controller = new AbortController()
  const cancelled = request(f, controller.signal)
  await flush()
  controller.abort()
  await expect(cancelled).rejects.toMatchObject({ status: 503 })
  expect(f.frames().at(-1)).toEqual({ type: "cancel", id: "relay_2" })
  const disconnected = request(f)
  f.relay.clearAgent(agent.agentID)
  await expect(disconnected).rejects.toMatchObject({ status: 503 })
  f.relay.setAgent(agent, true)
  f.deny()
  const sentBefore = f.sent.length
  await expect(request(f)).rejects.toMatchObject({ status: 403 })
  expect(f.sent.length).toBe(sentBefore)
  const slow = fixture({ timeoutMs: 5 })
  slow.relay.setAgent(agent, true)
  await expect(request(slow)).rejects.toMatchObject({ status: 504 })
  expect(slow.frames().at(-1)).toEqual({ type: "cancel", id: "relay_1" })
})

test("a restored agent keeps preview only while the relay still has an origin pool", async () => {
  const disabled = fixture({ origins: [] })
  disabled.relay.setAgent(agent, true)
  await expect(request(disabled)).rejects.toMatchObject({ status: 503 })
  const f = fixture()
  f.relay.setAgent(agent, true)
  const pending = request(f)
  await flush()
  expect(f.frames().at(-1)).toMatchObject({ type: "request", operation: "preview.http" })
  f.relay.setAgent({ ...agent, agentID: "agent_2" }, true)
  await expect(pending).rejects.toMatchObject({ status: 503 })
})

test("preview control frames are rate limited per agent", async () => {
  const f = fixture()
  f.relay.setAgent(agent)
  for (let index = 0; index < RemoteLimits.maxClientRequestsPerWindow; index++)
    expect(await f.relay.route(agent.agentID, '{"type":"preview.revoke"}')).toBe("handled")
  expect(await f.relay.route(agent.agentID, '{"type":"preview.revoke"}')).toBe("violation")
})
