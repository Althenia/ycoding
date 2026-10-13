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
  decodeLossless,
} from "@ycoding-ai/protocol/v5"
import { make } from "../src/v5/index.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

const endpoint = { url: "http://127.0.0.1:12345" }
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
    if (frame.body.case === "ready") frame.body.value.contractDigest = new Uint8Array(32)
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
    await expect(client.health.get()).rejects.toMatchObject({ status: "protocol" })
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

test("Session-owned Form paths work; global Form paths fail explicitly before transmission", async () => {
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
    await expect(client.form.cancel({ sessionID: "global", formID: "form_global" })).rejects.toMatchObject({
      status: "unsupported",
      operation: "form.cancel",
    })
    await expect(
      client.form.reply({ sessionID: "global", formID: "form_global", answer: { field: "value" } }),
    ).rejects.toMatchObject({ status: "unsupported", operation: "form.reply" })
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

test("REQ-WIRE-006 Session creation scopes match explicit and configured Location selectors", async () => {
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
  } finally {
    client.transport.close()
  }
})
