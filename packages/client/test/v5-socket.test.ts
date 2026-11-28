import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  decodeStrict,
  health_get_ResultSchema,
  health_get_RequestSchema,
  health_stop_RequestSchema,
  FrameSchema,
  PublicEventSchema,
  PublicEvent_catalog_updatedSchema,
  SessionLogItemSchema,
  session_rename_RequestSchema,
  event_unsubscribe_ResultSchema,
  session_form_cancel_RequestSchema,
  session_form_cancel_ResultSchema,
  session_create_RequestSchema,
  session_prompt_RequestSchema,
  session_snapshot_ResultSchema,
  session_form_list_ResultSchema,
  encodeLossless,
  decodeLossless,
  HistoryPrunedErrorSchema,
} from "@ycoding-ai/protocol/v5"
import { isHistoryPrunedError } from "../src/promise/index.js"
import { encodeDomain } from "../src/v5/codec.js"
import { make, resendUnsent, V5ClientError } from "../src/v5/index.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

const endpoint = { url: "http://127.0.0.1:12345" }

test("fork and revert preserve HistoryPrunedError fields and generated guard", async () => {
  const peer = new ScriptedPeer()
  const error = {
    _tag: "HistoryPrunedError",
    sessionID: "ses_owner",
    messageID: "msg_pruned",
    message: "History was compacted",
  }
  peer.onRequest = (dispatch) =>
    peer.result(
      dispatch,
      {
        typeName: HistoryPrunedErrorSchema.typeName,
        payload: encodeStrict(
          HistoryPrunedErrorSchema,
          create(HistoryPrunedErrorSchema, {
            Tag: 1,
            sessionID: { encoding: { case: "utf8", value: error.sessionID } },
            messageID: { encoding: { case: "utf8", value: error.messageID } },
            message: { encoding: { case: "utf8", value: error.message } },
          }),
        ),
      },
      true,
    )
  const client = make({
    endpoint,
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    for (const action of [
      () => client.session.fork({ sessionID: error.sessionID, messageID: error.messageID }),
      () => client.session.revert.stage({ sessionID: error.sessionID, messageID: error.messageID }),
    ]) {
      const rejected = await action().catch((error: unknown) => error)
      expect(rejected).toEqual(error)
      expect(isHistoryPrunedError(rejected)).toBe(true)
    }
  } finally {
    client.transport.close()
  }
})
const health = () =>
  encodeStrict(
    health_get_ResultSchema,
    create(health_get_ResultSchema, {
      data: {
        healthy: true,
        version: { encoding: { case: "utf8", value: "v" } },
        pid: 1n,
        sourceEpoch: { encoding: { case: "utf8", value: "source-1" } },
      },
    }),
  )
const catalog = (id: string) => ({
  typeName: PublicEventSchema.typeName,
  payload: encodeStrict(
    PublicEventSchema,
    create(PublicEventSchema, {
      kind: {
        case: "catalogUpdated",
        value: create(PublicEvent_catalog_updatedSchema, {
          id: { encoding: { case: "utf8", value: id } },
          created: 0,
          type: 1,
          data: {},
        }),
      },
    }),
  ),
})

test("direct connector performs the real handshake and delivers requests without arguments", async () => {
  const peer = new ScriptedPeer()
  const calls: unknown[][] = []
  peer.onRequest = (dispatch) =>
    peer.result(dispatch, { typeName: health_get_ResultSchema.typeName, payload: health() })
  const client = make({
    connect: (...args: []) => {
      calls.push(args)
      return peer.socket
    },
  })
  try {
    await Promise.resolve()
    let ready = false
    void client.transport.ready().then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)
    peer.socket.open()
    await client.transport.ready()
    expect(calls).toEqual([[]])
    expect(client.transport.state).toBe("established")
    expect(client.transport.connectionEpoch).toBe("connection-1")
    expect(client.transport.sourceEpoch).toBe("source-1")
    expect(await client.health.get()).toMatchObject({ healthy: true })
  } finally {
    client.transport.close()
  }
})

test.each(["close", "reconnect"] as const)("direct connector discards a socket returned after %s", async (action) => {
  const first = new ScriptedPeer("connection-1")
  const second = new ScriptedPeer("connection-2")
  const pending = Promise.withResolvers<typeof first.socket>()
  const invoked = Promise.withResolvers<void>()
  let calls = 0
  let listeners = 0
  const add = first.socket.addEventListener.bind(first.socket)
  first.socket.addEventListener = (...args) => {
    listeners++
    add(...args)
  }
  const client = make({
    connect: () => {
      if (calls++ === 0) {
        invoked.resolve()
        return pending.promise
      }
      return second.socket
    },
  })
  try {
    const old = client.transport.ready().catch((error: unknown) => error)
    await invoked.promise
    const replacement = action === "reconnect" ? client.transport.reconnect() : undefined
    if (action === "close") client.transport.close()
    expect(await old).toMatchObject({ status: action === "close" ? "unavailable" : "unknown" })
    pending.resolve(first.socket)
    await Promise.resolve()
    await Promise.resolve()
    expect(first.socket.readyState).toBe(3)
    expect(listeners).toBe(0)
    first.socket.open()
    if (replacement) {
      expect(client.transport.connectionEpoch).toBeUndefined()
      const arrived = second.nextRequest()
      const current = client.health.get().catch((error: unknown) => error)
      second.socket.open()
      await replacement
      const request = await arrived
      second.reject(request)
      expect(await current).toEqual({ _tag: "InvalidRequestError", message: "Scripted rejection" })
      expect(first.requests).toHaveLength(0)
      expect(client.transport.connectionEpoch).toBe("connection-2")
    } else {
      expect(client.transport.state).toBe("closed")
    }
  } finally {
    client.transport.close()
  }
})

test("direct connector rejects each conflicting option before side effects", () => {
  const peer = new ScriptedPeer()
  let calls = 0
  const connect = () => {
    calls++
    return peer.socket
  }
  const discover = async () => {
    calls++
    return endpoint
  }
  const socket = () => {
    calls++
    return peer.socket
  }
  for (const conflict of [{ endpoint }, { discover }, { socket }]) {
    expect(() => {
      const unexpected = make({ connect, ...conflict })
      unexpected.transport.close()
    }).toThrow()
  }
  expect(calls).toBe(0)
  expect(() => make({})).toThrow("A discovered v5 endpoint is required")
})

test("legacy discovery takes precedence over an endpoint", async () => {
  const peer = new ScriptedPeer()
  const urls: string[] = []
  const client = make({
    endpoint: { url: "http://ignored.invalid" },
    discover: async () => endpoint,
    socket: (url) => {
      urls.push(url)
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    await client.transport.ready()
    expect(urls).toEqual(["ws://127.0.0.1:12345/ws/v5/local"])
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-002 constructs one authenticated socket and waits for exact Ready", async () => {
  const peer = new ScriptedPeer()
  const connections: { url: string; headers: Readonly<Record<string, string>> }[] = []
  const client = make({
    endpoint: { ...endpoint, auth: { type: "basic", username: "fixture-owner", password: "" } },
    socket: (url, headers) => {
      connections.push({ url, headers })
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  peer.onRequest = (dispatch) => {
    expect(decodeStrict(health_get_RequestSchema, dispatch.request.payload)).toEqual({
      $typeName: health_get_RequestSchema.typeName,
    })
    peer.result(dispatch, { typeName: health_get_ResultSchema.typeName, payload: health() })
  }
  try {
    expect(await client.health.get()).toEqual({ healthy: true, version: "v", pid: 1, sourceEpoch: "source-1" })
    expect(connections).toEqual([
      { url: "ws://127.0.0.1:12345/ws/v5/local", headers: { Authorization: "Basic Zml4dHVyZS1vd25lcjo=" } },
    ])
    expect(client.transport.connectionEpoch).toBe("connection-1")
    expect(JSON.parse(JSON.stringify(client)).transport).toEqual({})
  } finally {
    client.transport.close()
  }
  expect(client.transport.retainedBytes).toBe(0)
})

test("REQ-WIRE-002 rejects incompatible Ready without dispatching application work", async () => {
  const peer = new ScriptedPeer()
  peer.transform = (bytes) => {
    const frame = decodeStrict(FrameSchema, bytes)
    if (frame.body.case === "ready") frame.body.value.revision = 6
    return encodeStrict(FrameSchema, frame)
  }
  const client = make({
    endpoint,
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    await expect(client.health.get()).rejects.toMatchObject({ status: "protocol", message: "Contract version mismatch: local v5, peer v6" })
    expect(peer.requests).toHaveLength(0)
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-009 delivers declared typed errors without replacing their domain shape", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) => peer.reject(dispatch)
  const client = make({
    endpoint,
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    await expect(client.health.stop({ instanceID: "instance-1" })).rejects.toEqual({
      _tag: "InvalidRequestError",
      message: "Scripted rejection",
    })
    expect(
      decodeStrict(health_stop_RequestSchema, peer.requests[0].request.payload).payload?.instanceID?.encoding,
    ).toEqual({ case: "utf8", value: "instance-1" })
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-012 reassembles and validates typed bulk before resolving the client method", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) => peer.bulk(dispatch, health())
  const client = make({
    endpoint,
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    expect(await client.health.get()).toEqual({ healthy: true, version: "v", pid: 1, sourceEpoch: "source-1" })
  } finally {
    client.transport.close()
  }
  expect(client.transport.retainedBytes).toBe(0)
})

test("REQ-WIRE-009/010 cancellation and window rejection distinguish transmitted from unsent work", async () => {
  for (const queued of [false, true]) {
    const peer = new ScriptedPeer("connection-1", queued ? { normalWindowBytes: 1 } : {})
    const client = make({
      endpoint,
      socket: () => {
        queueMicrotask(() => peer.socket.open())
        return peer.socket
      },
      budgets: queued ? { normalWindowBytes: 1 } : {},
    })
    const controller = new AbortController()
    try {
      await client.transport.ready()
      const arrival = peer.nextRequest()
      const result = client.health.get({ signal: controller.signal }).catch((error: unknown) => error)
      if (!queued) await arrival
      else await Promise.resolve()
      controller.abort()
      expect(await result).toMatchObject({ status: queued ? "unsent" : "unknown" })
      expect(peer.requests).toHaveLength(queued ? 0 : 1)
      expect(peer.cancellations).toHaveLength(queued ? 0 : 1)
    } finally {
      client.transport.close()
    }
  }
})

test("REQ-WIRE-007 oversized input is rejected before handoff without closing a healthy connection", async () => {
  const peer = new ScriptedPeer()
  const client = make({
    endpoint,
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  peer.onRequest = (dispatch) =>
    peer.result(dispatch, { typeName: health_get_ResultSchema.typeName, payload: health() })
  try {
    await expect(client.session.prompt({ sessionID: "ses_owner", text: "x".repeat(65536) })).rejects.toMatchObject({
      status: "unsent",
    })
    expect(peer.requests).toHaveLength(0)
    expect(await client.health.get()).toMatchObject({ healthy: true })
  } finally {
    client.transport.close()
  }
})

test("local frame pacing keeps cancelled and replaced requests unsent without replay", async () => {
  const budgets = { clientRate: 1 }
  const peers = [new ScriptedPeer("connection-1", budgets), new ScriptedPeer("connection-2", budgets)]
  let sockets = 0
  const client = make({
    endpoint,
    budgets,
    socket: () => {
      const peer = peers[sockets++]
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  peers[1].onRequest = (dispatch) => peers[1].result(dispatch, { typeName: health_get_ResultSchema.typeName, payload: health() })
  try {
    const started = peers[0].nextRequest()
    const sentCancel = new AbortController()
    const sent = client.health.get({ signal: sentCancel.signal }).catch((error: unknown) => error)
    const request = await started
    const cancel = new AbortController()
    const cancelled = client.health.get({ signal: cancel.signal }).catch((error: unknown) => error)
    const replaced = client.session.rename({ sessionID: "ses_owner", title: "never send" }).catch((error: unknown) => error)
    await new Promise<void>((resolve) => setImmediate(resolve))
    cancel.abort()
    expect(await cancelled).toMatchObject({ status: "unsent", operation: "health.get" })
    expect(peers[0].requests.map((request) => request.operation.diagnosticName)).toEqual(["health.get"])
    expect(peers[0].cancellations).toEqual([])
    sentCancel.abort()
    expect(await sent).toMatchObject({ status: "unknown", operation: "health.get" })
    expect(peers[0].cancellations).toEqual([request.requestID])
    await client.transport.reconnect()
    expect(await replaced).toMatchObject({ status: "unsent", operation: "session.rename" })
    expect(await client.health.get()).toMatchObject({ healthy: true })
    expect(peers[1].requests.map((request) => request.operation.diagnosticName)).toEqual(["health.get"])
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-009/011 rediscovery replaces ownership and never replays a mutation", async () => {
  const peers = [new ScriptedPeer("connection-1"), new ScriptedPeer("connection-2")]
  let discovers = 0
  let sockets = 0
  const client = make({
    discover: async () => {
      discovers++
      return endpoint
    },
    socket: () => {
      const peer = peers[sockets++]
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    const arrived = peers[0].nextRequest()
    const mutation = client.session
      .rename({ sessionID: "ses_owner", title: "a\ud800" })
      .catch((error: unknown) => error)
    const request = await arrived
    expect(decodeStrict(session_rename_RequestSchema, request.request.payload).params?.sessionID?.encoding).toEqual({
      case: "utf8",
      value: "ses_owner",
    })
    peers[0].socket.close()
    expect(await mutation).toMatchObject({ status: "unknown" })
    await client.transport.reconnect()
    expect(discovers).toBe(2)
    expect(peers[1].requests).toHaveLength(0)
    peers[1].onRequest = (dispatch) =>
      peers[1].result(dispatch, { typeName: health_get_ResultSchema.typeName, payload: health() })
    expect(await client.health.get()).toMatchObject({ healthy: true })
    expect(peers[0].requests).toHaveLength(1)
    expect(client.transport.connectionEpoch).toBe("connection-2")
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-011 failed finite log is incomplete; PublicEvents retain delivery order", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) => {
    if (dispatch.operation.diagnosticName === "event.unsubscribe") {
      peer.result(dispatch, {
        typeName: event_unsubscribe_ResultSchema.typeName,
        payload: encodeStrict(event_unsubscribe_ResultSchema, create(event_unsubscribe_ResultSchema, { data: {} })),
      })
      peer.end("subscription-1")
      return
    }
    peer.subscribe(dispatch)
  }
  const client = make({
    endpoint,
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    const iterator = client.event.subscribe()[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ type: "server.connected", sourceEpoch: "source-1" })
    peer.events("subscription-1", [catalog("evt_first"), catalog("evt_second")])
    expect((await iterator.next()).value).toMatchObject({ id: "evt_first", type: "catalog.updated" })
    expect((await iterator.next()).value).toMatchObject({ id: "evt_second" })
    await iterator.return?.()
    const log = client.session.log({ sessionID: "ses_log", follow: false })[Symbol.asyncIterator]()
    const arrival = peer.nextRequest()
    const next = log.next().catch((error: unknown) => error)
    await arrival
    await Promise.resolve()
    peer.socket.close()
    expect(await next).toMatchObject({ status: "unavailable" })
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-011 finite log completes only after the final ordered batch and StreamEnd", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) => peer.subscribe(dispatch)
  const client = make({
    endpoint,
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    const log = client.session.log({ sessionID: "ses_log", follow: false })[Symbol.asyncIterator]()
    const arrival = peer.nextRequest()
    const next = log.next()
    await arrival
    await Promise.resolve()
    peer.events("subscription-1", [
      {
        typeName: SessionLogItemSchema.typeName,
        payload: encodeStrict(
          SessionLogItemSchema,
          create(SessionLogItemSchema, {
            kind: {
              case: "value52",
              value: {
                type: 1,
                aggregateID: { encoding: { case: "utf8", value: "ses_log" } },
                sourceEpoch: { encoding: { case: "utf8", value: "source-1" } },
              },
            },
          }),
        ),
      },
    ])
    peer.end("subscription-1")
    expect((await next).value).toEqual({ type: "log.synced", aggregateID: "ses_log", sourceEpoch: "source-1" })
    expect(await log.next()).toEqual({ done: true, value: undefined })
  } finally {
    client.transport.close()
  }
})

test.each(["before", "after"] as const)(
  "returned subscription drains late batches until StreamEnd %s unsubscribe settlement",
  async (order) => {
    const peer = new ScriptedPeer()
    let subscriptions = 0
    peer.onRequest = (dispatch) => {
      if (dispatch.operation.diagnosticName === "event.subscribe") {
        peer.subscribe(dispatch, `subscription-${++subscriptions}`)
        return
      }
      if (dispatch.operation.diagnosticName === "event.unsubscribe") {
        peer.events(`subscription-${subscriptions}`, [catalog("evt_late_one"), catalog("evt_late_two")])
        if (order === "before") peer.end(`subscription-${subscriptions}`)
        peer.result(dispatch, {
          typeName: event_unsubscribe_ResultSchema.typeName,
          payload: encodeStrict(event_unsubscribe_ResultSchema, create(event_unsubscribe_ResultSchema, { data: {} })),
        })
        return
      }
      peer.result(dispatch, { typeName: health_get_ResultSchema.typeName, payload: health() })
    }
    const client = make({
      endpoint,
      budgets: { eventQueueCount: 1 },
      socket: () => {
        queueMicrotask(() => peer.socket.open())
        return peer.socket
      },
    })
    try {
      for (let repeat = 0; repeat < 3; repeat++) {
        const events = client.event.subscribe()[Symbol.asyncIterator]()
        await events.next()
        await events.return?.()
        expect(await events.next()).toEqual({ done: true, value: undefined })
        if (order === "after") peer.end(`subscription-${subscriptions}`)
        expect((await client.health.get()).healthy).toBe(true)
        expect(client.transport.state).toBe("established")
      }
    } finally {
      client.transport.close()
    }
    expect(client.transport.retainedBytes).toBe(0)
  },
)

test("Session-owned Form settlement retains its Session scope and payload owner", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) =>
    peer.result(dispatch, {
      typeName: session_form_cancel_ResultSchema.typeName,
      payload: encodeStrict(session_form_cancel_ResultSchema, create(session_form_cancel_ResultSchema, { data: {} })),
    })
  const client = make({
    endpoint,
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    expect(await client.form.cancel({ sessionID: "ses_owner", formID: "form_owned" })).toBeUndefined()
    const request = peer.requests[0]
    expect(request.request.scope?.target).toEqual({ case: "form", value: "ses_owner" })
    expect(
      decodeStrict(session_form_cancel_RequestSchema, request.request.payload).params?.sessionID?.encoding,
    ).toEqual({ case: "utf8", value: "ses_owner" })
    expect(peer.requests).toHaveLength(1)
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-009 an aborted opening request remains unsent and cannot be replayed on Ready", async () => {
  const peer = new ScriptedPeer()
  const constructed = Promise.withResolvers<void>()
  const client = make({
    endpoint,
    socket: () => {
      constructed.resolve()
      return peer.socket
    },
  })
  const controller = new AbortController()
  try {
    const result = client.session
      .rename({ sessionID: "ses_owner", title: "fixture" }, { signal: controller.signal })
      .catch((error: unknown) => error)
    await constructed.promise
    controller.abort()
    expect(await result).toMatchObject({ status: "unsent" })
    peer.socket.open()
    await client.transport.ready()
    expect(peer.requests).toHaveLength(0)
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-011 old-socket callbacks cannot settle replacement-connection requests", async () => {
  const first = new ScriptedPeer("connection-1")
  const second = new ScriptedPeer("connection-2")
  let socketCount = 0
  const client = make({
    discover: async () => endpoint,
    socket: () => {
      const peer = socketCount++ === 0 ? first : second
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    const arrived = first.nextRequest()
    const old = client.health.get().catch((error: unknown) => error)
    const request = await arrived
    await client.transport.reconnect()
    expect(await old).toMatchObject({ status: "unknown" })
    const arrivedAgain = second.nextRequest()
    const current = client.health.get()
    const currentRequest = await arrivedAgain
    first.result(request, { typeName: health_get_ResultSchema.typeName, payload: health() })
    second.reject(currentRequest)
    await expect(current).rejects.toEqual({ _tag: "InvalidRequestError", message: "Scripted rejection" })
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-007 unread event buffers are bounded and overflow is explicit", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) => peer.subscribe(dispatch)
  const client = make({
    endpoint,
    budgets: { eventQueueCount: 1 },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    const iterator = client.event.subscribe()[Symbol.asyncIterator]()
    await iterator.next()
    peer.events("subscription-1", [catalog("evt_first"), catalog("evt_second")])
    await expect(iterator.next()).rejects.toMatchObject({ status: "protocol", reason: "LIMIT" })
    expect(client.transport.retainedBytes).toBe(0)
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-011 changed source epochs require canonical resynchronization", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) =>
    dispatch.operation.diagnosticName === "event.unsubscribe"
      ? peer.result(dispatch, {
          typeName: event_unsubscribe_ResultSchema.typeName,
          payload: encodeStrict(event_unsubscribe_ResultSchema, create(event_unsubscribe_ResultSchema, { data: {} })),
        })
      : peer.subscribe(dispatch)
  const client = make({
    endpoint,
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    const iterator = client.event.subscribe()[Symbol.asyncIterator]()
    await iterator.next()
    peer.events("subscription-1", [catalog("evt_stale")], "source-2")
    await expect(iterator.next()).rejects.toMatchObject({ status: "resync" })
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-010 late settlements after cancellation do not close unrelated request delivery", async () => {
  const peer = new ScriptedPeer()
  const client = make({
    endpoint,
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  const controller = new AbortController()
  try {
    await client.transport.ready()
    const deliver = peer.socket.deliver.bind(peer.socket)
    const held: Uint8Array[] = []
    peer.socket.deliver = (bytes) => {
      held.push(bytes)
    }
    peer.onRequest = (dispatch) =>
      peer.result(dispatch, { typeName: health_get_ResultSchema.typeName, payload: health() })
    const arrived = peer.nextRequest()
    const result = client.health.get({ signal: controller.signal }).catch((error: unknown) => error)
    await arrived
    await Promise.resolve()
    controller.abort()
    expect(await result).toMatchObject({ status: "unknown" })
    peer.socket.deliver = deliver
    held.forEach(deliver)
    expect(await client.health.get()).toMatchObject({ healthy: true })
    expect(client.transport.state).toBe("established")
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-010 returning an iterator cancels its unresolved subscription request", async () => {
  const peer = new ScriptedPeer()
  const client = make({
    endpoint,
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    const iterator = client.event.subscribe()[Symbol.asyncIterator]()
    const arrived = peer.nextRequest()
    const next = iterator.next().catch((error: unknown) => error)
    await arrived
    await iterator.return?.()
    expect(await next).toMatchObject({ status: "unknown" })
    expect(peer.cancellations).toHaveLength(1)
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-006 Session creation scopes match root selectors and leave child placement to its parent", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) => peer.reject(dispatch)
  const client = make({
    endpoint,
    location: { directory: "/configured", workspaceID: "workspace_configured" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    await expect(
      client.session.create({ location: { directory: "/selected", workspaceID: "workspace_selected" } }),
    ).rejects.toMatchObject({ _tag: "InvalidRequestError" })
    await expect(client.session.create()).rejects.toMatchObject({ _tag: "InvalidRequestError" })
    const rejected = await client.session.create({ parentID: "ses_parent" }).catch((error: unknown) => error)
    expect(rejected).toMatchObject({ _tag: "InvalidRequestError" })
    for (const [index, directory, workspace] of [
      [0, "/selected", "workspace_selected"],
      [1, "/configured", "workspace_configured"],
    ] as const) {
      const dispatch = peer.requests[index]
      const request = decodeStrict(session_create_RequestSchema, dispatch.request.payload)
      expect(dispatch.request.scope?.target.case).toBe("location")
      if (dispatch.request.scope?.target.case !== "location") throw new Error("Expected Location scope")
      expect(decodeLossless(dispatch.request.scope.target.value)).toBe(directory)
      expect(decodeLossless(request.payload!.location!.directory!)).toBe(directory)
      expect(decodeLossless(request.payload!.location!.workspaceID!)).toBe(workspace)
    }
    const child = decodeStrict(session_create_RequestSchema, peer.requests[2].request.payload)
    expect(decodeLossless(child.payload!.parentID!)).toBe("ses_parent")
    expect(child.payload?.location).toBeUndefined()
  } finally {
    client.transport.close()
  }
})

const logItem = (seq: number) => ({
  typeName: SessionLogItemSchema.typeName,
  payload: encodeDomain(SessionLogItemSchema.typeName, {
    type: "session.input.withdrawn",
    id: `evt_log_${seq}`,
    created: seq,
    sourceEpoch: "source-1",
    durable: { aggregateID: "ses_log", seq, version: 1 },
    data: { sessionID: "ses_log", inputID: `msg_log_${seq}` },
  }),
})

const sequence = (peers: ScriptedPeer[], opened: ReadonlySet<number>) => {
  let index = 0
  const constructed = peers.map(() => Promise.withResolvers<void>())
  const socket = () => {
    const current = index++
    const peer = peers[current]
    constructed[current].resolve()
    if (opened.has(current)) queueMicrotask(() => peer.socket.open())
    return peer.socket
  }
  return { socket, constructed: constructed.map((entry) => entry.promise) }
}

test.each(["socket closes before Ready", "connection is replaced before Ready", "socket closes while queued"] as const)(
  "REQ-WIRE-009 a request that is never transmitted when the %s settles unsent and one retry dispatches once",
  async (variant) => {
    const queued = variant === "socket closes while queued"
    const peers = [
      new ScriptedPeer("connection-1", queued ? { normalWindowBytes: 1 } : {}),
      new ScriptedPeer("connection-2"),
    ]
    const sockets = sequence(peers, new Set(queued ? [0, 1] : [1]))
    const client = make({ discover: async () => endpoint, socket: sockets.socket })
    const input = { sessionID: "ses_owner", title: "retry once" }
    try {
      if (queued) await client.transport.ready()
      else await sockets.constructed[0]
      const first = client.session.rename(input).catch((error: unknown) => error)
      await Promise.resolve()
      await Promise.resolve()
      if (variant === "connection is replaced before Ready") void client.transport.reconnect()
      else peers[0].socket.close()
      expect(await first).toMatchObject({ _tag: "V5ClientError", status: "unsent", operation: "session.rename" })
      expect(peers[0].requests).toHaveLength(0)
      if (variant !== "connection is replaced before Ready") await client.transport.reconnect()
      peers[1].onRequest = (dispatch) => peers[1].reject(dispatch)
      const rejected = await client.session.rename(input).catch((error: unknown) => error)
      expect(rejected).toEqual({
        _tag: "InvalidRequestError",
        message: "Scripted rejection",
      })
      expect(peers[0].requests).toHaveLength(0)
      expect(peers[1].requests).toHaveLength(1)
      expect(
        decodeStrict(session_rename_RequestSchema, peers[1].requests[0].request.payload).payload?.title?.encoding,
      ).toEqual({ case: "utf8", value: "retry once" })
      expect(client.transport.connectionEpoch).toBe("connection-2")
    } finally {
      client.transport.close()
    }
  },
)

test("REQ-WIRE-009 a transmitted mutation lost to a socket error settles unknown and is never replayed", async () => {
  const peers = [new ScriptedPeer("connection-1"), new ScriptedPeer("connection-2")]
  const sockets = sequence(peers, new Set([0, 1]))
  const client = make({ discover: async () => endpoint, socket: sockets.socket })
  try {
    const arrived = peers[0].nextRequest()
    const mutation = client.session
      .prompt({ sessionID: "ses_owner", text: "uncertain", id: "msg_uncertain" })
      .catch((error: unknown) => error)
    await arrived
    peers[0].socket.dispatchEvent(new Event("error"))
    expect(await mutation).toMatchObject({ _tag: "V5ClientError", status: "unknown", operation: "session.prompt" })
    expect(client.transport.state).toBe("closed")
    await client.transport.reconnect()
    peers[1].onRequest = (dispatch) =>
      peers[1].result(dispatch, { typeName: health_get_ResultSchema.typeName, payload: health() })
    expect(await client.health.get()).toMatchObject({ healthy: true })
    expect(peers[0].requests.map((request) => request.operation.diagnosticName)).toEqual(["session.prompt"])
    expect(peers[1].requests.map((request) => request.operation.diagnosticName)).toEqual(["health.get"])
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-009 retrying an unsent prompt transmits the stable input ID once", async () => {
  const peers = [new ScriptedPeer("connection-1"), new ScriptedPeer("connection-2")]
  const sockets = sequence(peers, new Set([1]))
  const client = make({ discover: async () => endpoint, socket: sockets.socket })
  const input = { sessionID: "ses_owner", text: "exactly once", id: "msg_stable" }
  try {
    await sockets.constructed[0]
    const first = client.session.prompt(input).catch((error: unknown) => error)
    await Promise.resolve()
    peers[0].socket.close()
    expect(await first).toMatchObject({ status: "unsent" })
    await client.transport.reconnect()
    peers[1].onRequest = (dispatch) => peers[1].reject(dispatch)
    const outcomes: unknown[] = []
    await client.session.prompt(input).then(
      (value) => outcomes.push({ resolved: value }),
      (error: unknown) => outcomes.push(error),
    )
    expect(outcomes).toEqual([{ _tag: "InvalidRequestError", message: "Scripted rejection" }])
    expect(peers[0].requests).toHaveLength(0)
    expect(peers[1].requests).toHaveLength(1)
    expect(decodeStrict(session_prompt_RequestSchema, peers[1].requests[0].request.payload).payload?.id?.encoding).toEqual(
      { case: "utf8", value: "msg_stable" },
    )
    expect(client.transport.state).toBe("established")
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-009 an unsent request names what did not happen and is resendable only after a lost connection", async () => {
  const peers = [new ScriptedPeer("connection-1")]
  const sockets = sequence(peers, new Set())
  const client = make({ discover: async () => endpoint, socket: sockets.socket })
  try {
    await sockets.constructed[0]
    const controller = new AbortController()
    controller.abort()
    const cancelled = await client.session
      .rename({ sessionID: "ses_owner", title: "never" }, { signal: controller.signal })
      .catch((error: unknown) => error)
    expect(cancelled).toMatchObject({ status: "unsent", resendable: false })
    expect((cancelled as Error).message).toBe("Request session.rename was cancelled before it was sent.")
    peers[0].socket.close()
    const closed = await client.session.rename({ sessionID: "ses_owner", title: "late" }).catch((error: unknown) => error)
    expect(closed).toMatchObject({ status: "unsent", operation: "session.rename", resendable: true })
    expect((closed as Error).message).toBe(
      "Request session.rename was not sent because the connection to the server was lost. Nothing changed; try again once it reconnects.",
    )
    const prompt = await client.session
      .prompt({ sessionID: "ses_owner", text: "hello", id: "msg_closed" })
      .catch((error: unknown) => error)
    expect((prompt as Error).message).toStartWith("Your message was not sent")
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-009 resendUnsent sends a never-transmitted request once after the connection returns", async () => {
  const peers = [new ScriptedPeer("connection-1"), new ScriptedPeer("connection-2")]
  const sockets = sequence(peers, new Set([1]))
  const client = make({ discover: async () => endpoint, socket: sockets.socket })
  const resilient = resendUnsent(() => client, {
    reconnected: () => client.transport.reconnect(),
    revision: () => 0,
    admit: () => true,
  })
  const input = { sessionID: "ses_owner", text: "exactly once", id: "msg_resent" }
  try {
    await sockets.constructed[0]
    peers[0].socket.close()
    peers[1].onRequest = (dispatch) => peers[1].reject(dispatch)
    const outcome = await resilient.session.prompt(input).catch((error: unknown) => error)
    expect(outcome).toEqual({ _tag: "InvalidRequestError", message: "Scripted rejection" })
    expect(peers[0].requests).toHaveLength(0)
    expect(peers[1].requests).toHaveLength(1)
    expect(decodeStrict(session_prompt_RequestSchema, peers[1].requests[0].request.payload).payload?.id?.encoding).toEqual(
      { case: "utf8", value: "msg_resent" },
    )
  } finally {
    client.transport.close()
  }
})

test("an interrupted snapshot is read again after reconnect", async () => {
  const peers = [new ScriptedPeer("connection-1"), new ScriptedPeer("connection-2")]
  const sockets = sequence(peers, new Set([0, 1]))
  const client = make({ discover: async () => endpoint, socket: sockets.socket })
  const resilient = resendUnsent(() => client, {
    reconnected: () => client.transport.reconnect(),
    revision: (target) => target.transport.sourceEpoch,
    admit: ({ issuedRevision, target, error }) => (issuedRevision ?? error?.sourceEpoch) === target.transport.sourceEpoch,
  })
  peers[1]!.onRequest = (dispatch) => peers[1]!.result(dispatch, {
    typeName: session_snapshot_ResultSchema.typeName,
    payload: encodeStrict(session_snapshot_ResultSchema, create(session_snapshot_ResultSchema, { data: {
      sourceEpoch: encodeLossless("source-1"),
      session: { id: encodeLossless("ses_owner"), projectID: encodeLossless("project_fixture"), scope: 1, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 0, updated: 0 }, title: encodeLossless("fixture"), location: { directory: encodeLossless("/fixture") } },
      messages: { items: [] }, watermark: { type: 1, aggregateID: encodeLossless("ses_owner"), seq: 1n },
    } })),
  })
  try {
    const received = peers[0]!.nextRequest()
    const snapshot = resilient.session.snapshot({ sessionID: "ses_owner" })
    await received
    peers[0]!.socket.close()
    expect(await snapshot).toMatchObject({ sourceEpoch: "source-1", messages: [], session: { id: "ses_owner" } })
    expect(peers.map((peer) => peer.requests.map((request) => request.operation.diagnosticName))).toEqual([["session.snapshot"], ["session.snapshot"]])
  } finally {
    client.transport.close()
  }
})

test("pending capacity queues form reads until a request settles", async () => {
  const peer = new ScriptedPeer("connection-1", { pendingRequests: 1 })
  const client = make({ endpoint, budgets: { pendingRequests: 1 }, socket: () => { queueMicrotask(() => peer.socket.open()); return peer.socket } })
  try {
    await client.transport.ready()
    const first = peer.nextRequest()
    const healthResult = client.health.get()
    const healthRequest = await first
    const waiting = client.form.list({ sessionID: "ses_owner" }).catch((error: unknown) => error)
    await Promise.resolve()
    expect(peer.requests.map((request) => request.operation.diagnosticName)).toEqual(["health.get"])
    const next = peer.nextRequest()
    peer.result(healthRequest, { typeName: health_get_ResultSchema.typeName, payload: health() })
    expect(await healthResult).toMatchObject({ healthy: true })
    const formRequest = await next
    peer.result(formRequest, { typeName: session_form_list_ResultSchema.typeName, payload: encodeStrict(session_form_list_ResultSchema, create(session_form_list_ResultSchema, { data: { items: [] } })) })
    expect(await waiting).toEqual([])
  } finally {
    client.transport.close()
  }
}, 5000)

test("queued requests keep their order and an aborted waiter is never sent", async () => {
  const peer = new ScriptedPeer("connection-1", { pendingRequests: 1 })
  const client = make({ endpoint, budgets: { pendingRequests: 1 }, socket: () => { queueMicrotask(() => peer.socket.open()); return peer.socket } })
  try {
    await client.transport.ready()
    const first = peer.nextRequest()
    const healthResult = client.health.get()
    const healthRequest = await first
    const abort = new AbortController()
    const cancelled = client.form.list({ sessionID: "ses_owner" }, { signal: abort.signal }).catch((error: unknown) => error)
    const waiting = client.form.list({ sessionID: "ses_next" })
    const last = client.form.list({ sessionID: "ses_last" })
    abort.abort()
    expect(await cancelled).toMatchObject({ status: "unsent", reason: "Request cancelled before transmission" })
    const next = peer.nextRequest()
    peer.result(healthRequest, { typeName: health_get_ResultSchema.typeName, payload: health() })
    await healthResult
    const formRequest = await next
    expect(formRequest.request.scope?.target).toEqual({ case: "form", value: "ses_next" })
    const lastArrival = peer.nextRequest()
    peer.result(formRequest, { typeName: session_form_list_ResultSchema.typeName, payload: encodeStrict(session_form_list_ResultSchema, create(session_form_list_ResultSchema, { data: { items: [] } })) })
    expect(await waiting).toEqual([])
    const lastRequest = await lastArrival
    expect(lastRequest.request.scope?.target).toEqual({ case: "form", value: "ses_last" })
    peer.result(lastRequest, { typeName: session_form_list_ResultSchema.typeName, payload: encodeStrict(session_form_list_ResultSchema, create(session_form_list_ResultSchema, { data: { items: [] } })) })
    expect(await last).toEqual([])
    expect(peer.requests).toHaveLength(3)
  } finally {
    client.transport.close()
  }
}, 5000)

test("a form read survives consecutive interrupted connections", async () => {
  const peers = [new ScriptedPeer("connection-1"), new ScriptedPeer("connection-2"), new ScriptedPeer("connection-3")]
  const sockets = sequence(peers, new Set([0, 1, 2]))
  const client = make({ discover: async () => endpoint, socket: sockets.socket })
  const resilient = resendUnsent(() => client, {
    reconnected: () => client.transport.reconnect(),
    revision: (target) => target.transport.sourceEpoch,
    admit: ({ issuedRevision, target }) => issuedRevision === target.transport.sourceEpoch,
  })
  peers[2]!.onRequest = (request) => peers[2]!.result(request, { typeName: session_form_list_ResultSchema.typeName, payload: encodeStrict(session_form_list_ResultSchema, create(session_form_list_ResultSchema, { data: { items: [] } })) })
  try {
    await client.transport.ready()
    const first = peers[0]!.nextRequest()
    const result = resilient.form.list({ sessionID: "ses_owner" })
    await first
    const second = peers[1]!.nextRequest()
    peers[0]!.socket.close()
    await second
    peers[1]!.socket.close()
    expect(await result).toEqual([])
    expect(peers.map((peer) => peer.requests.map((request) => request.operation.diagnosticName))).toEqual([["session.form.list"], ["session.form.list"], ["session.form.list"]])
  } finally {
    client.transport.close()
  }
}, 5000)

test("a mutation queued behind capacity is sent after reconnect", async () => {
  const peers = [new ScriptedPeer("connection-1", { pendingRequests: 1 }), new ScriptedPeer("connection-2", { pendingRequests: 1 })]
  const sockets = sequence(peers, new Set([0, 1]))
  const client = make({ discover: async () => endpoint, socket: sockets.socket, budgets: { pendingRequests: 1 } })
  const resilient = resendUnsent(() => client, { reconnected: () => client.transport.reconnect(), revision: () => 1, admit: () => true })
  peers[1]!.onRequest = (request) => peers[1]!.reject(request)
  try {
    await client.transport.ready()
    const first = peers[0]!.nextRequest()
    const interrupted = client.health.get().catch((error: unknown) => error)
    await first
    const queued = resilient.session.prompt({ sessionID: "ses_owner", text: "queued", id: "msg_queued" }).catch((error: unknown) => error)
    await Promise.resolve()
    peers[0]!.socket.close()
    expect(await interrupted).toMatchObject({ status: "unknown" })
    expect(await queued).toEqual({ _tag: "InvalidRequestError", message: "Scripted rejection" })
    expect(peers.map((peer) => peer.requests.map((request) => request.operation.diagnosticName))).toEqual([["health.get"], ["session.prompt"]])
  } finally {
    client.transport.close()
  }
}, 5000)

test("cancelling an interrupted read while it waits for reconnect does not resend it", async () => {
  const peer = new ScriptedPeer()
  const client = make({ endpoint, socket: () => { queueMicrotask(() => peer.socket.open()); return peer.socket } })
  const reconnecting = Promise.withResolvers<void>()
  const resilient = resendUnsent(() => client, {
    reconnected: () => new Promise<void>(() => {
      reconnecting.resolve()
    }),
    revision: () => 1,
    admit: () => true,
  })
  try {
    await client.transport.ready()
    const arrived = peer.nextRequest()
    const controller = new AbortController()
    const result = resilient.session.snapshot({ sessionID: "ses_owner" }, { signal: controller.signal }).catch((error: unknown) => error)
    await arrived
    peer.socket.close()
    await reconnecting.promise
    controller.abort()
    expect(await result).toMatchObject({ status: "unsent", reason: "Request cancelled before transmission" })
    expect(peer.requests).toHaveLength(1)
  } finally {
    client.transport.close()
  }
}, 5000)

test("an invalid request is not mistaken for temporary capacity pressure", async () => {
  const peer = new ScriptedPeer()
  const client = make({ endpoint, socket: () => { queueMicrotask(() => peer.socket.open()); return peer.socket } })
  try {
    await client.transport.ready()
    const error = await client.session.snapshot({} as never).catch((value: unknown) => value)
    expect(error).toMatchObject({ status: "unsent", reason: "Input cannot be represented by v5" })
    expect(peer.requests).toHaveLength(0)
  } finally {
    client.transport.close()
  }
}, 5000)

test("a target changed during admission is rechecked before a mutation is sent", async () => {
  const sent: string[] = []
  const first = { rename: async () => { throw new V5ClientError("unsent", "session.rename", undefined, true) } }
  const second = { rename: async () => { sent.push("second"); return "ok" } }
  const third = { rename: async () => { sent.push("third"); return "ok" } }
  let target = first
  const client = resendUnsent(() => target, {
    revision: () => "same-source",
    reconnected: async () => { if (target === first) target = second },
    admit: ({ target: candidate }) => { if (candidate === second) target = third; return true },
  })
  expect(await client.rename()).toBe("ok")
  expect(sent).toEqual(["third"])
})

test("a rejected source fence waits for an admissible connection before sending", async () => {
  const waiting = Promise.withResolvers<void>()
  const changed = Promise.withResolvers<void>()
  const sent: string[] = []
  const first = { rename: async () => { throw new V5ClientError("unsent", "session.rename", undefined, true) } }
  const next = { rename: async () => { sent.push("sent"); return "ok" } }
  let target = first
  let source = "other-source"
  const client = resendUnsent(() => target, {
    revision: () => source,
    reconnected: async () => { target = next },
    waitForChange: () => { waiting.resolve(); return changed.promise },
    admit: () => source === "original-source",
  })
  const result = client.rename()
  await waiting.promise
  expect(sent).toEqual([])
  source = "original-source"
  changed.resolve()
  expect(await result).toBe("ok")
  expect(sent).toEqual(["sent"])
})

test("a closed transport waits for the owner to reconnect before retrying a read", async () => {
  const peers = [new ScriptedPeer("connection-1"), new ScriptedPeer("connection-2")]
  const sockets = sequence(peers, new Set([0, 1]))
  const client = make({ discover: async () => endpoint, socket: sockets.socket })
  const checked = Promise.withResolvers<void>()
  const resilient = resendUnsent(() => client, {
    reconnected: () => client.transport.ready(),
    revision: () => 1,
    admit: () => { checked.resolve(); return client.transport.state !== "closed" },
  })
  peers[1]!.onRequest = (request) => peers[1]!.result(request, { typeName: health_get_ResultSchema.typeName, payload: health() })
  try {
    await client.transport.ready()
    const arrived = peers[0]!.nextRequest()
    const result = resilient.health.get()
    await arrived
    peers[0]!.socket.close()
    await checked.promise
    await client.transport.reconnect()
    expect(await result).toMatchObject({ healthy: true })
    expect(peers.map((peer) => peer.requests.map((request) => request.operation.diagnosticName))).toEqual([["health.get"], ["health.get"]])
  } finally {
    client.transport.close()
  }
}, 5000)

function fenced(admission: boolean, transmits = false) {
  const peers = [new ScriptedPeer("connection-1", transmits ? {} : { normalWindowBytes: 1 }), new ScriptedPeer("connection-2")]
  const sockets = sequence(peers, new Set([0, 1]))
  const client = make({ discover: async () => endpoint, socket: sockets.socket })
  const admitted: unknown[] = []
  const admissionChecked = Promise.withResolvers<void>()
  let reconnects = 0
  const resilient = resendUnsent(() => client, {
    reconnected: () => {
      reconnects++
      return client.transport.reconnect()
    },
    revision: () => 7,
    admit: (request) => {
      admitted.push(request)
      admissionChecked.resolve()
      return admission
    },
  })
  peers[1].onRequest = (dispatch) => peers[1].reject(dispatch)
  return { peers, client, resilient, admitted, admissionChecked: admissionChecked.promise, reconnects: () => reconnects }
}

test("REQ-WIRE-009 a request proven never written is resent once when the fence admits it", async () => {
  const { peers, client, resilient, admitted } = fenced(true)
  const input = { sessionID: "ses_owner", title: "fenced once" }
  try {
    await client.transport.ready()
    const outcome = resilient.session.rename(input).catch((error: unknown) => error)
    await Promise.resolve()
    await Promise.resolve()
    peers[0].socket.close()
    expect(await outcome).toEqual({ _tag: "InvalidRequestError", message: "Scripted rejection" })
    expect(admitted).toHaveLength(1)
    expect(admitted[0]).toMatchObject({ operation: "session.rename", args: [input], issuedRevision: 7 })
    expect((admitted[0] as { issuedOn: unknown; target: unknown }).target).toBe(client)
    expect((admitted[0] as { issuedOn: unknown }).issuedOn).toBe(client)
    expect(peers[0].requests).toHaveLength(0)
    expect(peers[1].requests).toHaveLength(1)
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-009 a request waits without resending when the fence rejects it", async () => {
  const { peers, client, resilient, admitted, admissionChecked } = fenced(false)
  try {
    await client.transport.ready()
    const controller = new AbortController()
    const pending = resilient.session.rename({ sessionID: "ses_owner", title: "fenced out" }, { signal: controller.signal }).catch((error: unknown) => error)
    await Promise.resolve()
    await Promise.resolve()
    peers[0].socket.close()
    await admissionChecked
    controller.abort()
    expect(await pending).toMatchObject({ status: "unsent", operation: "session.rename", reason: "Request cancelled before transmission" })
    expect(admitted).toHaveLength(1)
    expect(peers[0].requests).toHaveLength(0)
    expect(peers[1].requests).toHaveLength(0)
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-009 a request whose transmission is uncertain is never resent and names the changed connection", async () => {
  const { peers, client, resilient, admitted, reconnects } = fenced(true, true)
  try {
    await client.transport.ready()
    const arrived = peers[0].nextRequest()
    const outcome = resilient.session
      .prompt({ sessionID: "ses_owner", text: "uncertain", id: "msg_uncertain_fence" })
      .catch((error: unknown) => error)
    await arrived
    peers[0].socket.close()
    const error = await outcome
    expect(error).toMatchObject({ status: "unknown", operation: "session.prompt", resendable: false })
    expect((error as Error).message).toContain("connection changed")
    expect((error as Error).message).toContain("Your message")
    expect(admitted).toEqual([])
    expect(reconnects()).toBe(0)
    expect(peers[1].requests).toHaveLength(0)
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-009 resendUnsent never resends a cancelled request or a transmitted mutation", async () => {
  const peers = [new ScriptedPeer("connection-1"), new ScriptedPeer("connection-2")]
  const sockets = sequence(peers, new Set([0, 1]))
  const client = make({ discover: async () => endpoint, socket: sockets.socket })
  let reconnects = 0
  const admitted: unknown[] = []
  const resilient = resendUnsent(() => client, {
    reconnected: () => {
      reconnects++
      return client.transport.reconnect()
    },
    revision: () => 7,
    admit: (request) => {
      admitted.push(request)
      return true
    },
  })
  try {
    await client.transport.ready()
    const controller = new AbortController()
    controller.abort()
    const cancelled = await resilient.session
      .rename({ sessionID: "ses_owner", title: "never" }, { signal: controller.signal })
      .catch((error: unknown) => error)
    expect(cancelled).toMatchObject({ status: "unsent", resendable: false })
    const arrived = peers[0].nextRequest()
    const mutation = resilient.session
      .prompt({ sessionID: "ses_owner", text: "uncertain", id: "msg_uncertain" })
      .catch((error: unknown) => error)
    await arrived
    peers[0].socket.dispatchEvent(new Event("error"))
    expect(await mutation).toMatchObject({ status: "unknown", operation: "session.prompt" })
    expect(reconnects).toBe(0)
    expect(admitted).toEqual([])
    expect(peers[0].requests.map((request) => request.operation.diagnosticName)).toEqual(["session.prompt"])
    expect(peers[1].requests).toHaveLength(0)
  } finally {
    client.transport.close()
  }
})

const receivedResync = (peer: ScriptedPeer) => new Promise<void>((resolve) => {
  const listener = (incoming: Event) => {
    if (!(incoming instanceof MessageEvent) || !(incoming.data instanceof ArrayBuffer)) return
    const frame = decodeStrict(FrameSchema, new Uint8Array(incoming.data))
    if (frame.body.case !== "control" || frame.body.value.kind.case !== "resyncRequired") return
    peer.socket.removeEventListener("message", listener)
    resolve()
  }
  peer.socket.addEventListener("message", listener)
})

test("REQ-WIRE-011 scoped ResyncRequired follows earlier events and leaves other scopes delivering", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) => {
    if (dispatch.operation.diagnosticName === "event.subscribe") return peer.subscribe(dispatch, "subscription-global")
    if (dispatch.operation.diagnosticName === "session.log") return peer.subscribe(dispatch, "subscription-log")
    peer.result(dispatch, {
      typeName: event_unsubscribe_ResultSchema.typeName,
      payload: encodeStrict(event_unsubscribe_ResultSchema, create(event_unsubscribe_ResultSchema, { data: {} })),
    })
  }
  const client = make({
    endpoint,
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    const events = client.event.subscribe()[Symbol.asyncIterator]()
    expect((await events.next()).value).toMatchObject({ type: "server.connected" })
    const log = client.session.log({ sessionID: "ses_log", follow: true })[Symbol.asyncIterator]()
    const arrival = peer.nextRequest()
    const first = log.next()
    await arrival
    const invalidation = receivedResync(peer)
    peer.events("subscription-log", [logItem(1), logItem(2)])
    peer.events("subscription-log", [{ typeName: SessionLogItemSchema.typeName, payload: new Uint8Array(300_000) }])
    await invalidation
    expect((await first).value).toMatchObject({ durable: { seq: 1 } })
    expect((await log.next()).value).toMatchObject({ durable: { seq: 2 } })
    expect(await log.next().catch((error: unknown) => error)).toMatchObject({ status: "resync" })
    peer.events("subscription-global", [catalog("evt_after")])
    expect((await events.next()).value).toMatchObject({ id: "evt_after", type: "catalog.updated" })
    expect(client.transport.state).toBe("established")
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-011 a replaced socket cannot interleave frames and the replacement reports its source epoch", async () => {
  const peers = [new ScriptedPeer("connection-1"), new ScriptedPeer("connection-2")]
  peers[1].transform = (bytes) => {
    const frame = decodeStrict(FrameSchema, bytes)
    if (frame.body.case !== "ready") return bytes
    frame.body.value.sourceEpoch = "source-2"
    return encodeStrict(FrameSchema, frame)
  }
  peers.forEach((peer) => {
    peer.onRequest = (dispatch) => peer.subscribe(dispatch)
  })
  const sockets = sequence(peers, new Set([0, 1]))
  const client = make({ discover: async () => endpoint, socket: sockets.socket })
  try {
    const old = client.event.subscribe()[Symbol.asyncIterator]()
    expect((await old.next()).value).toMatchObject({ id: "connection-1", sourceEpoch: "source-1" })
    const interrupted = old.next().catch((error: unknown) => error)
    await client.transport.reconnect()
    expect(await interrupted).toMatchObject({ status: "unknown" })
    const current = client.event.subscribe()[Symbol.asyncIterator]()
    expect((await current.next()).value).toMatchObject({
      type: "server.connected",
      id: "connection-2",
      sourceEpoch: "source-2",
    })
    peers[0].events("subscription-1", [catalog("evt_stale")])
    peers[1].events("subscription-1", [catalog("evt_fresh")], "source-2")
    expect((await current.next()).value).toMatchObject({ id: "evt_fresh" })
    expect(client.transport.sourceEpoch).toBe("source-2")
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-011 a replacement connection discards events still buffered behind a resync", async () => {
  const peers = [new ScriptedPeer("connection-1"), new ScriptedPeer("connection-2")]
  peers[0].onRequest = (dispatch) => peers[0].subscribe(dispatch, "subscription-log")
  const sockets = sequence(peers, new Set([0, 1]))
  const client = make({ discover: async () => endpoint, socket: sockets.socket })
  try {
    const log = client.session.log({ sessionID: "ses_log", follow: true })[Symbol.asyncIterator]()
    const arrival = peers[0].nextRequest()
    const first = log.next()
    await arrival
    const invalidation = receivedResync(peers[0])
    peers[0].events("subscription-log", [logItem(1), logItem(2)])
    peers[0].events("subscription-log", [{ typeName: SessionLogItemSchema.typeName, payload: new Uint8Array(300_000) }])
    await invalidation
    expect((await first).value).toMatchObject({ durable: { seq: 1 } })
    await client.transport.reconnect()
    expect(await log.next().catch((error: unknown) => error)).toMatchObject({ status: "resync" })
    expect(client.transport.connectionEpoch).toBe("connection-2")
  } finally {
    client.transport.close()
  }
})
