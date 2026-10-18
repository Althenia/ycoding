import { describe, expect, test } from "bun:test"
import { RemoteLimits, parseMcpRequest, type McpResponse, type McpState, type RemoteResponse } from "../../../packages/remote/src/index"
import { McpRelayError, createMcpRelay, type McpAgent, type McpAuthority, type McpGrant, type McpRelayDeps } from "../src/relay/mcp"

const allowed: McpAuthority = { ok: true }
const reply: McpResponse = { status: 200, contentType: "application/json", body: '{"jsonrpc":"2.0","id":1,"result":{}}' }
const expiresAt = 2_000_000

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function settle() {
  for (let index = 0; index < 400; index++) await Promise.resolve()
}

function state(enabled: boolean, epoch = "e1", id = "s1"): McpState {
  return { type: "mcp.state", id, enabled, epoch }
}

function harness(overrides: Partial<McpRelayDeps> = {}) {
  let now = 1_000_000
  let sequence = 0
  const sent: { readonly agentID: string; readonly frame: string }[] = []
  const log: string[] = []
  const relay = createMcpRelay({
    now: () => now,
    newID: () => `m${(sequence += 1)}`,
    send: (agentID, frame) => { sent.push({ agentID, frame }); log.push("send") },
    authorize: async () => { log.push("authorize"); return allowed },
    authorizeDevice: async () => { log.push("authorizeDevice"); return allowed },
    validateGate: async () => true,
    revokeGrants: async () => { log.push("revoke") },
    persistState: async () => { log.push("persist") },
    timeoutMs: 60_000,
    ...overrides,
  })
  const agent = (agentID = "a1"): McpAgent => ({ agentID, ownerID: "owner", deviceID: "device" })
  const frames = (type: string) => sent.map((entry) => ({ agentID: entry.agentID, value: JSON.parse(entry.frame) })).filter((entry) => entry.value.type === type)
  const requests = () => frames("request")
  const grant = (clientID = "client", epoch = "e1", grantID = "g1"): McpGrant => ({ grantID, epoch, resource: "https://r.test/api/mcp/devices/device", accessExpiresAt: expiresAt, principal: { ownerID: "owner", deviceID: "device", clientID } })
  const open = async (agentID = "a1", epoch = "e1") => {
    await relay.setAgent(agent(agentID))
    expect(await relay.handleState(agentID, state(true, epoch))).toBe("acknowledged")
  }
  const call = (options: { readonly clientID?: string; readonly epoch?: string; readonly grantID?: string; readonly body?: string; readonly signal?: AbortSignal } = {}) =>
    outcome(relay.request({ grant: grant(options.clientID, options.epoch, options.grantID), body: options.body ?? '{"jsonrpc":"2.0"}', headers: { "content-type": "application/json" }, ...(options.signal === undefined ? {} : { signal: options.signal }) }))
  const respond = (id: string, value: unknown, agentID = "a1") => relay.handleResponse(agentID, { type: "response", id, ok: true, value })
  return { relay, sent, log, agent, frames, requests, grant, open, call, respond, advance: (ms: number) => { now += ms } }
}

function outcome(promise: Promise<McpResponse>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => {
      if (!(error instanceof McpRelayError)) throw error
      return { ok: false as const, code: error.code, message: error.message }
    },
  )
}

describe("forwarding", () => {
  test("sends one named request carrying only the verified principal, epoch, allowlisted headers and body", async () => {
    const h = harness()
    await h.open()
    const result = h.call({ body: '{"jsonrpc":"2.0","method":"tools/list"}' })
    await settle()
    expect(h.requests()).toHaveLength(1)
    expect(h.requests()[0].agentID).toBe("a1")
    const frame = parseMcpRequest(JSON.stringify(h.requests()[0].value))
    expect(frame).toEqual({
      type: "request",
      id: "m1",
      operation: "mcp.request",
      input: {
        body: '{"jsonrpc":"2.0","method":"tools/list"}',
        headers: { "content-type": "application/json" },
        principal: { ownerID: "owner", deviceID: "device", clientID: "client" },
        epoch: "e1",
      },
    })
    expect(JSON.stringify(h.requests()[0].value)).not.toContain("g1")
    expect(h.respond("m1", reply)).toBe("accepted")
    expect(await result).toEqual({ ok: true, value: reply })
  })

  test("validates the grant and the device immediately before every send, uncached", async () => {
    const h = harness()
    await h.open()
    const first = h.call()
    await settle()
    h.respond("m1", reply)
    await first
    const second = h.call()
    await settle()
    h.respond("m2", reply)
    await second
    expect(h.log.filter((entry) => entry === "authorizeDevice")).toHaveLength(2)
    expect(h.log.slice(-6)).toEqual(["authorize", "authorizeDevice", "send", "authorize", "authorizeDevice", "send"])
  })

  test("refuses a request without sending when grant or device authority fails", async () => {
    let grantAllowed = false
    const h = harness({
      authorize: async () => (grantAllowed ? allowed : { ok: false, reason: "revoked" }),
      authorizeDevice: async () => ({ ok: false, reason: "device" }),
    })
    await h.open()
    expect(await h.call()).toMatchObject({ ok: false, code: "unauthorized" })
    grantAllowed = true
    expect(await h.call()).toMatchObject({ ok: false, code: "forbidden" })
    expect(h.requests()).toHaveLength(0)
  })

  test("refuses an expired access credential at the moment of sending", async () => {
    const stall = deferred<McpAuthority>()
    const h = harness({ authorize: async () => stall.promise })
    await h.open()
    const result = h.call()
    await settle()
    h.advance(expiresAt)
    stall.resolve(allowed)
    expect(await result).toMatchObject({ ok: false, code: "unauthorized" })
    expect(h.requests()).toHaveLength(0)
  })

  test("fails closed when an authorization port rejects", async () => {
    const h = harness({ authorize: async () => { throw new Error("storage") } })
    await h.open()
    expect(await h.call()).toMatchObject({ ok: false, code: "internal_error" })
    expect(h.requests()).toHaveLength(0)
  })

  test("rejects a principal that does not match the connected agent's owner and device", async () => {
    const h = harness()
    await h.open()
    const result = await outcome(h.relay.request({ grant: { grantID: "g", epoch: "e1", resource: "https://r.test/api/mcp/devices/device", accessExpiresAt: expiresAt, principal: { ownerID: "owner", deviceID: "other", clientID: "c" } }, body: "{}", headers: {} }))
    expect(result).toMatchObject({ ok: false, code: "forbidden" })
    expect(h.requests()).toHaveLength(0)
  })

  test("rejects oversize and malformed requests before forwarding", async () => {
    const h = harness()
    await h.open()
    expect(await h.call({ body: "x".repeat(RemoteLimits.maxClientMessageChars) })).toMatchObject({ ok: false, code: "message_too_large" })
    expect(await h.call({ body: "" })).toMatchObject({ ok: false, code: "invalid_message" })
    const badHeader = await outcome(h.relay.request({ grant: h.grant(), body: "{}", headers: { accept: "a\r\nx: y" } }))
    expect(badHeader).toMatchObject({ ok: false, code: "invalid_message" })
    expect(h.requests()).toHaveLength(0)
  })

  test("drops headers outside the allowlist", async () => {
    const h = harness()
    await h.open()
    const result = outcome(h.relay.request({ grant: h.grant(), body: "{}", headers: { accept: "application/json", authorization: "Bearer secret", cookie: "x" } as never }))
    await settle()
    expect(h.requests()[0].value.input.headers).toEqual({ accept: "application/json" })
    expect(JSON.stringify(h.requests()[0].value)).not.toContain("secret")
    h.respond("m1", reply)
    await result
  })
})

describe("gate", () => {
  test("refuses with agent_unavailable without an agent and does not forward before the gate opens", async () => {
    const h = harness()
    expect(await h.call()).toMatchObject({ ok: false, code: "agent_unavailable" })
    await h.relay.setAgent(h.agent())
    expect(await h.call()).toMatchObject({ ok: false, code: "agent_unavailable" })
    expect(h.sent).toHaveLength(0)
  })

  test("refuses with forbidden while off and with unauthorized for a grant from another epoch", async () => {
    const h = harness()
    await h.relay.setAgent(h.agent())
    expect(await h.relay.handleState("a1", state(false))).toBe("acknowledged")
    expect(await h.call()).toMatchObject({ ok: false, code: "forbidden" })
    expect(await h.relay.handleState("a1", state(true, "e2"))).toBe("acknowledged")
    expect(await h.call({ epoch: "e1" })).toMatchObject({ ok: false, code: "unauthorized" })
    expect(h.requests()).toHaveLength(0)
  })

  test("opens only after persistence and revocation settle, then acknowledges", async () => {
    const persisted = deferred<void>()
    const h = harness({ persistState: async () => { h.log.push("persist"); await persisted.promise; h.log.push("persisted") } })
    await h.relay.setAgent(h.agent())
    const control = h.relay.handleState("a1", state(true, "e1", "s9"))
    await settle()
    expect(h.relay.gate()).toMatchObject({ open: false })
    expect(await h.call()).toMatchObject({ ok: false, code: "agent_unavailable" })
    expect(h.frames("mcp.state.ack")).toHaveLength(0)
    persisted.resolve()
    expect(await control).toBe("acknowledged")
    expect(h.frames("mcp.state.ack")[0].value).toEqual({ type: "mcp.state.ack", id: "s9", enabled: true, epoch: "e1" })
    expect(h.relay.gate()).toMatchObject({ open: true, epoch: "e1" })
    expect(h.log.slice(0, 4)).toEqual(["revoke", "persist", "persisted", "send"])
  })

  test("closes the gate before the off persistence settles, revokes grants, then acknowledges", async () => {
    const persisted = deferred<void>()
    const revoked: (string | undefined)[] = []
    const h = harness({
      revokeGrants: async (_device, keep) => { revoked.push(keep); h.log.push("revoke") },
      persistState: async (_agent, value) => { if (!value.enabled) { h.log.push("persist-off"); await persisted.promise } },
    })
    await h.open()
    const off = h.relay.handleState("a1", state(false, "e2", "s2"))
    expect(h.relay.gate()).toMatchObject({ open: false })
    await settle()
    expect(await h.call()).toMatchObject({ ok: false, code: "forbidden" })
    expect(h.frames("mcp.state.ack").map((entry) => entry.value.id)).toEqual(["s1"])
    persisted.resolve()
    expect(await off).toBe("acknowledged")
    expect(h.frames("mcp.state.ack").map((entry) => entry.value)).toContainEqual({ type: "mcp.state.ack", id: "s2", enabled: false, epoch: "e2" })
    expect(revoked.at(-1)).toBeUndefined()
    expect(h.log.indexOf("revoke", h.log.indexOf("persist-off") - 2)).toBeLessThan(h.log.indexOf("persist-off"))
  })

  test("enabling asks the port to keep only grants from the new epoch", async () => {
    const kept: (string | undefined)[] = []
    const h = harness({ revokeGrants: async (_device, keep) => { kept.push(keep) } })
    await h.open("a1", "e7")
    expect(kept).toEqual(["e7"])
  })

  test("off fails dispatched requests as outcome_unknown and queued requests as forbidden, and ignores later responses", async () => {
    const stall = deferred<McpAuthority>()
    let calls = 0
    const h = harness({ authorize: async () => (calls++ === 0 ? allowed : stall.promise) })
    await h.open()
    const sentRequest = h.call()
    await settle()
    const queued = h.call()
    await settle()
    expect(h.requests()).toHaveLength(1)
    await h.relay.handleState("a1", state(false, "e2", "s2"))
    expect(await sentRequest).toMatchObject({ ok: false, code: "outcome_unknown" })
    expect(await queued).toMatchObject({ ok: false, code: "forbidden" })
    expect(h.frames("cancel")).toHaveLength(1)
    expect(h.respond("m1", reply)).toBe("ignored")
    stall.resolve(allowed)
    await settle()
    expect(h.requests()).toHaveLength(1)
  })

  test("off arriving while a request authorizes prevents the send", async () => {
    const authorizing = deferred<McpAuthority>()
    const h = harness({ authorize: async () => authorizing.promise })
    await h.open()
    const result = h.call()
    await settle()
    void h.relay.handleState("a1", state(false, "e2", "s2"))
    authorizing.resolve(allowed)
    expect(await result).toMatchObject({ ok: false, code: "forbidden" })
    expect(h.requests()).toHaveLength(0)
  })

  test("a persistence failure leaves the gate closed without acknowledgment", async () => {
    const h = harness({ persistState: async () => { throw new Error("storage") } })
    await h.relay.setAgent(h.agent())
    expect(await h.relay.handleState("a1", state(true))).toBe("failed")
    expect(h.relay.gate()).toMatchObject({ open: false })
    expect(h.frames("mcp.state.ack")).toHaveLength(0)
  })

  test("a newer control supersedes an older one that is still queued", async () => {
    const persisted = deferred<void>()
    const seen: boolean[] = []
    const h = harness({ persistState: async (_agent, value) => { seen.push(value.enabled); await persisted.promise } })
    await h.relay.setAgent(h.agent())
    const first = h.relay.handleState("a1", state(true, "e1", "s1"))
    await settle()
    const second = h.relay.handleState("a1", state(true, "e2", "s2"))
    const third = h.relay.handleState("a1", state(false, "e3", "s3"))
    persisted.resolve()
    expect(await first).toBe("superseded")
    expect(await second).toBe("superseded")
    expect(await third).toBe("acknowledged")
    expect(seen).toEqual([true, false])
    expect(h.relay.gate()).toMatchObject({ open: false })
    expect(h.frames("mcp.state.ack").map((entry) => entry.value.id)).toEqual(["s3"])
  })
})

describe("agent identity", () => {
  test("ignores controls and responses from a replaced agent and never opens its gate", async () => {
    const h = harness()
    await h.open("a1")
    const pendingOnOld = h.call()
    await settle()
    await h.relay.setAgent(h.agent("a2"))
    expect(await pendingOnOld).toMatchObject({ ok: false, code: "outcome_unknown" })
    expect(await h.relay.handleState("a1", state(true))).toBe("stale")
    expect(h.respond("m1", reply, "a1")).toBe("ignored")
    expect(h.relay.gate()).toMatchObject({ agentID: "a2", open: false })
    expect(await h.call()).toMatchObject({ ok: false, code: "agent_unavailable" })
    expect(h.frames("mcp.state.ack").filter((entry) => entry.agentID === "a1")).toHaveLength(1)
  })

  test("a response from the current agent for a request sent to a replaced agent is ignored", async () => {
    const h = harness()
    await h.open("a1")
    const result = h.call()
    await settle()
    await h.relay.setAgent(h.agent("a2"))
    await result
    expect(h.respond("m1", reply, "a2")).toBe("ignored")
  })

  test("a request authorizing while the agent is replaced is refused and never sent to the new agent", async () => {
    const authorizing = deferred<McpAuthority>()
    const h = harness({ authorize: async () => authorizing.promise })
    await h.open("a1")
    const result = h.call()
    await settle()
    await h.relay.setAgent(h.agent("a2"))
    await h.relay.handleState("a2", state(true))
    authorizing.resolve(allowed)
    expect(await result).toMatchObject({ ok: false, code: "agent_unavailable" })
    expect(h.requests()).toHaveLength(0)
  })

  test("restores the gate from an attachment only after the auth port validates it", async () => {
    const validated: { agent: McpAgent; epoch: string }[] = []
    const h = harness({ validateGate: async (input) => { validated.push(input); return input.epoch === "good" } })
    await h.relay.setAgent(h.agent(), { enabled: true, epoch: "good" })
    expect(h.relay.gate()).toMatchObject({ open: true, epoch: "good" })
    expect(validated).toEqual([{ agent: h.agent(), epoch: "good" }])
    await h.relay.setAgent(h.agent("a2"), { enabled: true, epoch: "stale" })
    expect(h.relay.gate()).toMatchObject({ agentID: "a2", open: false })
    await h.relay.setAgent(h.agent("a3"), { enabled: false, epoch: "good" })
    await h.relay.setAgent(h.agent("a4"))
    expect(validated).toHaveLength(2)
    expect(h.relay.gate()).toMatchObject({ agentID: "a4", open: false })
  })

  test("a restore validation that returns after a control or replacement does not open the gate", async () => {
    const validating = deferred<boolean>()
    const h = harness({ validateGate: async () => validating.promise })
    const restoring = h.relay.setAgent(h.agent(), { enabled: true, epoch: "e1" })
    await h.relay.handleState("a1", state(false, "e2"))
    validating.resolve(true)
    await restoring
    expect(h.relay.gate()).toMatchObject({ open: false })

    const second = deferred<boolean>()
    const g = harness({ validateGate: async () => second.promise })
    const late = g.relay.setAgent(g.agent("a1"), { enabled: true, epoch: "e1" })
    await g.relay.setAgent(g.agent("a2"))
    second.resolve(true)
    await late
    expect(g.relay.gate()).toMatchObject({ agentID: "a2", open: false })
  })

  test("a validation failure leaves the restored gate off", async () => {
    const h = harness({ validateGate: async () => { throw new Error("storage") } })
    await h.relay.setAgent(h.agent(), { enabled: true, epoch: "e1" })
    expect(h.relay.gate()).toMatchObject({ open: false })
  })

  test("agent disconnect fails dispatched requests as outcome_unknown and queued ones as agent_unavailable, without replay", async () => {
    const stall = deferred<McpAuthority>()
    let calls = 0
    const h = harness({ authorize: async () => (calls++ === 0 ? allowed : stall.promise) })
    await h.open()
    const dispatched = h.call()
    await settle()
    const queued = h.call()
    await settle()
    expect(h.relay.clearAgent("a1")).toBe(true)
    expect(await dispatched).toMatchObject({ ok: false, code: "outcome_unknown" })
    expect(await queued).toMatchObject({ ok: false, code: "agent_unavailable" })
    stall.resolve(allowed)
    await h.relay.setAgent(h.agent("a2"))
    await h.relay.handleState("a2", state(true))
    await settle()
    expect(h.requests()).toHaveLength(1)
    expect(h.relay.clearAgent("a1")).toBe(false)
  })

  test("revoke fails only requests of the revoked grant", async () => {
    const h = harness()
    await h.open()
    const revoked = h.call({ grantID: "g-revoked", clientID: "c1" })
    const kept = h.call({ grantID: "g-kept", clientID: "c2" })
    await settle()
    expect(h.relay.revoke({ deviceID: "device", grantID: "g-revoked" })).toBe(1)
    expect(await revoked).toMatchObject({ ok: false, code: "outcome_unknown" })
    h.respond("m2", reply)
    expect(await kept).toEqual({ ok: true, value: reply })
    const all = h.call()
    await settle()
    expect(h.relay.revoke({ deviceID: "device" })).toBe(1)
    expect(await all).toMatchObject({ ok: false, code: "outcome_unknown" })
  })
})

describe("admission order", () => {
  test("a stalled first request is not overtaken, and the slot is released after send rather than after the response", async () => {
    const stall = deferred<McpAuthority>()
    let calls = 0
    const h = harness({ authorize: async () => (calls++ === 0 ? stall.promise : allowed) })
    await h.open()
    const first = h.call({ clientID: "c1" })
    const second = h.call({ clientID: "c2" })
    await settle()
    expect(h.requests()).toHaveLength(0)
    stall.resolve(allowed)
    await settle()
    expect(h.requests().map((entry) => entry.value.id)).toEqual(["m1", "m2"])
    h.respond("m2", reply)
    expect(await second).toEqual({ ok: true, value: reply })
    h.respond("m1", reply)
    expect(await first).toEqual({ ok: true, value: reply })
  })

  test("a request that times out while its authorization stalls releases the admission slot", async () => {
    const stall = deferred<McpAuthority>()
    let calls = 0
    const h = harness({ authorize: async () => (calls++ === 0 ? stall.promise : allowed), timeoutMs: 15 })
    await h.open()
    const first = h.call()
    await settle()
    expect(await first).toMatchObject({ ok: false, code: "agent_unavailable" })
    const second = h.call()
    await settle()
    expect(h.requests().map((entry) => entry.value.id)).toEqual(["m2"])
    h.respond("m2", reply)
    await second
    stall.resolve(allowed)
    await settle()
    expect(h.requests()).toHaveLength(1)
  })
})

describe("limits", () => {
  test("caps in-flight requests per OAuth client and frees capacity when they settle", async () => {
    const h = harness()
    await h.open()
    const calls = Array.from({ length: RemoteLimits.maxPendingRequestsPerClient }, () => h.call({ clientID: "busy" }))
    await settle()
    expect(h.requests()).toHaveLength(RemoteLimits.maxPendingRequestsPerClient)
    expect(await h.call({ clientID: "busy" })).toMatchObject({ ok: false, code: "rate_limited" })
    const other = h.call({ clientID: "calm" })
    await settle()
    expect(h.requests()).toHaveLength(RemoteLimits.maxPendingRequestsPerClient + 1)
    h.respond("m1", reply)
    await calls[0]
    const again = h.call({ clientID: "busy" })
    await settle()
    expect(h.requests()).toHaveLength(RemoteLimits.maxPendingRequestsPerClient + 2)
    h.relay.clearAgent("a1")
    await Promise.all([...calls, other, again])
  })

  test("limits each client's request rate per window and resets with the window", async () => {
    const h = harness()
    await h.open()
    for (let index = 1; index <= RemoteLimits.maxClientRequestsPerWindow; index++) {
      const result = h.call({ clientID: "fast" })
      await settle()
      h.respond(`m${index}`, reply)
      expect(await result).toMatchObject({ ok: true })
    }
    expect(await h.call({ clientID: "fast" })).toMatchObject({ ok: false, code: "rate_limited" })
    const other = h.call({ clientID: "slow" })
    await settle()
    h.respond(`m${RemoteLimits.maxClientRequestsPerWindow + 1}`, reply)
    expect(await other).toMatchObject({ ok: true })
    h.advance(RemoteLimits.clientRateWindowMs)
    const next = h.call({ clientID: "fast" })
    await settle()
    h.respond(`m${RemoteLimits.maxClientRequestsPerWindow + 2}`, reply)
    expect(await next).toMatchObject({ ok: true })
  })
})

describe("responses", () => {
  test("reassembles ordered chunks into one complete response", async () => {
    const h = harness()
    await h.open()
    const result = h.call()
    await settle()
    const text = JSON.stringify({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "x".repeat(400) } }) })
    const parts = [text.slice(0, 100), text.slice(100, 300), text.slice(300)]
    parts.forEach((value, index) => {
      expect(h.relay.handleResponse("a1", { type: "response", id: "m1", ok: true, value, chunk: { index, last: index === 2 } })).toBe("accepted")
    })
    expect(await result).toEqual({ ok: true, value: JSON.parse(text) })
  })

  test("passes an explicit agent failure through with its code", async () => {
    const h = harness()
    await h.open()
    const result = h.call()
    await settle()
    h.relay.handleResponse("a1", { type: "response", id: "m1", ok: false, error: { code: "unknown_operation", message: "update the machine" } })
    expect(await result).toEqual({ ok: false, code: "unknown_operation", message: "update the machine" })
  })

  test.each([
    ["out-of-order chunk", { index: 1, last: false }, "x", "internal_error"],
    ["oversized slice", { index: 0, last: false }, "x".repeat(RemoteLimits.maxAgentMessageChars + 1), "message_too_large"],
    ["invalid final text", { index: 0, last: true }, "not json", "internal_error"],
    ["invalid response shape", { index: 0, last: true }, JSON.stringify({ status: 99, contentType: "application/json", body: "" }), "internal_error"],
  ])("a %s fails the request, cancels the agent and reports a violation", async (_name, chunk, value, code) => {
    const h = harness()
    await h.open()
    const result = h.call()
    await settle()
    expect(h.relay.handleResponse("a1", { type: "response", id: "m1", ok: true, value, chunk })).toBe("violation")
    expect(await result).toMatchObject({ ok: false, code })
    expect(h.frames("cancel")[0].value).toEqual({ type: "cancel", id: "m1" })
  })

  test("more chunks than the response bound fail with message_too_large and no partial result", async () => {
    const h = harness()
    await h.open()
    const result = h.call()
    await settle()
    let verdict: string = "accepted"
    for (let index = 0; index < RemoteLimits.maxChunksPerResponse && verdict === "accepted"; index++)
      verdict = h.relay.handleResponse("a1", { type: "response", id: "m1", ok: true, value: "x", chunk: { index, last: false } })
    expect(verdict).toBe("accepted")
    expect(h.relay.handleResponse("a1", { type: "response", id: "m1", ok: true, value: "x", chunk: { index: RemoteLimits.maxChunksPerResponse, last: true } })).toBe("violation")
    expect(await result).toMatchObject({ ok: false, code: "message_too_large" })
  })

  test("a failure after chunks and an unchunked value after chunks are violations", async () => {
    const h = harness()
    await h.open()
    const first = h.call()
    await settle()
    h.relay.handleResponse("a1", { type: "response", id: "m1", ok: true, value: "{", chunk: { index: 0, last: false } })
    const failure: RemoteResponse = { type: "response", id: "m1", ok: false, error: { code: "internal_error", message: "late" } }
    expect(h.relay.handleResponse("a1", failure)).toBe("violation")
    expect(await first).toMatchObject({ ok: false })
    const second = h.call()
    await settle()
    h.relay.handleResponse("a1", { type: "response", id: "m2", ok: true, value: "{", chunk: { index: 0, last: false } })
    expect(h.relay.handleResponse("a1", { type: "response", id: "m2", ok: true, value: reply })).toBe("violation")
    expect(await second).toMatchObject({ ok: false })
  })

  test("a non-response value, unknown id, and a settled request's response are ignored or refused", async () => {
    const h = harness()
    await h.open()
    expect(h.respond("nope", reply)).toBe("ignored")
    const result = h.call()
    await settle()
    expect(h.respond("m1", { status: 200, contentType: "application/json" })).toBe("violation")
    expect(await result).toMatchObject({ ok: false, code: "internal_error" })
    expect(h.respond("m1", reply)).toBe("ignored")
  })

  test("accepts an empty JSON acknowledgment and refuses any other content type", async () => {
    const h = harness()
    await h.open()
    const ack = h.call()
    await settle()
    h.respond("m1", { status: 202, contentType: "application/json", body: "" })
    expect(await ack).toEqual({ ok: true, value: { status: 202, contentType: "application/json", body: "" } })
    for (const [index, contentType] of ["text/event-stream", "", "text/html"].entries()) {
      const result = h.call()
      await settle()
      expect(h.respond(`m${index + 2}`, { status: 200, contentType, body: "x" })).toBe("violation")
      expect(await result).toMatchObject({ ok: false, code: "internal_error" })
    }
  })
})

describe("cancellation and timeout", () => {
  test("an abort before the send settles the request as agent_unavailable and never sends it", async () => {
    const stall = deferred<McpAuthority>()
    const h = harness({ authorize: async () => stall.promise })
    await h.open()
    const controller = new AbortController()
    const result = h.call({ signal: controller.signal })
    await settle()
    controller.abort()
    expect(await result).toMatchObject({ ok: false, code: "agent_unavailable" })
    stall.resolve(allowed)
    await settle()
    expect(h.sent.filter((entry) => JSON.parse(entry.frame).type !== "mcp.state.ack")).toHaveLength(0)
  })

  test("an already aborted signal is refused without any port call", async () => {
    const h = harness()
    await h.open()
    const controller = new AbortController()
    controller.abort()
    expect(await h.call({ signal: controller.signal })).toMatchObject({ ok: false, code: "agent_unavailable" })
    expect(h.log).not.toContain("authorize")
  })

  test("an abort after the send cancels at the agent, reports outcome_unknown and ignores the late response", async () => {
    const h = harness()
    await h.open()
    const controller = new AbortController()
    const result = h.call({ signal: controller.signal })
    await settle()
    controller.abort()
    expect(await result).toMatchObject({ ok: false, code: "outcome_unknown" })
    expect(h.frames("cancel")[0]).toMatchObject({ agentID: "a1", value: { type: "cancel", id: "m1" } })
    expect(h.respond("m1", reply)).toBe("ignored")
    expect(h.requests()).toHaveLength(1)
  })

  test("a timeout after the send cancels at the agent and reports outcome_unknown", async () => {
    const h = harness({ timeoutMs: 15 })
    await h.open()
    const result = await h.call()
    expect(result).toMatchObject({ ok: false, code: "outcome_unknown" })
    expect(h.frames("cancel")).toHaveLength(1)
  })

  test("settled requests free their in-flight slot and timer", async () => {
    const h = harness({ timeoutMs: 15 })
    await h.open()
    const first = h.call({ clientID: "c" })
    await settle()
    h.respond("m1", reply)
    await first
    await new Promise((done) => setTimeout(done, 40))
    expect(h.frames("cancel")).toHaveLength(0)
  })
})
