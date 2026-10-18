import { describe, expect, test } from "bun:test"
import { decodeLossless, decodeStrict, mcp_request_RequestSchema } from "../../../packages/protocol/src/v5"
import { ReservationBudget } from "../../../packages/protocol/src/v5/connection"
import { McpLimits } from "../../../packages/remote/src/index"
import { McpRelayError, createMcpRelay } from "../src/relay/mcp"
import type { McpAgent, McpAuthority, McpGrant, McpRelayDeps, McpState } from "../src/relay/mcp"

const agentInfo: McpAgent = { agentID: "agent-1", ownerID: "owner", deviceID: "device" }
const principal = { ownerID: "owner", deviceID: "device", clientID: "https://client.example.invalid/client.json" }
const grant: McpGrant = { grantID: "grant", epoch: "e1", resource: "https://relay.example.invalid/api/mcp/devices/device", accessExpiresAt: 10_000, principal }
const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
const ok = { status: 200, contentType: "application/json", body: '{"jsonrpc":"2.0","id":1,"result":{}}' }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function world(overrides: Partial<McpRelayDeps> = {}) {
  let now = 1_000
  const calls = { authorize: 0, authorizeDevice: 0, revoke: [] as (string | undefined)[], persisted: [] as McpState[] }
  const authority: { grant: McpAuthority; device: McpAuthority } = { grant: { ok: true }, device: { ok: true } }
  const reservation = new ReservationBudget(32 * 1024 * 1024)
  const relay = createMcpRelay({
    now: () => now,
    timeoutMs: 1_000,
    reservation,
    authorize: async () => { calls.authorize++; return authority.grant },
    authorizeDevice: async () => { calls.authorizeDevice++; return authority.device },
    revokeGrants: async (_deviceID, keep) => { calls.revoke.push(keep) },
    persistState: async (_deviceID, state) => { calls.persisted.push(state) },
    ...overrides,
  })
  const port = (info = agentInfo) => {
    const sent: Uint8Array[] = []
    const cancelled: string[] = []
    const acks: McpState[] = []
    const state = { transmitted: true, refuse: false }
    relay.setAgent(info, {
      request: (payload) => {
        if (state.refuse) return undefined
        sent.push(payload)
        return String(sent.length)
      },
      cancel: (requestID) => { cancelled.push(requestID); return state.transmitted ? "unknown" : "unsent" },
      acknowledge: (value) => acks.push(value),
    })
    return { sent, cancelled, acks, state, info }
  }
  const open = async (info = agentInfo, epoch = "e1") => {
    const agent = port(info)
    expect(await relay.handleState(info.agentID, { id: "state", enabled: true, epoch })).toBe("acknowledged")
    return agent
  }
  const outcome = (promise: Promise<unknown>) => promise.then((value) => value, (error: unknown) => error)
  return { relay, calls, authority, reservation, port, open, outcome, advance: (ms: number) => { now += ms } }
}

const failure = (code: string) => expect.objectContaining({ name: "McpRelayError", code })

describe("forwarding", () => {
  test("sends one request carrying only the verified principal, epoch, allowlisted headers and body", async () => {
    const value = world()
    const agent = await value.open()
    const pending = value.relay.request({ grant, body, headers: { "content-type": "application/json", "mcp-method": "tools/list" } })
    await settle()
    expect(agent.sent).toHaveLength(1)
    const payload = decodeStrict(mcp_request_RequestSchema, agent.sent[0]!).payload!
    expect(decodeLossless(payload.body!)).toBe(body)
    expect(payload.headers.map((header) => [header.name, decodeLossless(header.value!)])).toEqual([["content-type", "application/json"], ["mcp-method", "tools/list"]])
    expect([payload.principal!.ownerID, payload.principal!.deviceID, decodeLossless(payload.principal!.clientID!), payload.epoch]).toEqual(["owner", "device", principal.clientID, "e1"])
    expect(value.relay.complete(agentInfo.agentID, "1", { type: "response", response: ok })).toBe(true)
    expect(await pending).toEqual(ok)
  })

  test("verifies the grant and the device before every send, uncached", async () => {
    const value = world()
    const agent = await value.open()
    for (const index of [1, 2]) {
      const pending = value.relay.request({ grant, body, headers: {} })
      await settle()
      value.relay.complete(agentInfo.agentID, String(index), { type: "response", response: ok })
      await pending
    }
    expect([value.calls.authorize, value.calls.authorizeDevice, agent.sent.length]).toEqual([2, 2, 2])
  })

  test.each([
    ["grant", "unauthorized"],
    ["device", "forbidden"],
  ] as const)("a failed %s authority refuses without sending", async (kind, code) => {
    const value = world()
    const agent = await value.open()
    value.authority[kind] = { ok: false, reason: "revoked" }
    expect(await value.outcome(value.relay.request({ grant, body, headers: {} }))).toEqual(failure(code))
    expect(agent.sent).toEqual([])
  })

  test("a rejecting authorization port fails closed", async () => {
    const value = world({ authorize: () => Promise.reject(new Error("synthetic")) })
    const agent = await value.open()
    expect(await value.outcome(value.relay.request({ grant, body, headers: {} }))).toEqual(failure("internal_error"))
    expect(agent.sent).toEqual([])
  })

  test("an expired access credential and a principal of another owner or device are refused", async () => {
    const value = world()
    const agent = await value.open()
    value.advance(10_000)
    expect(await value.outcome(value.relay.request({ grant, body, headers: {} }))).toEqual(failure("unauthorized"))
    for (const other of [{ ownerID: "intruder" }, { deviceID: "other" }])
      expect(await value.outcome(value.relay.request({ grant: { ...grant, accessExpiresAt: 99_999, principal: { ...principal, ...other } }, body, headers: {} }))).toEqual(failure("forbidden"))
    expect(agent.sent).toEqual([])
  })

  test("oversized and malformed forwards are refused before authorization or dispatch", async () => {
    const value = world()
    const agent = await value.open()
    expect(await value.outcome(value.relay.request({ grant, body: "x".repeat(McpLimits.bodyChars + 1), headers: {} }))).toEqual(failure("message_too_large"))
    expect(await value.outcome(value.relay.request({ grant, body: "", headers: {} }))).toEqual(failure("invalid_message"))
    expect(await value.outcome(value.relay.request({ grant: { ...grant, epoch: "e1/../x" }, body, headers: {} }))).toEqual(failure("unauthorized"))
    expect([value.calls.authorize, agent.sent.length]).toEqual([0, 0])
  })

  test("headers outside the allowlist never reach the agent", async () => {
    const value = world()
    const agent = await value.open()
    const headers = { accept: "application/json", authorization: "Bearer synthetic", cookie: "a=b" } as Record<string, string>
    void value.outcome(value.relay.request({ grant, body, headers }))
    await settle()
    expect(decodeStrict(mcp_request_RequestSchema, agent.sent[0]!).payload!.headers.map((header) => header.name)).toEqual(["accept"])
  })
})

describe("gate", () => {
  test("is unavailable without an agent and until the agent states its gate", async () => {
    const value = world()
    expect(await value.outcome(value.relay.request({ grant, body, headers: {} }))).toEqual(failure("agent_unavailable"))
    const agent = value.port()
    expect(value.relay.gate()?.state).toBe("unknown")
    expect(await value.outcome(value.relay.request({ grant, body, headers: {} }))).toEqual(failure("agent_unavailable"))
    expect(agent.sent).toEqual([])
  })

  test("off refuses as forbidden and a grant from another epoch as unauthorized", async () => {
    const value = world()
    const agent = value.port()
    expect(await value.relay.handleState(agentInfo.agentID, { id: "s", enabled: false, epoch: "e1" })).toBe("acknowledged")
    expect(await value.outcome(value.relay.request({ grant, body, headers: {} }))).toEqual(failure("forbidden"))
    expect(await value.relay.handleState(agentInfo.agentID, { id: "s", enabled: true, epoch: "e2" })).toBe("acknowledged")
    expect(await value.outcome(value.relay.request({ grant, body, headers: {} }))).toEqual(failure("unauthorized"))
    expect(agent.sent).toEqual([])
  })

  test("opens only after revocation and persistence settle, then acknowledges the exact state", async () => {
    const persisted = Promise.withResolvers<void>()
    const value = world({ persistState: () => persisted.promise })
    const agent = value.port()
    const turn = value.relay.handleState(agentInfo.agentID, { id: "s1", enabled: true, epoch: "e1" })
    await settle()
    expect(value.relay.gate()?.state).toBe("enabling")
    expect(agent.acks).toEqual([])
    expect(await value.outcome(value.relay.request({ grant, body, headers: {} }))).toEqual(failure("agent_unavailable"))
    persisted.resolve()
    expect(await turn).toBe("acknowledged")
    expect(value.relay.gate()).toMatchObject({ state: "open", epoch: "e1" })
    expect(agent.acks).toEqual([{ id: "s1", enabled: true, epoch: "e1" }])
    expect(value.calls.revoke).toEqual(["e1"])
  })

  test("off closes the gate before persistence, revokes every device grant, then acknowledges", async () => {
    const value = world()
    const agent = await value.open()
    const turn = value.relay.handleState(agentInfo.agentID, { id: "s2", enabled: false, epoch: "e1" })
    expect(value.relay.gate()?.state).toBe("off")
    expect(await turn).toBe("acknowledged")
    expect(value.calls.revoke).toEqual(["e1", undefined])
    expect(agent.acks.at(-1)).toEqual({ id: "s2", enabled: false, epoch: "e1" })
  })

  test("off fails a dispatched request as outcome_unknown after cancelling it, and ignores its late response", async () => {
    const value = world()
    const agent = await value.open()
    const pending = value.outcome(value.relay.request({ grant, body, headers: {} }))
    await settle()
    await value.relay.handleState(agentInfo.agentID, { id: "s", enabled: false, epoch: "e1" })
    expect(await pending).toEqual(failure("outcome_unknown"))
    expect(agent.cancelled).toEqual(["1"])
    expect(value.relay.complete(agentInfo.agentID, "1", { type: "response", response: ok })).toBe(false)
  })

  test("off while a request authorizes prevents its send", async () => {
    const gate = Promise.withResolvers<McpAuthority>()
    const value = world({ authorize: () => gate.promise })
    const agent = await value.open()
    const pending = value.outcome(value.relay.request({ grant, body, headers: {} }))
    await value.relay.handleState(agentInfo.agentID, { id: "s", enabled: false, epoch: "e1" })
    gate.resolve({ ok: true })
    expect(await pending).toEqual(failure("forbidden"))
    expect(agent.sent).toEqual([])
  })

  test("a persistence failure leaves the gate closed without acknowledgment", async () => {
    const value = world({ persistState: () => Promise.reject(new Error("synthetic")) })
    const agent = value.port()
    expect(await value.relay.handleState(agentInfo.agentID, { id: "s", enabled: true, epoch: "e1" })).toBe("failed")
    expect(value.relay.gate()?.state).toBe("enabling")
    expect(agent.acks).toEqual([])
  })

  test("a newer state supersedes an older one that is still persisting", async () => {
    const first = Promise.withResolvers<void>()
    let calls = 0
    const value = world({ persistState: () => (++calls === 1 ? first.promise : Promise.resolve()) })
    const agent = value.port()
    const older = value.relay.handleState(agentInfo.agentID, { id: "old", enabled: true, epoch: "e1" })
    const newer = value.relay.handleState(agentInfo.agentID, { id: "new", enabled: false, epoch: "e1" })
    first.resolve()
    expect([await older, await newer]).toEqual(["superseded", "acknowledged"])
    expect(agent.acks).toEqual([{ id: "new", enabled: false, epoch: "e1" }])
    expect(value.relay.gate()?.state).toBe("off")
  })
})

describe("agent identity", () => {
  test("a replaced agent's state and responses are ignored and its sent work becomes outcome_unknown", async () => {
    const value = world()
    await value.open()
    const pending = value.outcome(value.relay.request({ grant, body, headers: {} }))
    await settle()
    const next = value.port({ ...agentInfo, agentID: "agent-2" })
    expect(await pending).toEqual(failure("outcome_unknown"))
    expect(await value.relay.handleState(agentInfo.agentID, { id: "s", enabled: true, epoch: "e1" })).toBe("stale")
    expect(value.relay.complete(agentInfo.agentID, "1", { type: "response", response: ok })).toBe(false)
    expect(value.relay.gate()).toMatchObject({ agentID: "agent-2", state: "unknown" })
    expect(next.sent).toEqual([])
  })

  test("a request authorizing while the agent is replaced is refused and never sent to the new agent", async () => {
    const gate = Promise.withResolvers<McpAuthority>()
    const value = world({ authorize: () => gate.promise })
    await value.open()
    const pending = value.outcome(value.relay.request({ grant, body, headers: {} }))
    const next = await value.open({ ...agentInfo, agentID: "agent-2" })
    gate.resolve({ ok: true })
    expect(await pending).toEqual(failure("agent_unavailable"))
    expect(next.sent).toEqual([])
  })

  test("disconnect fails dispatched work as outcome_unknown and admitted unsent work as agent_unavailable, without replay", async () => {
    const gate = Promise.withResolvers<McpAuthority>()
    let calls = 0
    const value = world({ authorize: () => (++calls === 1 ? Promise.resolve({ ok: true }) : gate.promise) })
    const agent = await value.open()
    const sent = value.outcome(value.relay.request({ grant, body, headers: {} }))
    await settle()
    const queued = value.outcome(value.relay.request({ grant, body, headers: {} }))
    expect(value.relay.clearAgent(agentInfo.agentID)).toBe(true)
    expect(await sent).toEqual(failure("outcome_unknown"))
    expect(await queued).toEqual(failure("agent_unavailable"))
    gate.resolve({ ok: true })
    await settle()
    expect(agent.sent).toHaveLength(1)
    expect(agent.cancelled).toEqual([])
    expect(value.relay.clearAgent(agentInfo.agentID)).toBe(false)
  })

  test("a port that cannot hand off the request settles it as agent_unavailable", async () => {
    const value = world()
    const agent = await value.open()
    agent.state.refuse = true
    expect(await value.outcome(value.relay.request({ grant, body, headers: {} }))).toEqual(failure("agent_unavailable"))
  })
})

describe("admission and limits", () => {
  test("a stalled first request is not overtaken, and admission releases after send rather than after the response", async () => {
    const gate = Promise.withResolvers<McpAuthority>()
    let calls = 0
    const value = world({ authorize: () => (++calls === 1 ? gate.promise : Promise.resolve({ ok: true })) })
    const agent = await value.open()
    void value.outcome(value.relay.request({ grant, body: '{"first":1}', headers: {} }))
    void value.outcome(value.relay.request({ grant, body: '{"second":2}', headers: {} }))
    await settle()
    expect(agent.sent).toEqual([])
    gate.resolve({ ok: true })
    await settle()
    await settle()
    expect(agent.sent.map((bytes) => decodeLossless(decodeStrict(mcp_request_RequestSchema, bytes).payload!.body!))).toEqual(['{"first":1}', '{"second":2}'])
  })

  test("caps in-flight requests per OAuth client and frees capacity when they settle", async () => {
    const value = world({ timeoutMs: 60_000 })
    const agent = await value.open()
    const pending = Array.from({ length: McpLimits.pendingPerClient }, () => value.outcome(value.relay.request({ grant, body, headers: {} })))
    expect(await value.outcome(value.relay.request({ grant, body, headers: {} }))).toEqual(failure("rate_limited"))
    const other = value.outcome(value.relay.request({ grant: { ...grant, principal: { ...principal, clientID: "other" } }, body, headers: {} }))
    await settle()
    expect(agent.sent).toHaveLength(McpLimits.pendingPerClient + 1)
    value.relay.complete(agentInfo.agentID, "1", { type: "response", response: ok })
    expect(await pending[0]).toEqual(ok)
    const freed = value.outcome(value.relay.request({ grant, body, headers: {} }))
    await settle()
    expect(agent.sent).toHaveLength(McpLimits.pendingPerClient + 2)
    value.relay.clearAgent(agentInfo.agentID)
    expect(await Promise.all([other, freed, ...pending.slice(1)])).toEqual(Array.from({ length: McpLimits.pendingPerClient + 1 }, () => failure("outcome_unknown")))
  })

  test("limits each client's request rate per window and resets with the window", async () => {
    const value = world()
    const agent = await value.open()
    agent.state.refuse = true
    const live = { ...grant, accessExpiresAt: 1e15 }
    for (let index = 0; index < McpLimits.requestsPerWindow; index++)
      expect(await value.outcome(value.relay.request({ grant: live, body, headers: {} }))).toEqual(failure("agent_unavailable"))
    expect(await value.outcome(value.relay.request({ grant: live, body, headers: {} }))).toEqual(failure("rate_limited"))
    value.advance(McpLimits.rateWindowMs)
    expect(await value.outcome(value.relay.request({ grant: live, body, headers: {} }))).toEqual(failure("agent_unavailable"))
  })
})

describe("responses", () => {
  const sent = async () => {
    const value = world()
    const agent = await value.open()
    const pending = value.outcome(value.relay.request({ grant, body, headers: {} }))
    await settle()
    return { value, agent, pending }
  }

  test("passes an explicit agent failure through with its code", async () => {
    const run = await sent()
    run.value.relay.complete(agentInfo.agentID, "1", { type: "error", code: "not_found", message: "Session missing" })
    expect(await run.pending).toEqual(expect.objectContaining({ code: "not_found", message: "Session missing" }))
  })

  test("accepts an empty JSON acknowledgment", async () => {
    const run = await sent()
    run.value.relay.complete(agentInfo.agentID, "1", { type: "response", response: { status: 202, contentType: "application/json", body: "" } })
    expect(await run.pending).toEqual({ status: 202, contentType: "application/json", body: "" })
  })

  test.each([
    { status: 199, contentType: "application/json", body: "{}" },
    { status: 200, contentType: "text/event-stream", body: "{}" },
    { status: 200, contentType: "application/json; charset=latin1", body: "{}" },
  ])("refuses an invalid response %#", async (response) => {
    const run = await sent()
    run.value.relay.complete(agentInfo.agentID, "1", { type: "response", response })
    expect(await run.pending).toEqual(failure("internal_error"))
  })

  test("a protocol violation cancels at the agent and settles with its code, never partial success", async () => {
    const run = await sent()
    run.value.relay.complete(agentInfo.agentID, "1", { type: "violation", code: "message_too_large", message: "MCP response exceeds the relay bound" })
    expect(await run.pending).toEqual(failure("message_too_large"))
    expect(run.agent.cancelled).toEqual(["1"])
  })

  test("an unknown or already settled request is not owned", async () => {
    const run = await sent()
    expect(run.value.relay.owns(agentInfo.agentID, "9")).toBe(false)
    expect(run.value.relay.owns(agentInfo.agentID, "1")).toBe(true)
    run.value.relay.complete(agentInfo.agentID, "1", { type: "response", response: ok })
    expect(run.value.relay.owns(agentInfo.agentID, "1")).toBe(false)
    expect(run.value.relay.complete(agentInfo.agentID, "1", { type: "response", response: ok })).toBe(false)
  })
})

describe("cancellation and timeout", () => {
  test("an already aborted signal is refused without authorization", async () => {
    const value = world()
    await value.open()
    expect(await value.outcome(value.relay.request({ grant, body, headers: {}, signal: AbortSignal.abort() }))).toEqual(failure("agent_unavailable"))
    expect(value.calls.authorize).toBe(0)
  })

  test("an abort before the send settles as agent_unavailable and never sends", async () => {
    const gate = Promise.withResolvers<McpAuthority>()
    const value = world({ authorize: () => gate.promise })
    const agent = await value.open()
    const controller = new AbortController()
    const pending = value.outcome(value.relay.request({ grant, body, headers: {}, signal: controller.signal }))
    controller.abort()
    expect(await pending).toEqual(failure("agent_unavailable"))
    gate.resolve({ ok: true })
    await settle()
    expect(agent.sent).toEqual([])
  })

  test.each([
    [true, "outcome_unknown"],
    [false, "agent_unavailable"],
  ] as const)("an abort after handoff cancels at the agent (transmitted %p reports %s) and ignores the late response", async (transmitted, code) => {
    const value = world()
    const agent = await value.open()
    agent.state.transmitted = transmitted
    const controller = new AbortController()
    const pending = value.outcome(value.relay.request({ grant, body, headers: {}, signal: controller.signal }))
    await settle()
    controller.abort()
    expect(await pending).toEqual(failure(code))
    expect(agent.cancelled).toEqual(["1"])
    expect(value.relay.complete(agentInfo.agentID, "1", { type: "response", response: ok })).toBe(false)
  })

  test("a timeout after the send cancels at the agent and reports outcome_unknown", async () => {
    const value = world({ timeoutMs: 5 })
    const agent = await value.open()
    const pending = value.outcome(value.relay.request({ grant, body, headers: {} }))
    expect(await pending).toEqual(failure("outcome_unknown"))
    expect(agent.cancelled).toEqual(["1"])
  })

  test("every settled request releases its retained payload reservation", async () => {
    const value = world()
    const agent = await value.open()
    const pending = value.outcome(value.relay.request({ grant, body, headers: {} }))
    await settle()
    expect(value.reservation.used).toBe(agent.sent[0]!.length)
    value.relay.complete(agentInfo.agentID, "1", { type: "response", response: ok })
    await pending
    expect(value.reservation.used).toBe(0)
  })

  test("an exhausted relay reservation refuses the request before authorization", async () => {
    const value = world()
    const agent = await value.open()
    expect(value.reservation.reserve(value.reservation.limit)).toBe(true)
    expect(await value.outcome(value.relay.request({ grant, body, headers: {} }))).toEqual(failure("rate_limited"))
    expect([value.calls.authorize, agent.sent.length, value.reservation.used]).toEqual([0, 0, value.reservation.limit])
  })

  test("errors are typed relay errors", async () => {
    const value = world()
    expect(await value.outcome(value.relay.request({ grant, body, headers: {} }))).toBeInstanceOf(McpRelayError)
  })
})
