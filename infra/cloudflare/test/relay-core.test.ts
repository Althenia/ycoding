import { describe, expect, test } from "bun:test"
import { RemoteLimits, RemoteProtocolVersion } from "../../../packages/remote/src/index"
import { createRelay, type RelayConnection, type RelayDeps } from "../src/relay/core"

type Sent = { readonly connectionID: string; readonly message: string }
type Closed = { readonly connectionID: string; readonly code: number; readonly reason: string }
type Authority = { ok: true } | { ok: false; reason: string }

function harness(options: { readonly sessions?: readonly string[]; readonly authorityTtlMs?: number } = {}) {
  let now = 1_000_000
  let idSequence = 0
  const sent: Sent[] = []
  const closed: Closed[] = []
  const storedSubscriptions = new Map<string, readonly string[]>()
  const storedPending = new Map<string, readonly { relayID: string; clientID: string }[]>()
  let advertisement: readonly string[] = options.sessions ?? ["ses_a"]
  let clientAuthority: Authority = { ok: true }
  let agentAuthority: Authority = { ok: true }
  let authorityReads = 0
  let readClientAuthority: (call: number) => Promise<Authority> = async () => clientAuthority

  const deps: RelayDeps = {
    now: () => now,
    newID: () => `r${(idSequence += 1)}`,
    send: (connectionID, message) => sent.push({ connectionID, message }),
    close: (connectionID, code, reason) => closed.push({ connectionID, code, reason }),
    saveSubscriptions: (connectionID, values) => storedSubscriptions.set(connectionID, values),
    savePending: (connectionID, values) => storedPending.set(connectionID, values),
    authorizeClientCommand: async () => {
      authorityReads += 1
      return readClientAuthority(authorityReads)
    },
    authorizeAgentCommand: async () => agentAuthority,
    authorityTtlMs: options.authorityTtlMs ?? 0,
  }

  const relay = createRelay(deps)
  return {
    relay,
    sent,
    closed,
    storedSubscriptions,
    storedPending,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
    at: () => now,
    setClientAuthority: (value: Authority) => {
      clientAuthority = value
    },
    setClientAuthorityRead: (read: (call: number) => Promise<Authority>) => {
      readClientAuthority = read
    },
    authorityReads: () => authorityReads,
    setAgentAuthority: (value: Authority) => {
      agentAuthority = value
    },
    advertised: () => advertisement,
    messagesTo: (connectionID: string) =>
      sent
        .filter((entry) => entry.connectionID === connectionID)
        .map((entry) => JSON.parse(entry.message) as Record<string, unknown>),
    requestsTo: (connectionID: string) =>
      sent
        .filter((entry) => entry.connectionID === connectionID)
        .map((entry) => JSON.parse(entry.message) as Record<string, unknown>)
        .filter((message) => message.type === "request"),
    reset: () => {
      sent.length = 0
      closed.length = 0
    },
  }
}

function client(connectionID: string, browserSessionID = "sess-1"): RelayConnection {
  return {
    connectionID,
    role: "client",
    ownerID: "usr_1",
    deviceID: "dev_1",
    browserSessionID,
    credentialExpiresAt: 10_000_000,
    subscriptions: [],
    pending: [],
  }
}

function agent(connectionID: string): RelayConnection {
  return {
    connectionID,
    role: "agent",
    ownerID: "usr_1",
    deviceID: "dev_1",
    browserSessionID: "dev_1",
    credentialExpiresAt: 10_000_000,
    subscriptions: [],
    pending: [],
  }
}

const request = (id: string, operation: string, sessionID?: string, input?: unknown) =>
  JSON.stringify({
    type: "request",
    id,
    operation,
    ...(sessionID === undefined ? {} : { sessionID }),
    ...(input === undefined ? {} : { input }),
  })

const response = (id: string, value: unknown, chunk?: { index: number; last: boolean }) =>
  JSON.stringify({ type: "response", id, ok: true, value, ...(chunk === undefined ? {} : { chunk }) })

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function attachBoth(h: ReturnType<typeof harness>) {
  await h.relay.attach(agent("agent-1"))
  await h.relay.attach(client("client-1"))
  h.reset()
}

describe("relay core: role separation", () => {
  test("closes a client that sends agent-only frames and an agent that sends requests", async () => {
    const h = harness()
    await attachBoth(h)

    await h.relay.handleClientMessage("client-1", JSON.stringify({ type: "event", sessionID: "ses_a", event: {} }))
    expect(h.closed).toEqual([{ connectionID: "client-1", code: 1003, reason: "Frame is not valid for this connection" }])

    await h.relay.handleAgentMessage("agent-1", request("1", "session.list"))
    expect(h.closed[1]).toEqual({ connectionID: "agent-1", code: 1003, reason: "Frame is not valid for this connection" })
    expect(h.sent).toEqual([])
  })

  test("rejects browser attempts to inject relay subscription controls", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.handleClientMessage(
      "client-1",
      JSON.stringify({ type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_a"] }),
    )
    expect(h.closed).toEqual([{ connectionID: "client-1", code: 1003, reason: "Frame is not valid for this connection" }])
    expect(h.storedSubscriptions.get("client-1")).toBeUndefined()
  })

  test("answers heartbeats in both directions", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.handleClientMessage("client-1", '{"type":"ping"}')
    await h.relay.handleAgentMessage("agent-1", '{"type":"ping"}')
    expect(h.messagesTo("client-1")).toEqual([{ type: "pong" }])
    expect(h.messagesTo("agent-1")).toEqual([{ type: "pong" }])
    expect(h.closed).toEqual([])
  })
})

describe("relay core: request admission", () => {
  test("reports an unavailable agent, then forwards any scoped Session for local authorization", async () => {
    const h = harness()
    await h.relay.attach(client("client-1"))
    h.reset()

    await h.relay.handleClientMessage("client-1", request("1", "session.list"))
    await h.relay.handleClientMessage("client-1", request("2", "session.prompt", "ses_a"))
    expect(h.messagesTo("client-1")).toEqual([
      { type: "response", id: "1", ok: false, error: { code: "agent_unavailable", message: "No local agent is connected" } },
      { type: "response", id: "2", ok: false, error: { code: "agent_unavailable", message: "No local agent is connected" } },
    ])

    await h.relay.attach(agent("agent-1"))
    await h.relay.handleClientMessage("client-1", request("3", "session.prompt", "ses_other"))
    expect(h.requestsTo("agent-1")).toHaveLength(1)
    expect(h.requestsTo("agent-1")[0]).toMatchObject({ operation: "session.prompt", sessionID: "ses_other" })
  })

  test("reports malformed frames with the client id and closes frames without one", async () => {
    const h = harness()
    await attachBoth(h)

    await h.relay.handleClientMessage("client-1", '{"type":"request","id":"1","operation":"session.evil","sessionID":"ses_a"}')
    expect(h.messagesTo("client-1")[0]).toEqual({
      type: "response",
      id: "1",
      ok: false,
      error: { code: "unknown_operation", message: "Unknown operation" },
    })
    await h.relay.handleClientMessage("client-1", '{"type":"request","id":"2","operation":"session.get"}')
    expect(h.messagesTo("client-1")[1]).toEqual({
      type: "response",
      id: "2",
      ok: false,
      error: { code: "session_required", message: "Operation requires a session" },
    })
    await h.relay.handleClientMessage("client-1", "not json")
    expect(h.closed).toEqual([{ connectionID: "client-1", code: 1003, reason: "Frame is not valid for this connection" }])
  })

  test("closes oversized frames with the size code", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.handleClientMessage(
      "client-1",
      request("1", "session.list", undefined, { padding: "x".repeat(RemoteLimits.maxClientMessageChars) }),
    )
    expect(h.closed).toEqual([{ connectionID: "client-1", code: 1009, reason: "Frame exceeds the size bound" }])
  })

  test("enforces the client request rate limit and admits requests after the window", async () => {
    const h = harness()
    await attachBoth(h)
    for (let index = 0; index <= RemoteLimits.maxClientRequestsPerWindow; index += 1)
      await h.relay.handleClientMessage("client-1", request(String(index), "session.list"))
    expect(h.closed).toEqual([{ connectionID: "client-1", code: 1008, reason: "Client request rate exceeded" }])
    expect(h.requestsTo("agent-1")).toHaveLength(RemoteLimits.maxClientRequestsPerWindow)

    h.reset()
    h.advance(RemoteLimits.clientRateWindowMs + 1)
    await h.relay.attach(client("client-1"))
    h.reset()
    await h.relay.handleClientMessage("client-1", request("again", "session.list"))
    expect(h.messagesTo("agent-1")).toHaveLength(1)
  })

  test("bounds in-flight requests per client", async () => {
    const h = harness()
    await attachBoth(h)
    for (let index = 0; index < RemoteLimits.maxPendingRequestsPerClient; index += 1) {
      if (index > 0 && index % 20 === 0) h.advance(RemoteLimits.clientRateWindowMs + 1)
      await h.relay.handleClientMessage("client-1", request(String(index), "session.list"))
    }
    h.advance(RemoteLimits.clientRateWindowMs + 1)
    await h.relay.handleClientMessage("client-1", request("overflow", "session.list"))
    expect(h.messagesTo("client-1").at(-1)).toMatchObject({
      type: "response",
      id: "overflow",
      ok: false,
      error: { code: "rate_limited" },
    })
    expect(h.messagesTo("agent-1")).toHaveLength(RemoteLimits.maxPendingRequestsPerClient)
  })
})

describe("relay core: correlation integrity", () => {
  test("translates colliding client ids so responses reach the right socket", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await h.relay.attach(client("client-1"))
    await h.relay.attach(client("client-2"))
    h.reset()

    await h.relay.handleClientMessage("client-1", request("1", "session.list"))
    await h.relay.handleClientMessage("client-2", request("1", "session.list"))
    const forwarded = h.messagesTo("agent-1")
    expect(forwarded).toHaveLength(2)
    expect(forwarded[0]!.id).not.toBe(forwarded[1]!.id)

    await h.relay.handleAgentMessage("agent-1", response(forwarded[1]!.id as string, { for: "client-2" }))
    expect(h.messagesTo("client-2")).toEqual([{ type: "response", id: "1", ok: true, value: { for: "client-2" } }])
    expect(h.messagesTo("client-1")).toEqual([])

    await h.relay.handleAgentMessage("agent-1", response(forwarded[0]!.id as string, { for: "client-1" }))
    expect(h.messagesTo("client-1")).toEqual([{ type: "response", id: "1", ok: true, value: { for: "client-1" } }])
  })

  test("drops responses for unknown or already-settled ids", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.handleClientMessage("client-1", request("1", "session.list"))
    const forwarded = h.messagesTo("agent-1")[0]!
    await h.relay.handleAgentMessage("agent-1", response(forwarded.id as string, "first"))
    await h.relay.handleAgentMessage("agent-1", response(forwarded.id as string, "second"))
    await h.relay.handleAgentMessage("agent-1", response("r-unknown", "third"))
    expect(h.messagesTo("client-1")).toEqual([{ type: "response", id: "1", ok: true, value: "first" }])
  })

  test("forwards ordered chunks and closes an agent that breaks chunk order", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.handleClientMessage("client-1", request("1", "session.messages", "ses_a"))
    const forwarded = h.messagesTo("agent-1")[0]!

    await h.relay.handleAgentMessage("agent-1", response(forwarded.id as string, '{"messages":[', { index: 0, last: false }))
    await h.relay.handleAgentMessage("agent-1", response(forwarded.id as string, "]}", { index: 1, last: true }))
    expect(h.messagesTo("client-1")).toEqual([
      { type: "response", id: "1", ok: true, value: '{"messages":[', chunk: { index: 0, last: false } },
      { type: "response", id: "1", ok: true, value: "]}", chunk: { index: 1, last: true } },
    ])

    await h.relay.handleClientMessage("client-1", request("2", "session.messages", "ses_a"))
    const second = h.messagesTo("agent-1")[1]!
    for (let index = 0; index < RemoteLimits.maxAgentViolations; index += 1)
      await h.relay.handleAgentMessage("agent-1", response(second.id as string, "out-of-order", { index: 5, last: false }))
    expect(h.closed).toEqual([{ connectionID: "agent-1", code: 1008, reason: "Agent violated the relay policy" }])
  })
})

describe("relay core: subscriptions and events", () => {
  for (const agentFirst of [false, true])
    test(`restores the surviving agent before clearing rejected clients (agent first: ${agentFirst})`, async () => {
      const h = harness()
      h.setClientAuthorityRead(async (call) => call === 1 ? { ok: false, reason: "session_revoked" } : { ok: true })
      const browsers = [
        { ...client("client-rejected"), subscriptions: ["ses_a"] },
        { ...client("client-retained"), subscriptions: ["ses_a", "ses_b"] },
      ]
      await h.relay.restore(agentFirst ? [agent("agent-1"), ...browsers] : [...browsers, agent("agent-1")])
      expect(h.messagesTo("agent-1")).toEqual([
        { type: "subscriptions", clientID: "client-rejected", sessionIDs: [] },
        { type: "subscriptions", clientID: "client-retained", sessionIDs: ["ses_a", "ses_b"] },
      ])
      expect(h.closed.map((entry) => entry.connectionID)).toEqual(["client-rejected"])
      await h.relay.attach(agent("agent-2"))
      expect(h.closed.map((entry) => entry.connectionID)).toEqual(["client-rejected", "agent-1"])
      expect(h.messagesTo("agent-2")).toEqual([
        { type: "subscriptions", clientID: "client-retained", sessionIDs: ["ses_a", "ses_b"] },
      ])
    })

  for (const reason of ["expired", "session_revoked", "session_missing", "invalid_snapshot"])
    test(`clears a rejected restored client's subscription after ${reason}`, async () => {
      const h = harness()
      await h.relay.attach(agent("agent-1"))
      if (reason === "session_revoked" || reason === "session_missing")
        h.setClientAuthority({ ok: false, reason })
      await h.relay.attach({
        ...client("client-1"),
        credentialExpiresAt: reason === "expired" ? h.at() : 10_000_000,
        subscriptions: reason === "invalid_snapshot" ? ["not-a-session"] : ["ses_a"],
      })
      expect(h.messagesTo("agent-1")).toEqual([
        { type: "subscriptions", clientID: "client-1", sessionIDs: [] },
      ])
      expect(h.closed.map((entry) => entry.connectionID)).toEqual(["client-1"])
      expect(h.messagesTo("client-1")).toEqual([])
    })

  test("a client detached during agent attachment is not resubscribed by a late authority read", async () => {
    const test = harness()
    await test.relay.attach({ ...client("client-1"), subscriptions: ["ses_a"] })
    const entered = deferred()
    const gate = deferred()
    test.setClientAuthorityRead(async () => { entered.resolve(); await gate.promise; return { ok: true } })
    const attaching = test.relay.attach(agent("agent-1"))
    await entered.promise
    test.relay.detach("client-1")
    gate.resolve()
    await attaching
    expect(test.messagesTo("agent-1")).toEqual([{ type: "subscriptions", clientID: "client-1", sessionIDs: [] }])
  })

  test("a replaced agent attachment cannot resynchronize its successor after a late authority read", async () => {
    const test = harness()
    await test.relay.attach({ ...client("client-1"), subscriptions: ["ses_a"] })
    const entered = deferred()
    const gate = deferred()
    let reads = 0
    test.setClientAuthorityRead(async () => {
      if (++reads === 1) { entered.resolve(); await gate.promise }
      return { ok: true }
    })
    const attaching = test.relay.attach(agent("agent-1"))
    await entered.promise
    await test.relay.attach(agent("agent-2"))
    gate.resolve()
    await attaching
    expect(test.messagesTo("agent-2")).toEqual([{ type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_a"] }])
  })

  test("synchronizes retained browser subscriptions to a fresh agent", async () => {
    const h = harness()
    await h.relay.attach({ ...client("client-1"), subscriptions: ["ses_a", "ses_b"] })
    h.reset()

    await h.relay.attach(agent("agent-1"))
    expect(h.messagesTo("agent-1")).toEqual([
      { type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_a", "ses_b"] },
    ])
  })

  test("synchronizes a restored browser attachment when the agent is already live", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    h.reset()
    await h.relay.attach({ ...client("client-1"), subscriptions: ["ses_a"] })
    expect(h.messagesTo("agent-1")).toEqual([
      { type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_a"] },
    ])
  })

  test("keeps shared Session interest until the last client disconnects", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await h.relay.attach({ ...client("client-1"), subscriptions: ["ses_a"] })
    await h.relay.attach({ ...client("client-2"), subscriptions: ["ses_a"] })
    h.reset()

    h.relay.detach("client-1")
    h.relay.detach("client-2")
    expect(h.messagesTo("agent-1")).toEqual([
      { type: "subscriptions", clientID: "client-1", sessionIDs: [] },
      { type: "subscriptions", clientID: "client-2", sessionIDs: [] },
    ])
  })

  test("does not resurrect a detached client from a late subscribe acknowledgement", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.handleClientMessage("client-1", request("1", "session.subscribe", "ses_a"))
    const subscribe = h.messagesTo("agent-1").at(-1)!
    h.reset()

    h.relay.detach("client-1")
    await h.relay.handleAgentMessage("agent-1", response(subscribe.id as string, null))
    expect(h.storedSubscriptions.get("client-1")).toBeUndefined()
    expect(h.messagesTo("agent-1")).toEqual([{ type: "subscriptions", clientID: "client-1", sessionIDs: [] }])
  })

  test("delivers events only to subscribed clients of advertised sessions", async () => {
    const h = harness({ sessions: ["ses_a", "ses_b"] })
    await attachBoth(h)

    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "event", sessionID: "ses_a", event: { seq: 1 } }))
    expect(h.messagesTo("client-1")).toEqual([])

    await h.relay.handleClientMessage("client-1", request("1", "session.subscribe", "ses_a"))
    const subscribe = h.messagesTo("agent-1").at(-1)!
    await h.relay.handleAgentMessage("agent-1", response(subscribe.id as string, null))
    expect(h.storedSubscriptions.get("client-1")).toEqual(["ses_a"])

    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "event", sessionID: "ses_a", event: { seq: 2 } }))
    expect(h.messagesTo("client-1")).toEqual([
      { type: "response", id: "1", ok: true, value: null },
      { type: "event", sessionID: "ses_a", event: { seq: 2 } },
    ])

    await h.relay.handleClientMessage("client-1", request("2", "session.unsubscribe", "ses_a"))
    const unsubscribe = h.messagesTo("agent-1").at(-1)!
    await h.relay.handleAgentMessage("agent-1", response(unsubscribe.id as string, null))
    expect(h.storedSubscriptions.get("client-1")).toEqual([])
  })

  test("does not deliver a subscription's events to an unsubscribed client", async () => {
    const h = harness({ sessions: ["ses_a"] })
    await h.relay.attach(agent("agent-1"))
    await h.relay.attach(client("client-1"))
    await h.relay.attach(client("client-2"))
    h.reset()
    await h.relay.handleClientMessage("client-1", request("1", "session.subscribe", "ses_a"))
    const subscribe = h.messagesTo("agent-1").at(-1)!
    await h.relay.handleAgentMessage("agent-1", response(subscribe.id as string, null))
    h.reset()
    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "event", sessionID: "ses_a", event: { seq: 2 } }))
    expect(h.messagesTo("client-1")).toHaveLength(1)
    expect(h.messagesTo("client-2")).toEqual([])
  })

  test("delivers events only when a client subscribed to that Session", async () => {
    const h = harness({ sessions: ["ses_a"] })
    await h.relay.attach(agent("agent-1"))
    await h.relay.attach(client("client-1"))
    await h.relay.handleClientMessage("client-1", request("1", "session.subscribe", "ses_a"))
    const subscribe = h.messagesTo("agent-1").at(-1)!
    await h.relay.handleAgentMessage("agent-1", response(subscribe.id as string, null))
    h.reset()

    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "event", sessionID: "ses_secret", event: { seq: 1 } }))
    expect(h.messagesTo("client-1")).toEqual([])
    expect(h.closed).toEqual([])

    expect(h.closed).toEqual([])
  })

  test("broadcasts bounded Session invalidations", async () => {
    const h = harness({ sessions: ["ses_a"] })
    await h.relay.attach(agent("agent-1"))
    await h.relay.attach(client("client-1"))
    expect(h.messagesTo("client-1")).toEqual([{ type: "sessions" }])

    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "sessions" }))
    expect(h.messagesTo("client-1")).toEqual([
      { type: "sessions" },
      { type: "sessions" },
    ])

    await h.relay.attach(client("client-2"))
    expect(h.messagesTo("client-2")).toEqual([{ type: "sessions" }])
  })

  test("bounds subscriptions per client", async () => {
    const sessions = Array.from({ length: RemoteLimits.maxSubscriptionsPerClient + 1 }, (_, index) => `ses_s${index}`)
    const h = harness({ sessions })
    await attachBoth(h)
    for (let index = 0; index < RemoteLimits.maxSubscriptionsPerClient; index += 1) {
      if (index > 0 && index % 20 === 0) h.advance(RemoteLimits.clientRateWindowMs + 1)
      await h.relay.handleClientMessage("client-1", request(`s${index}`, "session.subscribe", sessions[index]!))
      const forwarded = h.messagesTo("agent-1").at(-1)!
      await h.relay.handleAgentMessage("agent-1", response(forwarded.id as string, null))
    }
    expect(h.storedSubscriptions.get("client-1")).toHaveLength(RemoteLimits.maxSubscriptionsPerClient)
    h.advance(RemoteLimits.clientRateWindowMs + 1)
    await h.relay.handleClientMessage(
      "client-1",
      request("overflow", "session.subscribe", sessions[RemoteLimits.maxSubscriptionsPerClient]),
    )
    expect(h.messagesTo("client-1").at(-1)).toMatchObject({ ok: false, error: { code: "rate_limited" } })
  })

  test("bounds restored snapshots before they reach the agent", async () => {
    const h = harness()
    await h.relay.attach({
      ...client("client-1"),
      subscriptions: Array.from({ length: RemoteLimits.maxSubscriptionsPerClient + 1 }, (_, index) => `ses_${index}`),
    })
    await h.relay.attach(agent("agent-1"))
    expect(h.closed).toContainEqual({
      connectionID: "client-1",
      code: 1008,
      reason: "Stored subscriptions exceed the limit",
    })
    expect(h.requestsTo("agent-1")).toEqual([])
  })
})

describe("relay core: disconnects, revocation, and expiry", () => {
  test("fails in-flight requests with outcome_unknown when the agent disconnects", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.handleClientMessage("client-1", request("1", "session.prompt", "ses_a", { id: "msg_1" }))
    h.relay.detach("agent-1")
    expect(h.messagesTo("client-1")).toEqual([
      {
        type: "response",
        id: "1",
        ok: false,
        error: { code: "outcome_unknown", message: "Agent disconnected before settling this request" },
      },
    ])
    expect(h.storedPending.get("client-1")).toEqual([])
  })

  test("replacing the agent fails in-flight requests and closes the previous socket", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.handleClientMessage("client-1", request("1", "session.prompt", "ses_a", { id: "msg_1" }))
    await h.relay.attach(agent("agent-2"))
    expect(h.closed).toEqual([{ connectionID: "agent-1", code: 1012, reason: "Agent connection replaced" }])
    expect(h.messagesTo("client-1")[0]).toMatchObject({ ok: false, error: { code: "outcome_unknown" } })
    await h.relay.handleClientMessage("client-1", request("2", "session.list"))
    expect(h.requestsTo("agent-2")).toHaveLength(1)
  })

  test("a disconnected client never receives a late response meant for another client", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await h.relay.attach(client("client-1"))
    await h.relay.attach(client("client-2"))
    h.reset()
    await h.relay.handleClientMessage("client-1", request("1", "session.list"))
    const forwarded = h.messagesTo("agent-1")[0]!
    h.relay.detach("client-1")
    await h.relay.handleAgentMessage("agent-1", response(forwarded.id as string, "late"))
    expect(h.messagesTo("client-2")).toEqual([])
    expect(h.messagesTo("client-1")).toEqual([])
  })

  test("fails restored in-flight requests with outcome_unknown after a Durable Object restart", async () => {
    const h = harness()
    await h.relay.attach({ ...client("client-1"), pending: [{ relayID: "r9", clientID: "1" }] })
    expect(h.messagesTo("client-1")).toEqual([
      { type: "sessions" },
      {
        type: "response",
        id: "1",
        ok: false,
        error: { code: "outcome_unknown", message: "Agent disconnected before settling this request" },
      },
    ])
    expect(h.storedPending.get("client-1")).toEqual([])
  })

  test("closes a revoked browser session and stops delivering its events", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await h.relay.attach(client("client-1", "sess-1"))
    await h.relay.attach(client("client-2", "sess-2"))
    await h.relay.handleClientMessage("client-1", request("1", "session.subscribe", "ses_a"))
    const subscribe = h.messagesTo("agent-1").at(-1)!
    await h.relay.handleAgentMessage("agent-1", response(subscribe.id as string, null))
    h.reset()

    await h.relay.revokeSession("sess-1")
    expect(h.closed).toEqual([{ connectionID: "client-1", code: 4401, reason: "Session is no longer authorized" }])
    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "event", sessionID: "ses_a", event: { seq: 1 } }))
    expect(h.messagesTo("client-1")).toEqual([])
    expect(h.messagesTo("client-2")).toEqual([])
  })

  test("re-checks authority on every command and closes the socket when refused", async () => {
    const h = harness()
    await attachBoth(h)
    h.setClientAuthority({ ok: false, reason: "revoked_session" })
    await h.relay.handleClientMessage("client-1", request("1", "session.prompt", "ses_a", { id: "msg_1" }))
    expect(h.messagesTo("client-1")).toEqual([
      {
        type: "response",
        id: "1",
        ok: false,
        error: { code: "unauthorized", message: "Session is no longer authorized" },
      },
    ])
    expect(h.closed).toEqual([{ connectionID: "client-1", code: 4401, reason: "Session is no longer authorized" }])
    expect(h.requestsTo("agent-1")).toEqual([])

    h.reset()
    h.setClientAuthority({ ok: false, reason: "not_owner" })
    await h.relay.attach(client("client-2"))
    expect(h.closed).toEqual([{ connectionID: "client-2", code: 4403, reason: "Connection is not permitted" }])
    await h.relay.handleClientMessage("client-2", request("2", "session.list"))
    expect(h.closed).toHaveLength(1)
    expect(h.requestsTo("agent-1")).toEqual([])
  })

  test("refuses a client whose authority lapsed while the object was hibernating", async () => {
    const h = harness()
    h.setClientAuthority({ ok: false, reason: "revoked_session" })
    await h.relay.attach({ ...client("client-1"), pending: [{ relayID: "r9", clientID: "7" }] })
    expect(h.closed).toEqual([{ connectionID: "client-1", code: 4401, reason: "Session is no longer authorized" }])
    expect(h.messagesTo("client-1")).toEqual([
      {
        type: "response",
        id: "7",
        ok: false,
        error: { code: "outcome_unknown", message: "Agent disconnected before settling this request" },
      },
    ])
    expect(h.storedPending.get("client-1")).toEqual([])
  })

  test("stops delivering events when authority lapses without a revocation push", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.handleClientMessage("client-1", request("1", "session.subscribe", "ses_a"))
    const subscribe = h.messagesTo("agent-1").at(-1)!
    await h.relay.handleAgentMessage("agent-1", response(subscribe.id as string, null))
    h.reset()

    h.setClientAuthority({ ok: false, reason: "revoked_session" })
    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "event", sessionID: "ses_a", event: { seq: 9 } }))
    expect(h.messagesTo("client-1")).toEqual([])
    expect(h.closed).toEqual([{ connectionID: "client-1", code: 4401, reason: "Session is no longer authorized" }])
  })

  test("closes a device whose agent authorization lapsed while the client keeps working", async () => {
    const h = harness()
    await attachBoth(h)
    h.setAgentAuthority({ ok: false, reason: "revoked_device" })
    await h.relay.handleClientMessage("client-1", request("1", "session.list"))
    expect(h.closed).toEqual([{ connectionID: "agent-1", code: 4401, reason: "Device is no longer authorized" }])
    expect(h.messagesTo("client-1")).toEqual([
      { type: "response", id: "1", ok: false, error: { code: "agent_unavailable", message: "No local agent is connected" } },
    ])
  })

  test("closes the device, expires connections, and reports the sweep deadline", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await h.relay.attach({ ...client("client-1"), credentialExpiresAt: h.at() + 5_000 })
    expect(h.relay.nextDeadline()).toBe(h.at() + 5_000)

    h.advance(6_000)
    h.relay.sweep()
    expect(h.closed).toEqual([{ connectionID: "client-1", code: 4401, reason: "Session is no longer authorized" }])
    expect(h.relay.nextDeadline()).toBe(10_000_000)

    h.reset()
    await h.relay.attach(client("client-3"))
    h.reset()
    h.relay.closeDevice()
    expect(h.closed).toEqual([
      { connectionID: "agent-1", code: 4401, reason: "Device is no longer authorized" },
      { connectionID: "client-3", code: 4401, reason: "Device is no longer authorized" },
    ])
    await h.relay.handleClientMessage("client-3", request("3", "session.list"))
    expect(h.messagesTo("agent-1")).toEqual([])
  })

  test("refuses a device whose agent credentials were revoked at attach time", async () => {
    const h = harness()
    h.setAgentAuthority({ ok: false, reason: "revoked_device" })
    await h.relay.attach(agent("agent-1"))
    expect(h.closed).toEqual([{ connectionID: "agent-1", code: 4401, reason: "Device is no longer authorized" }])
    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "sessions", sessionIDs: ["ses_secret"] }))
    expect(h.advertised()).toEqual(["ses_a"])
    expect(h.closed).toHaveLength(2)
  })

  test("refuses an agent connection whose credential already expired", async () => {
    const h = harness()
    await h.relay.attach({ ...agent("agent-1"), credentialExpiresAt: 1 })
    expect(h.closed).toEqual([{ connectionID: "agent-1", code: 4401, reason: "Device is no longer authorized" }])
    expect(h.relay.nextDeadline()).toBeUndefined()
  })
})

describe("relay core: per-connection frame order and authority windows", () => {
  async function subscribed(h: ReturnType<typeof harness>) {
    await attachBoth(h)
    await h.relay.handleClientMessage("client-1", request("1", "session.subscribe", "ses_a"))
    const subscribe = h.messagesTo("agent-1").at(-1)!
    await h.relay.handleAgentMessage("agent-1", response(subscribe.id as string, null))
    h.reset()
  }

  const event = (seq: number) => JSON.stringify({ type: "event", sessionID: "ses_a", event: { seq } })
  const frame = (seq: number) => ({ type: "event", sessionID: "ses_a", event: { seq } })

  test("keeps event frames in arrival order while an authority read is pending", async () => {
    const h = harness({ authorityTtlMs: 5_000 })
    await subscribed(h)
    h.advance(6_000)
    const gate = deferred()
    let gated = false
    h.setClientAuthorityRead(async () => {
      if (!gated) {
        gated = true
        await gate.promise
      }
      return { ok: true }
    })

    const first = h.relay.handleAgentMessage("agent-1", event(1))
    const second = h.relay.handleAgentMessage("agent-1", event(2))
    gate.resolve()
    await Promise.all([first, second])

    expect(h.messagesTo("client-1")).toEqual([frame(1), frame(2)])
  })

  test("re-validates a subscribed recipient once per authority window and fails closed past it", async () => {
    const h = harness({ authorityTtlMs: 5_000 })
    await subscribed(h)
    expect(h.authorityReads()).toBe(1)

    h.advance(1_000)
    await h.relay.handleAgentMessage("agent-1", event(1))
    expect(h.authorityReads()).toBe(1)
    expect(h.messagesTo("client-1")).toEqual([frame(1)])

    h.advance(4_000)
    await h.relay.handleAgentMessage("agent-1", event(2))
    expect(h.authorityReads()).toBe(2)
    expect(h.messagesTo("client-1")).toEqual([frame(1), frame(2)])

    h.reset()
    h.setClientAuthority({ ok: false, reason: "revoked_session" })
    h.advance(5_000)
    await h.relay.handleAgentMessage("agent-1", event(3))
    expect(h.authorityReads()).toBe(3)
    expect(h.messagesTo("client-1")).toEqual([])
    expect(h.closed).toEqual([{ connectionID: "client-1", code: 4401, reason: "Session is no longer authorized" }])
  })

  test("keeps a connection usable after one frame's authority read fails", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await h.relay.attach(client("client-1"))
    h.reset()
    let failed = false
    h.setClientAuthorityRead(async () => {
      if (!failed) {
        failed = true
        throw new Error("authority store unavailable")
      }
      return { ok: true }
    })

    await expect(h.relay.handleClientMessage("client-1", request("1", "session.list"))).rejects.toThrow(
      "authority store unavailable",
    )
    await h.relay.handleClientMessage("client-1", request("2", "session.list"))
    expect(h.messagesTo("agent-1").map((message) => message.id)).toEqual(["r1"])
  })

  test("does not serialize frames from different connections", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await h.relay.attach(client("client-1"))
    await h.relay.attach(client("client-2"))
    h.reset()
    const gate = deferred()
    let gated = false
    h.setClientAuthorityRead(async () => {
      if (!gated) {
        gated = true
        await gate.promise
      }
      return { ok: true }
    })

    const paused = h.relay.handleClientMessage("client-1", request("1", "session.list"))
    await h.relay.handleClientMessage("client-2", request("2", "session.list"))
    expect(h.messagesTo("agent-1").map((message) => message.id)).toEqual(["r1"])

    gate.resolve()
    await paused
    expect(h.messagesTo("agent-1").map((message) => message.id)).toEqual(["r1", "r2"])
  })

  test("drops a queued frame whose connection detached while it waited", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await h.relay.attach(client("client-1"))
    h.reset()
    const gate = deferred()
    let gated = false
    h.setClientAuthorityRead(async () => {
      if (!gated) {
        gated = true
        await gate.promise
      }
      return { ok: true }
    })

    const paused = h.relay.handleClientMessage("client-1", request("1", "session.list"))
    h.relay.detach("client-1")
    gate.resolve()
    await paused
    expect(h.requestsTo("agent-1")).toEqual([])
  })
})

describe("relay core: protocol metadata", () => {
  test("reports the contract revision it speaks", () => {
    expect(RemoteProtocolVersion).toBe(2)
  })
})
