import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RemoteLimits, RemoteProtocolVersion, parseNoticePage, type RemoteNotice, type RemoteStatus } from "../../../packages/remote/src/index"
import { createRelay, type OfflineCheck, type RelayConnection, type RelayDeps } from "../src/relay/core"
import { createNoticeStore, type NoticeStore } from "../src/relay/notice-store"

type Sent = { readonly connectionID: string; readonly message: string }
type Closed = { readonly connectionID: string; readonly code: number; readonly reason: string }
type Authority = { ok: true } | { ok: false; reason: string }

function harness(options: { readonly sessions?: readonly string[]; readonly authorityTtlMs?: number; readonly statusStore?: { value?: RemoteStatus }; readonly database?: Database; readonly noticeStore?: (store: NoticeStore) => NoticeStore; readonly withoutPush?: boolean; readonly offlineStore?: { value?: OfflineCheck } } = {}) {
  let now = 1_000_000
  let idSequence = 0
  const sent: Sent[] = []
  const closed: Closed[] = []
  const pushed: ({ accountID: string } & Record<string, string>)[] = []
  const offlineStore = options.offlineStore ?? {}
  const storedSubscriptions = new Map<string, readonly string[]>()
  const storedPending = new Map<string, readonly { relayID: string; clientID: string }[]>()
  const statusStore = options.statusStore ?? {}
  const database = options.database ?? new Database(":memory:")
  const baseNotices = createNoticeStore({ exec: (query, ...bindings) => {
    const rows = database.prepare(query).all(...(bindings as never[]))
    return { toArray: () => rows }
  } })
  const notices = options.noticeStore?.(baseNotices) ?? baseNotices
  const storedNoticeSubscriptions = new Map<string, boolean>()
  let advertisement: readonly string[] = options.sessions ?? ["ses_a"]
  let clientAuthority: Authority = { ok: true }
  let agentAuthority: Authority = { ok: true }
  let authorityReads = 0
  let readAgentAuthority: () => Promise<Authority> = async () => agentAuthority
  let readClientAuthority: (call: number) => Promise<Authority> = async () => clientAuthority

  const deps: RelayDeps = {
    now: () => now,
    newID: () => `r${(idSequence += 1)}`,
    send: (connectionID, message) => sent.push({ connectionID, message }),
    close: (connectionID, code, reason) => closed.push({ connectionID, code, reason }),
    saveSubscriptions: (connectionID, values) => storedSubscriptions.set(connectionID, values),
    savePending: (connectionID, values) => storedPending.set(connectionID, values),
    loadStatus: async () => statusStore.value,
    saveStatus: async (status) => { statusStore.value = status },
    loadOfflineCheck: async () => offlineStore.value,
    saveOfflineCheck: async (check) => { offlineStore.value = check },
    notices,
    saveNoticeSubscription: (connectionID, subscribed) => storedNoticeSubscriptions.set(connectionID, subscribed),
    authorizeClientCommand: async () => {
      authorityReads += 1
      return readClientAuthority(authorityReads)
    },
    authorizeAgentCommand: () => readAgentAuthority(),
    authorityTtlMs: options.authorityTtlMs ?? 0,
    ...(options.withoutPush ? {} : { notifyPush: (accountID: string, event: Record<string, string>) => { pushed.push({ accountID, ...event }) } }),
  }

  const relay = createRelay(deps)
  return {
    relay,
    sent,
    closed,
    pushed,
    storedSubscriptions,
    storedPending,
    storedStatus: () => statusStore.value,
    storedOffline: () => offlineStore.value,
    database,
    storedNotices: () => (database.query("SELECT seq, category, session_id, created_at FROM notice ORDER BY seq").all() as { seq: number; category: RemoteNotice["category"]; session_id: string; created_at: number }[])
      .map((row) => ({ id: `ntc_${row.seq}`, category: row.category, sessionID: row.session_id, createdAt: row.created_at })),
    storedNoticeSubscriptions,
    noticeFramesTo: (connectionID: string) =>
      sent
        .filter((entry) => entry.connectionID === connectionID)
        .map((entry) => JSON.parse(entry.message) as Record<string, unknown>)
        .filter((message) => typeof message.type === "string" && message.type.startsWith("notice.")),
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
    setAgentAuthorityRead: (read: () => Promise<Authority>) => {
      readAgentAuthority = read
    },
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

function client(connectionID: string, browserSessionID = "sess-1", noticesSubscribed = false): RelayConnection {
  return {
    connectionID,
    role: "client",
    ownerID: "usr_1",
    deviceID: "dev_1",
    browserSessionID,
    credentialExpiresAt: 10_000_000,
    subscriptions: [],
    noticesSubscribed,
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
    noticesSubscribed: false,
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

test("detaching a streaming client cancels its in-flight agent request", async () => {
  const h = harness()
  await attachBoth(h)
  await h.relay.handleClientMessage("client-1", JSON.stringify({ type: "request", id: "stream", operation: "session.message.stream", sessionID: "ses_a", input: { messageID: "msg_large" } }))
  const request = h.requestsTo("agent-1").at(-1)
  expect(request?.type).toBe("request")
  h.relay.detach("client-1")
  expect(h.messagesTo("agent-1").at(-1)).toEqual({ type: "cancel", id: request?.id })
})

describe("relay core: role separation", () => {
  test("status diff emits only new decisions and stopped roots after a silent baseline, capped per minute", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "status", running: ["ses_a"], attention: [] }))
    expect(h.pushed).toEqual([])
    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "status", running: [], attention: ["ses_b"] }))
    expect(h.pushed).toEqual([
      { accountID: "usr_1", category: "approval-requested", sessionID: "ses_b", deviceID: "dev_1", noticeID: "ntc_1" },
      { accountID: "usr_1", category: "agent-completed", sessionID: "ses_a", deviceID: "dev_1", noticeID: "ntc_2" },
    ])
    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "status", running: [], attention: ["ses_b"] }))
    expect(h.pushed).toHaveLength(2)
    for (let index = 0; index < 30; index += 1)
      await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "status", running: [], attention: ["ses_b", `ses_${index}`] }))
    expect(h.pushed).toHaveLength(20)
    h.advance(60_001)
    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "status", running: [], attention: ["ses_new"] }))
    expect(h.pushed).toHaveLength(21)
  })

  test("a status frame with failed roots is stored and broadcast unchanged and a newly failed root still pushes approval-requested", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "status", running: [], attention: [] }))
    const frame = { type: "status", running: [], attention: ["ses_b", "ses_c"], failed: ["ses_c"] }
    await h.relay.handleAgentMessage("agent-1", JSON.stringify(frame))
    expect(h.messagesTo("client-1").at(-1)).toEqual(frame)
    expect(h.storedStatus()).toEqual(frame)
    expect(h.pushed).toEqual([
      { accountID: "usr_1", category: "approval-requested", sessionID: "ses_b", deviceID: "dev_1", noticeID: "ntc_1" },
      { accountID: "usr_1", category: "approval-requested", sessionID: "ses_c", deviceID: "dev_1", noticeID: "ntc_2" },
    ])
  })

  test("a family finishes only after all outstanding work clears, and attention wins at idle", async () => {
    const h = harness()
    await attachBoth(h)
    const status = (running: string[], attention: string[], outstanding: string[] = []) =>
      h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "status", running, attention, outstanding }))
    await status(["ses_a"], [])
    await status([], [], ["ses_a"])
    expect(h.pushed).toEqual([])
    await status(["ses_a"], [], ["ses_a"])
    await status([], [], ["ses_a"])
    expect(h.pushed).toEqual([])
    await status([], ["ses_a"], [])
    expect(h.pushed.map((event) => event.category)).toEqual(["approval-requested"])
    await status(["ses_a"], [], [])
    await status([], [], [])
    expect(h.pushed.map((event) => event.category)).toEqual(["approval-requested", "agent-completed"])
    await status([], [], [])
    expect(h.pushed).toHaveLength(2)
  })

  test("a reattached agent diffs against the stored status, while unchanged and first-ever frames stay silent", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "status", running: ["ses_a"], attention: [] }))
    expect(h.pushed).toEqual([])
    expect(h.storedStatus()).toEqual({ type: "status", running: ["ses_a"], attention: [] })
    await h.relay.agentClosed(agent("agent-1"))
    await h.relay.attach(agent("agent-2"))
    await h.relay.handleAgentMessage("agent-2", JSON.stringify({ type: "status", running: ["ses_a"], attention: [] }))
    expect(h.pushed).toEqual([])
    await h.relay.agentClosed(agent("agent-2"))
    await h.relay.attach(agent("agent-3"))
    await h.relay.handleAgentMessage("agent-3", JSON.stringify({ type: "status", running: [], attention: ["ses_b"] }))
    expect(h.pushed).toEqual([
      { accountID: "usr_1", category: "approval-requested", sessionID: "ses_b", deviceID: "dev_1", noticeID: "ntc_1" },
      { accountID: "usr_1", category: "agent-completed", sessionID: "ses_a", deviceID: "dev_1", noticeID: "ntc_2" },
    ])
  })

  test("a new relay instance reads the stored device baseline after hibernation", async () => {
    const statusStore: { value?: RemoteStatus } = {}
    const first = harness({ statusStore })
    await first.relay.attach(agent("agent-1"))
    await first.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "status", running: ["ses_a"], attention: [] }))
    expect(first.pushed).toEqual([])
    const restored = harness({ statusStore })
    await restored.relay.attach(agent("agent-2"))
    await restored.relay.handleAgentMessage("agent-2", JSON.stringify({ type: "status", running: [], attention: [] }))
    expect(restored.pushed).toEqual([{ accountID: "usr_1", category: "agent-completed", sessionID: "ses_a", deviceID: "dev_1", noticeID: "ntc_1" }])
  })

  test("validates and broadcasts complete status to each device client and a late joiner", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.attach(client("client-2"))
    h.reset()
    const frame = JSON.stringify({ type: "status", running: ["ses_a"], attention: ["ses_other"] })
    await h.relay.handleAgentMessage("agent-1", frame)
    expect(h.sent).toEqual([
      { connectionID: "client-1", message: frame },
      { connectionID: "client-2", message: frame },
    ])
    await h.relay.attach(client("client-3"))
    expect(h.messagesTo("client-3")).toContainEqual({ type: "status", running: ["ses_a"], attention: ["ses_other"] })
    h.reset()
    await h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "status", running: ["ses_a", "ses_a"], attention: [] }))
    expect(h.sent).toEqual([])
    expect(h.closed).toEqual([{ connectionID: "agent-1", code: 1003, reason: "Frame is not valid for this connection" }])
  })

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
  test("forwards only Session-scoped bounded captured-change pages to the local agent", async () => {
    const h = harness()
    await attachBoth(h)
    h.reset()
    await h.relay.handleClientMessage("client-1", request("1", "session.capturedChanges.list", "ses_a", { cursor: "opaque" }))
    expect(h.requestsTo("agent-1")).toMatchObject([{ operation: "session.capturedChanges.list", sessionID: "ses_a", input: { cursor: "opaque" } }])
    await h.relay.handleClientMessage("client-1", request("2", "session.capturedChanges.list"))
    await h.relay.handleClientMessage("client-1", request("3", "session.capturedChanges.list", "ses_a", { directory: "/private" }))
    expect(h.requestsTo("agent-1")).toHaveLength(1)
    expect(h.messagesTo("client-1").filter((item) => item.type === "response")).toHaveLength(2)
  })
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
    expect(h.messagesTo("agent-1")).toEqual([
      { type: "subscriptions", clientID: "client-1", sessionIDs: [] },
      { type: "cancel", id: subscribe.id },
    ])
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
    await h.relay.agentClosed(agent("agent-1"))
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
    expect(RemoteProtocolVersion).toBe(3)
  })
})

describe("relay core: notice log", () => {
  type Harness = ReturnType<typeof harness>
  const status = (h: Harness, running: string[], attention: string[], outstanding?: string[]) =>
    h.relay.handleAgentMessage("agent-1", JSON.stringify({ type: "status", running, attention, ...(outstanding === undefined ? {} : { outstanding }) }))
  const subscribe = (h: Harness, connectionID: string) =>
    h.relay.handleClientMessage(connectionID, request(`sub_${connectionID}`, "notice.subscribe"))
  const list = (h: Harness, connectionID: string, before: string, id = `list_${before}`) =>
    h.relay.handleClientMessage(connectionID, request(id, "notice.list", undefined, { before }))
  const readIDs = (h: Harness, connectionID: string, ids: readonly string[], id = "read") =>
    h.relay.handleClientMessage(connectionID, request(id, "notice.read", undefined, { ids }))
  const responseTo = (h: Harness, connectionID: string, id: string) =>
    h.messagesTo(connectionID).find((message) => message.type === "response" && message.id === id)
  const pageOf = (h: Harness, connectionID: string, id: string) => {
    const reply = responseTo(h, connectionID, id) as { ok: true; value: unknown }
    const parsed = parseNoticePage(reply.value)
    if (!parsed.ok) throw new Error("response is not a notice page")
    return parsed.value
  }
  const added = (h: Harness, connectionID: string) =>
    h.noticeFramesTo(connectionID).filter((frame) => frame.type === "notice.added").flatMap((frame) => frame.notices as RemoteNotice[])
  const attention = (count: number, prefix = "ses_n") => Array.from({ length: count }, (_, index) => `${prefix}${index}`)

  test("records each derived transition as one stored notice and broadcasts it, with the new total, to subscribed clients only", async () => {
    const h = harness({ withoutPush: true })
    await attachBoth(h)
    await h.relay.attach(client("client-2"))
    await subscribe(h, "client-1")
    h.reset()
    await status(h, ["ses_a"], [])
    expect(h.storedNotices()).toEqual([])
    await status(h, [], ["ses_b"])
    expect(h.storedNotices()).toEqual([
      { id: "ntc_1", category: "approval-requested", sessionID: "ses_b", createdAt: h.at() },
      { id: "ntc_2", category: "agent-completed", sessionID: "ses_a", createdAt: h.at() },
    ])
    expect(h.noticeFramesTo("client-1")).toEqual([{ type: "notice.added", notices: h.storedNotices(), total: 2 }])
    expect(h.noticeFramesTo("client-2")).toEqual([])
    await status(h, [], ["ses_b"])
    expect(h.storedNotices()).toHaveLength(2)
  })

  test("subscribing answers with the newest page and total, persists the opt-in, and needs no agent", async () => {
    const h = harness()
    await attachBoth(h)
    await status(h, ["ses_a"], [])
    await status(h, [], [])
    await h.relay.agentClosed(agent("agent-1"))
    h.reset()
    await subscribe(h, "client-1")
    expect(pageOf(h, "client-1", "sub_client-1")).toEqual({ notices: [...h.storedNotices()].reverse(), total: 1, unavailable: false })
    expect(h.noticeFramesTo("client-1")).toEqual([])
    expect(h.storedNoticeSubscriptions.get("client-1")).toBe(true)
    expect(h.messagesTo("agent-1")).toEqual([])
    expect(h.closed).toEqual([])
  })

  test("pages older notices by cursor until none remain", async () => {
    const h = harness({ withoutPush: true })
    await attachBoth(h)
    await status(h, ["ses_a"], [])
    await status(h, [], attention(120))
    await subscribe(h, "client-1")
    const seen = pageOf(h, "client-1", "sub_client-1")
    expect(seen.notices).toHaveLength(RemoteLimits.noticePageSize)
    expect(seen.total).toBe(121)
    const ids = seen.notices.map((notice) => notice.id)
    let cursor = seen.next
    while (cursor !== undefined) {
      await list(h, "client-1", cursor)
      const page = pageOf(h, "client-1", `list_${cursor}`)
      expect(page.total).toBe(121)
      ids.push(...page.notices.map((notice) => notice.id))
      cursor = page.next
    }
    expect(ids).toHaveLength(121)
    expect(new Set(ids).size).toBe(121)
    expect(ids[0]).toBe("ntc_121")
    expect(ids.at(-1)).toBe("ntc_1")
  })

  test("retains every notice through a burst beyond the push window and beyond a hundred stored", async () => {
    const h = harness()
    await attachBoth(h)
    await subscribe(h, "client-1")
    await status(h, [], [])
    h.reset()
    await status(h, [], attention(300))
    expect(h.pushed).toHaveLength(20)
    expect(h.storedNotices()).toHaveLength(300)
    const frames = h.noticeFramesTo("client-1")
    expect(frames.map((frame) => (frame.notices as RemoteNotice[]).length)).toEqual([100, 100, 100])
    expect(frames.every((frame) => frame.total === 300)).toBe(true)
    for (let index = 0; index < 5; index += 1) {
      h.advance(61_000)
      await status(h, [], attention(1, `ses_w${index}_`))
      await status(h, [], [])
    }
    expect(h.storedNotices().length).toBeGreaterThanOrEqual(300)
    expect(h.pushed.length).toBeGreaterThan(20)
  })

  test("push stays limited to twenty a minute while every transition is recorded", async () => {
    const h = harness()
    await attachBoth(h)
    await status(h, [], [])
    for (let index = 0; index < 30; index += 1) await status(h, [], attention(index + 1))
    expect(h.pushed).toHaveLength(20)
    expect(h.storedNotices()).toHaveLength(30)
    h.advance(60_001)
    await status(h, [], attention(31))
    expect(h.pushed).toHaveLength(21)
    expect(h.storedNotices()).toHaveLength(31)
  })

  test("a client that never subscribes receives no notice frame from attach, additions, reads, or clears", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.attach(client("client-2"))
    await subscribe(h, "client-2")
    await status(h, ["ses_a"], [])
    await status(h, [], ["ses_b"])
    await readIDs(h, "client-2", ["ntc_1"])
    await h.relay.handleClientMessage("client-2", request("all", "notice.readAll"))
    expect(h.noticeFramesTo("client-2").map((frame) => frame.type)).toEqual(["notice.added", "notice.removed", "notice.cleared"])
    expect(h.noticeFramesTo("client-1")).toEqual([])
    await h.relay.attach(client("client-3"))
    expect(h.noticeFramesTo("client-3")).toEqual([])
  })

  test("a read removes exactly the existing notices for every subscribed client and is idempotent", async () => {
    const h = harness()
    await attachBoth(h)
    await h.relay.attach(client("client-2", "sess-2"))
    await status(h, ["ses_a", "ses_c"], [])
    await status(h, [], ["ses_b"])
    await subscribe(h, "client-1")
    await subscribe(h, "client-2")
    h.reset()
    await readIDs(h, "client-1", ["ntc_2", "ntc_99"], "read_1")
    expect(h.storedNotices().map((notice) => notice.id)).toEqual(["ntc_1", "ntc_3"])
    expect(h.noticeFramesTo("client-1")).toEqual([{ type: "notice.removed", ids: ["ntc_2"], total: 2 }])
    expect(h.noticeFramesTo("client-2")).toEqual([{ type: "notice.removed", ids: ["ntc_2"], total: 2 }])
    expect(responseTo(h, "client-1", "read_1")).toEqual({ type: "response", id: "read_1", ok: true, value: null })
    h.reset()
    await readIDs(h, "client-2", ["ntc_2"], "read_2")
    expect(h.noticeFramesTo("client-1")).toEqual([])
    expect(h.noticeFramesTo("client-2")).toEqual([])
    expect(responseTo(h, "client-2", "read_2")).toMatchObject({ ok: true })
    expect(h.messagesTo("agent-1")).toEqual([])
  })

  test("read all clears the log for every subscribed client with one frame however many notices exist", async () => {
    const h = harness({ withoutPush: true })
    await attachBoth(h)
    await h.relay.attach(client("client-2", "sess-2"))
    await status(h, [], [])
    await status(h, [], attention(400))
    await subscribe(h, "client-1")
    await subscribe(h, "client-2")
    h.reset()
    await h.relay.handleClientMessage("client-2", request("all", "notice.readAll"))
    expect(h.storedNotices()).toEqual([])
    expect(h.noticeFramesTo("client-1")).toEqual([{ type: "notice.cleared" }])
    expect(h.noticeFramesTo("client-2")).toEqual([{ type: "notice.cleared" }])
    expect(responseTo(h, "client-2", "all")).toEqual({ type: "response", id: "all", ok: true, value: null })
    await h.relay.handleClientMessage("client-1", request("again", "notice.readAll"))
    expect(responseTo(h, "client-1", "again")).toMatchObject({ ok: true })
    await status(h, [], ["ses_fresh"])
    expect(h.storedNotices().map((notice) => notice.id)).toEqual(["ntc_401"])
  })

  test("a client whose authority lapsed cannot subscribe, list, or read, and is closed", async () => {
    const h = harness()
    await attachBoth(h)
    await status(h, ["ses_a"], [])
    await status(h, [], [])
    const before = h.storedNotices()
    h.setClientAuthority({ ok: false, reason: "revoked_session" })
    h.reset()
    await subscribe(h, "client-1")
    expect(h.noticeFramesTo("client-1")).toEqual([])
    expect(responseTo(h, "client-1", "sub_client-1")).toMatchObject({ ok: false, error: { code: "unauthorized" } })
    expect(h.closed).toEqual([{ connectionID: "client-1", code: 4401, reason: "Session is no longer authorized" }])
    expect(h.storedNoticeSubscriptions.get("client-1")).toBeUndefined()
    h.setClientAuthority({ ok: true })
    await h.relay.attach(client("client-2", "sess-2"))
    h.setClientAuthority({ ok: false, reason: "not_owner" })
    await h.relay.handleClientMessage("client-2", request("read", "notice.readAll"))
    await list(h, "client-2", "ntc_9", "listed")
    expect(h.storedNotices()).toEqual(before)
    expect(responseTo(h, "client-2", "read")).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(responseTo(h, "client-2", "listed")).toBeUndefined()
  })

  test("a restored subscribed client keeps receiving additions without a replayed list", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await status(h, ["ses_a"], [])
    await status(h, [], [])
    h.reset()
    await h.relay.restore([client("client-1", "sess-1", true), client("client-2")])
    expect(h.noticeFramesTo("client-1")).toEqual([])
    expect(h.noticeFramesTo("client-2")).toEqual([])
    await status(h, [], ["ses_b"])
    expect(added(h, "client-1").map((notice) => notice.sessionID)).toEqual(["ses_b"])
    expect(h.noticeFramesTo("client-2")).toEqual([])
  })

  test("a storage failure keeps stored notices, tells subscribed clients once, and marks later pages unavailable until read all", async () => {
    let failing = false
    const h = harness({ noticeStore: (store) => ({ ...store, append: (events) => {
      if (failing) throw new Error("database or disk is full: SQLITE_FULL")
      return store.append(events)
    } }) })
    await attachBoth(h)
    await h.relay.attach(client("client-2", "sess-2"))
    await subscribe(h, "client-1")
    await status(h, ["ses_a", "ses_b"], [])
    await status(h, ["ses_a"], [])
    expect(h.storedNotices()).toHaveLength(1)
    failing = true
    h.reset()
    await status(h, [], ["ses_c"])
    await status(h, [], [])
    expect(h.storedNotices()).toHaveLength(1)
    expect(h.noticeFramesTo("client-1")).toEqual([{ type: "notice.unavailable" }])
    expect(h.pushed.length).toBeGreaterThan(0)
    await subscribe(h, "client-2")
    expect(pageOf(h, "client-2", "sub_client-2")).toMatchObject({ total: 1, unavailable: true })
    failing = false
    await status(h, [], ["ses_d"])
    expect(h.storedNotices()).toHaveLength(2)
    await list(h, "client-2", "ntc_9", "later")
    expect(pageOf(h, "client-2", "later").unavailable).toBe(true)
    await readIDs(h, "client-2", ["ntc_1"])
    await list(h, "client-2", "ntc_9", "after_read")
    expect(pageOf(h, "client-2", "after_read").unavailable).toBe(true)
    h.reset()
    await h.relay.handleClientMessage("client-2", request("all", "notice.readAll"))
    expect(h.noticeFramesTo("client-1")).toEqual([{ type: "notice.cleared" }])
    await subscribe(h, "client-2")
    expect(pageOf(h, "client-2", "sub_client-2")).toEqual({ notices: [], total: 0, unavailable: false })
  })

  test("a storage failure remains visible after the relay is rebuilt over its stored notices", async () => {
    const database = new Database(":memory:")
    const previous = harness({ database, noticeStore: (store) => ({ ...store, append: () => { throw new Error("SQLITE_FULL") } }) })
    await attachBoth(previous)
    await status(previous, ["ses_a"], [])
    await status(previous, [], [])
    const restored = harness({ database })
    await attachBoth(restored)
    await subscribe(restored, "client-1")
    expect(pageOf(restored, "client-1", "sub_client-1")).toMatchObject({ unavailable: true })
  })

  test("a full store that also rejects its failure marker still warns connected readers without clearing unread rows", async () => {
    const h = harness({ noticeStore: (store) => ({ ...store,
      append: (events) => {
        if (events.some((event) => event.sessionID === "ses_fail")) throw new Error("SQLITE_FULL")
        return store.append(events)
      },
      markUnavailable: () => { throw new Error("SQLITE_FULL") },
    }) })
    await attachBoth(h)
    await subscribe(h, "client-1")
    await status(h, ["ses_keep"], [])
    await status(h, [], [])
    h.reset()
    await status(h, [], ["ses_fail"])
    expect(h.noticeFramesTo("client-1")).toEqual([{ type: "notice.unavailable" }])
    await subscribe(h, "client-1")
    expect(pageOf(h, "client-1", "sub_client-1")).toMatchObject({ total: 1, unavailable: true })
    expect(h.storedNotices().map((notice) => notice.sessionID)).toEqual(["ses_keep"])
  })

  test("a failing read of the store answers internal_error, leaves the opt-in unset, and never claims a page", async () => {
    const h = harness({ noticeStore: (store) => ({ ...store, page: () => { throw new Error("storage unavailable") } }) })
    await attachBoth(h)
    await subscribe(h, "client-1")
    expect(responseTo(h, "client-1", "sub_client-1")).toEqual({
      type: "response", id: "sub_client-1", ok: false, error: { code: "internal_error", message: "Notification storage is unavailable" },
    })
    expect(h.storedNoticeSubscriptions.get("client-1")).toBeUndefined()
    await list(h, "client-1", "ntc_5", "listed")
    expect(responseTo(h, "client-1", "listed")).toMatchObject({ ok: false, error: { code: "internal_error" } })
    expect(h.closed).toEqual([])
  })

  test("read and clear failures answer internal_error without removing or announcing anything", async () => {
    const h = harness({ noticeStore: (store) => ({ ...store,
      remove: () => { throw new Error("storage unavailable") },
      clear: () => { throw new Error("storage unavailable") } }) })
    await attachBoth(h)
    await h.relay.attach(client("client-2", "sess-2"))
    await status(h, ["ses_a"], [])
    await status(h, [], [])
    await subscribe(h, "client-2")
    h.reset()
    await readIDs(h, "client-1", ["ntc_1"], "read")
    await h.relay.handleClientMessage("client-1", request("all", "notice.readAll"))
    expect(responseTo(h, "client-1", "read")).toMatchObject({ ok: false, error: { code: "internal_error" } })
    expect(responseTo(h, "client-1", "all")).toMatchObject({ ok: false, error: { code: "internal_error" } })
    expect(h.noticeFramesTo("client-2")).toEqual([])
    expect(h.storedNotices()).toHaveLength(1)
  })

  test("a subscribe page read while other clients mutate the log reflects one consistent state", async () => {
    const h = harness({ withoutPush: true })
    await attachBoth(h)
    await h.relay.attach(client("client-2", "sess-2"))
    await status(h, [], [])
    await status(h, [], attention(3))
    const gate = deferred()
    let gated = true
    h.setClientAuthorityRead(async () => {
      if (gated) {
        gated = false
        await gate.promise
      }
      return { ok: true }
    })
    const pending = subscribe(h, "client-1")
    await status(h, [], [...attention(3), "ses_late"])
    await readIDs(h, "client-2", ["ntc_1"])
    await h.relay.handleClientMessage("client-2", request("all", "notice.readAll"))
    await status(h, [], [])
    await status(h, [], ["ses_after"])
    gate.resolve()
    await pending
    const page = pageOf(h, "client-1", "sub_client-1")
    expect(page.notices.map((notice) => notice.sessionID)).toEqual(["ses_after"])
    expect(page.total).toBe(1)
    expect(h.noticeFramesTo("client-1")).toEqual([])
    await status(h, [], [])
    await status(h, [], ["ses_next"])
    expect(added(h, "client-1").map((notice) => notice.sessionID)).toEqual(["ses_next"])
    expect(h.noticeFramesTo("client-1").at(-1)).toMatchObject({ total: 2 })
  })

  test("an in-flight page read on one client cannot see a removal or clear that ran before it and is followed by the frames that ran after it", async () => {
    const h = harness({ withoutPush: true })
    await attachBoth(h)
    await h.relay.attach(client("client-2", "sess-2"))
    await status(h, [], [])
    await status(h, [], attention(60))
    await subscribe(h, "client-1")
    const first = pageOf(h, "client-1", "sub_client-1")
    h.reset()
    const gate = deferred()
    let gated = true
    h.setClientAuthorityRead(async () => {
      if (gated) {
        gated = false
        await gate.promise
      }
      return { ok: true }
    })
    const pending = list(h, "client-1", first.next ?? "", "older")
    await readIDs(h, "client-2", ["ntc_5", "ntc_6"])
    gate.resolve()
    await pending
    const page = pageOf(h, "client-1", "older")
    expect(page.notices.map((notice) => notice.id)).not.toContain("ntc_5")
    expect(page.notices.map((notice) => notice.id)).not.toContain("ntc_6")
    expect(page.total).toBe(58)
    const order = h.messagesTo("client-1").map((message) => (message.type === "response" ? "response" : message.type))
    expect(order).toEqual(["notice.removed", "response"])
    await h.relay.handleClientMessage("client-2", request("all", "notice.readAll"))
    expect(h.messagesTo("client-1").at(-1)).toEqual({ type: "notice.cleared" })
  })
})

describe("relay core: machine offline confirmation", () => {
  const offline = (offlineAt: number) => ({ accountID: "usr_1", category: "machine-offline", deviceID: "dev_1", offlineAt })

  test("an agent absent for the whole confirmation window raises one Machine offline push; a browser leaving raises none", async () => {
    const h = harness()
    await attachBoth(h)
    h.relay.detach("client-1")
    h.advance(RemoteLimits.agentOfflineConfirmMs)
    await h.relay.confirmOffline()
    expect(h.pushed).toEqual([])
    const closedAt = h.at()
    await h.relay.agentClosed(agent("agent-1"))
    expect(h.relay.nextDeadline()).toBe(closedAt + RemoteLimits.agentOfflineConfirmMs)
    h.advance(RemoteLimits.agentOfflineConfirmMs - 1)
    await h.relay.confirmOffline()
    expect(h.pushed).toEqual([])
    h.advance(1)
    await h.relay.confirmOffline()
    expect(h.pushed).toEqual([offline(closedAt)])
    expect(h.storedOffline()).toBeUndefined()
    h.advance(RemoteLimits.agentOfflineConfirmMs)
    await h.relay.confirmOffline()
    expect(h.pushed).toEqual([offline(closedAt)])
  })

  test("each confirmed outage reaches notice-subscribed browsers and the push with the same persisted close time", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await h.relay.attach(client("client-1", "sess-1", true))
    await h.relay.attach(client("client-2", "sess-2"))
    const firstClose = h.at()
    await h.relay.agentClosed(agent("agent-1"))
    h.advance(RemoteLimits.agentOfflineConfirmMs)
    await h.relay.confirmOffline()
    await h.relay.attach(agent("agent-2"))
    h.advance(1_000)
    const secondClose = h.at()
    await h.relay.agentClosed(agent("agent-2"))
    h.advance(RemoteLimits.agentOfflineConfirmMs)
    await h.relay.confirmOffline()
    expect(h.pushed).toEqual([offline(firstClose), offline(secondClose)])
    expect(h.noticeFramesTo("client-1")).toEqual([{ type: "notice.offline", at: firstClose }, { type: "notice.offline", at: secondClose }])
    expect(h.noticeFramesTo("client-2")).toEqual([])
  })

  test("a reconnect inside the window, like a routine credential rotation, cancels the pending alert", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await h.relay.agentClosed(agent("agent-1"))
    h.advance(5_000)
    await h.relay.attach(agent("agent-2"))
    expect(h.storedOffline()).toBeUndefined()
    h.advance(RemoteLimits.agentOfflineConfirmMs)
    await h.relay.confirmOffline()
    expect(h.pushed).toEqual([])
  })

  test("a replaced agent's late close never counts as the machine going offline", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await h.relay.attach(agent("agent-2"))
    await h.relay.agentClosed(agent("agent-1"))
    expect(h.storedOffline()).toBeUndefined()
    h.advance(RemoteLimits.agentOfflineConfirmMs)
    await h.relay.confirmOffline()
    expect(h.pushed).toEqual([])
  })

  test("the pending check survives hibernation, and a close delivered after a wake still counts", async () => {
    const offlineStore: { value?: OfflineCheck } = {}
    const first = harness({ offlineStore })
    await first.relay.attach(agent("agent-1"))
    const closedAt = first.at()
    await first.relay.agentClosed(agent("agent-1"))
    const woken = harness({ offlineStore })
    await woken.relay.restore([])
    expect(woken.relay.nextDeadline()).toBe(closedAt + RemoteLimits.agentOfflineConfirmMs)
    woken.advance(RemoteLimits.agentOfflineConfirmMs)
    await woken.relay.confirmOffline()
    expect(woken.pushed).toEqual([offline(closedAt)])

    const later = harness({ offlineStore })
    await later.relay.restore([])
    await later.relay.agentClosed(agent("agent-9"))
    later.advance(RemoteLimits.agentOfflineConfirmMs)
    await later.relay.confirmOffline()
    expect(later.pushed).toEqual([offline(closedAt)])
  })

  test("a revoked device never reports offline even after its agent socket closes", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    h.relay.closeDevice()
    await h.relay.agentClosed(agent("agent-1"))
    h.setAgentAuthority({ ok: false, reason: "revoked_device" })
    h.advance(RemoteLimits.agentOfflineConfirmMs)
    await h.relay.confirmOffline()
    expect(h.pushed).toEqual([])
    expect(h.storedOffline()).toBeUndefined()
  })

  test("a failed authority read keeps the pending check, so the alarm retry still alerts exactly once", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    const closedAt = h.at()
    await h.relay.agentClosed(agent("agent-1"))
    let reads = 0
    h.setAgentAuthorityRead(async () => {
      reads += 1
      if (reads === 1) throw new Error("D1 unavailable")
      return { ok: true }
    })
    h.advance(RemoteLimits.agentOfflineConfirmMs)
    await expect(h.relay.confirmOffline()).rejects.toThrow("D1 unavailable")
    expect(h.storedOffline()).toMatchObject({ deviceID: "dev_1", closedAt })
    expect(h.relay.nextDeadline()).toBe(closedAt + RemoteLimits.agentOfflineConfirmMs)
    await h.relay.confirmOffline()
    await h.relay.confirmOffline()
    expect(h.pushed).toEqual([offline(closedAt)])
    expect(h.storedOffline()).toBeUndefined()
  })

  test("an agent that attaches while the authority read is pending cancels the alert, and overlapping confirmations alert once", async () => {
    const h = harness()
    await h.relay.attach(agent("agent-1"))
    await h.relay.agentClosed(agent("agent-1"))
    h.advance(RemoteLimits.agentOfflineConfirmMs)
    const gate = Promise.withResolvers<Authority>()
    h.setAgentAuthorityRead(() => gate.promise)
    const pending = h.relay.confirmOffline()
    h.setAgentAuthorityRead(async () => ({ ok: true }))
    await h.relay.attach(agent("agent-2"))
    gate.resolve({ ok: true })
    await pending
    expect(h.pushed).toEqual([])
    expect(h.storedOffline()).toBeUndefined()

    const closedAt = h.at()
    await h.relay.agentClosed(agent("agent-2"))
    h.advance(RemoteLimits.agentOfflineConfirmMs)
    const slow = Promise.withResolvers<Authority>()
    h.setAgentAuthorityRead(() => slow.promise)
    const overlapping = [h.relay.confirmOffline(), h.relay.confirmOffline()]
    slow.resolve({ ok: true })
    await Promise.all(overlapping)
    expect(h.pushed).toEqual([offline(closedAt)])
  })
})
