import { describe, expect, test } from "bun:test"
import {
  WireLimit,
  create,
  ResultSchema,
  TypedPayloadSchema,
  FrameSchema,
  encodeStrict,
  decodeStrict,
} from "@ycoding-ai/remote"
import { clientFrameDelay, createRemoteTransport, type RemoteTransportStatus } from "../src/remote/transport"
import { startRelayDouble, waitFor } from "./relay-double"

describe("remote transport integration", () => {
  test("paced requests and heartbeats stay inside the relay's fixed window under arrival jitter", () => {
    const sentAt: number[] = []
    const arrivals: { readonly at: number; readonly kind: "request" | "ping" }[] = []
    let now = 0
    for (let index = 0; index < 90; index++) {
      now += clientFrameDelay(sentAt, now)
      sentAt.push(now)
      arrivals.push({ at: now + (index === 0 ? 400 : 0), kind: index % 17 === 0 ? "ping" : "request" })
      now += 1
    }
    let windowStart = -1
    let count = 0
    let maximum = 0
    for (const frame of arrivals.toSorted((left, right) => left.at - right.at)) {
      if (windowStart < 0 || frame.at - windowStart >= WireLimit.RATE_WINDOW_MS) {
        windowStart = frame.at
        count = 0
      }
      count++
      maximum = Math.max(maximum, count)
    }
    expect(arrivals.some((frame) => frame.kind === "ping")).toBe(true)
    expect(maximum).toBeLessThanOrEqual(WireLimit.CLIENT_RATE)
  })
  test("reports explicit inventory invalidation and round-trips a request", async () => {
    const relay = await startRelayDouble({ advertisedSessions: ["ses_a"] })
    let invalidations = 0
    const statuses: RemoteTransportStatus[] = []
    const transport = createRemoteTransport({
      url: relay.wsURL("dev_1"),
      handlers: {
        onStatus: (status) => statuses.push(status),
        onSessions: () => {
          invalidations += 1
        },
      },
      resetDelayMs: 10,
      maxDelayMs: 20,
    })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      expect(invalidations).toBe(0)
      relay.pushSessions(["ses_a"])
      await waitFor(() => invalidations > 0)
      expect(invalidations).toBe(1)
      const response = await transport.request("session.list")
      expect(response.status).toBe("ok")
      if (response.status !== "ok") return
      const list = response.value as { data: { data: readonly { id: string }[] } }
      expect(list.data.data.map((session) => session.id)).toEqual(["ses_a", "ses_b"])
      expect(statuses.some((status) => status.kind === "connecting")).toBe(true)
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("delivers relay notice frames to the handler and settles a notice request", async () => {
    const notice = { id: "ntc_1", category: "agent-completed", sessionID: "ses_a", createdAt: 5 } as const
    const relay = await startRelayDouble({ noticePage: { notices: [notice], total: 1, unavailable: false } })
    const frames: unknown[] = []
    const transport = createRemoteTransport({
      url: relay.wsURL("dev_1"),
      handlers: { onNotices: (frame) => frames.push(frame) },
      resetDelayMs: 10,
    })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      expect(await transport.request("notice.subscribe")).toEqual({
        status: "ok",
        value: { notices: [notice], total: 1, unavailable: false },
      })
      expect(await transport.request("notice.list", { input: { before: "ntc_1" } })).toMatchObject({
        status: "ok",
        value: { total: 1 },
      })
      expect(await transport.request("notice.read", { input: { ids: ["ntc_1"] } })).toEqual({
        status: "ok",
        value: { data: {} },
      })
      expect(await transport.request("notice.readAll")).toEqual({ status: "ok", value: { data: {} } })
      expect(relay.noticeRequests.map((request) => [request.operation, request.input])).toEqual([
        ["notice.subscribe", undefined],
        ["notice.list", { before: "ntc_1" }],
        ["notice.read", { ids: ["ntc_1"] }],
        ["notice.readAll", undefined],
      ])
      relay.pushNotices({ type: "notice.added", notices: [{ ...notice, id: "ntc_2" }], total: 2 })
      relay.pushNotices({ type: "notice.removed", ids: ["ntc_1"], total: 1 })
      relay.pushNotices({ type: "notice.cleared" })
      relay.pushNotices({ type: "notice.unavailable" })
      await waitFor(() => frames.length === 4)
      expect(frames).toEqual([
        { type: "notice.added", notices: [{ ...notice, id: "ntc_2" }], total: 2 },
        { type: "notice.removed", ids: ["ntc_1"], total: 1 },
        { type: "notice.cleared" },
        { type: "notice.unavailable" },
      ])
      expect(transport.status().kind).toBe("open")
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("rejects out-of-order binary bulk pieces without publishing partial content", async () => {
    const relay = await startRelayDouble({
      handler: (request) => {
        if (request.operation !== "session.messages") return { ok: true, value: null }
        return {
          wire: (peer, dispatch) => {
            const send = peer.message.bind(peer)
            peer.message = (raw) => {
              if (typeof raw === "string") throw new Error("Binary fixture required")
              const frame = decodeStrict(FrameSchema, new Uint8Array(raw))
              if (frame.body.case === "bulkPiece" && frame.body.value.index === 0) frame.body.value.index = 1
              send(encodeStrict(FrameSchema, frame).slice().buffer)
            }
            peer.result(dispatch, {
              data: { data: [{ id: "msg_1", type: "system", text: "x".repeat(100_000), time: { created: 1 } }] },
            })
          },
        }
      },
    })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10 })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const response = await transport.request("session.messages", { sessionID: "ses_a" })
      expect(response).toMatchObject({ status: "unknown", error: { code: "outcome_unknown" } })
      await waitFor(() => relay.closeEvents.length > 0)
      expect(relay.closeEvents[0]).toEqual({ code: 1002, reason: "MALFORMED" })
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("assembles a legal multi-frame payload larger than one frame, including multibyte text", async () => {
    const line = "\u65e5\u672c\u8a9e \u30c6\u30ad\u30b9\u30c8 \ud83c\udf0d shell output line\n"
    const output = line.repeat(Math.ceil(1_200_000 / line.length))
    const payload = { data: [{ id: "msg_bulk", type: "system", text: output, time: { created: 1 } }] }
    expect(new TextEncoder().encode(output).byteLength).toBeGreaterThan(WireLimit.INLINE_BODY_BYTES)
    const relay = await startRelayDouble({
      handler: () => ({ ok: true, value: payload }),
    })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10 })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const response = await transport.request("session.messages", { sessionID: "ses_a" })
      expect(response.status).toBe("ok")
      if (response.status !== "ok") return
      expect(response.value).toEqual({ data: payload })
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("rejects a malformed typed protobuf result without publishing partial content", async () => {
    const relay = await startRelayDouble({
      handler: () => ({
        wire: (peer, dispatch) => {
          const send = peer.message.bind(peer)
          peer.message = (raw) => {
            if (typeof raw === "string") throw new Error("Binary fixture required")
            const frame = decodeStrict(FrameSchema, new Uint8Array(raw))
            if (frame.body.case === "result" && frame.body.value.outcome.case === "success")
              frame.body.value.outcome.value.payload = Uint8Array.of(255)
            send(encodeStrict(FrameSchema, frame).slice().buffer)
          }
          peer.result(dispatch, { data: { data: [] } })
        },
      }),
    })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10, requestTimeoutMs: 500 })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const response = await transport.request("session.messages", { sessionID: "ses_a" })
      expect(response).toMatchObject({ status: "unknown", error: { code: "outcome_unknown" } })
      await waitFor(() => relay.closeEvents.length > 0)
      expect(relay.closeEvents[0]).toEqual({ code: 1002, reason: "MALFORMED" })
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("surfaces a typed backend failure above the response budget", async () => {
    const relay = await startRelayDouble({
      handler: () => ({
        ok: false,
        code: "message_too_large",
        message: "Response exceeds the bounded chunk count; read again with after",
      }),
    })
    const transport = createRemoteTransport({
      url: relay.wsURL("dev_1"),
      resetDelayMs: 10,
      createSocket: relay.createSocket,
    })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open").catch(async (cause: unknown) => {
        console.error(
          JSON.stringify({
            diagnostic: "chunk-budget-open",
            transport: transport.status(),
            ...(await relay.diagnostics()),
          }),
        )
        throw cause
      })
      const response = await transport.request("session.messages", { sessionID: "ses_a" })
      expect(response.status).toBe("failed")
      if (response.status !== "failed") return
      expect(response.error).toEqual({
        code: "internal_error",
        message: "Response exceeds the bounded chunk count; read again with after",
      })
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("rejects a binary bulk response with a missing piece", async () => {
    const relay = await startRelayDouble({
      handler: () => ({
        wire: (peer, dispatch) => {
          const send = peer.message.bind(peer)
          peer.message = (raw) => {
            if (typeof raw === "string") throw new Error("Binary fixture required")
            const frame = decodeStrict(FrameSchema, new Uint8Array(raw))
            if (frame.body.case !== "bulkPiece" || frame.body.value.index !== 0) send(raw)
          }
          peer.result(dispatch, {
            data: { data: [{ id: "msg_1", type: "system", text: "x".repeat(100_000), time: { created: 1 } }] },
          })
        },
      }),
    })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10, requestTimeoutMs: 500 })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const response = await transport.request("session.messages", { sessionID: "ses_a" })
      expect(response).toMatchObject({ status: "unknown", error: { code: "outcome_unknown" } })
      await waitFor(() => relay.closeEvents.length > 0)
      expect(relay.closeEvents[0]).toEqual({ code: 1002, reason: "MALFORMED" })
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("a relay without an available agent retires a transmitted read as unknown", async () => {
    const relay = await startRelayDouble({
      handler: () => "close",
    })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10 })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const response = await transport.request("session.list")
      expect(response).toEqual({
        status: "unknown",
        error: { code: "outcome_unknown", message: "The relay connection closed before this request settled" },
      })
      expect(relay.requests).toHaveLength(1)
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("marks an in-flight request unknown when the agent connection is replaced", async () => {
    const relay = await startRelayDouble({ handler: () => "close" })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10 })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const response = await transport.request("session.prompt", { sessionID: "ses_a", input: { text: "hi" } })
      expect(response.status).toBe("unknown")
      if (response.status !== "unknown") return
      expect(response.error.code).toBe("outcome_unknown")
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("times out a silent request as unknown instead of retrying it", async () => {
    const relay = await startRelayDouble({ handler: () => "silent" })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10, requestTimeoutMs: 40 })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const response = await transport.request("session.interrupt", { sessionID: "ses_a" })
      expect(response.status).toBe("unknown")
      expect(relay.requests).toHaveLength(1)
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("bounds in-flight requests and refuses further work without sending it", async () => {
    const relay = await startRelayDouble({ handler: () => "silent" })
    const transport = createRemoteTransport({
      url: relay.wsURL("dev_1"),
      resetDelayMs: 10,
      maxInFlight: 1,
      requestTimeoutMs: 200,
    })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const first = transport.request("session.list")
      const second = await transport.request("session.list")
      expect(second).toEqual({ status: "unavailable", reason: "in-flight-limit" })
      await waitFor(() => relay.requests.length === 1)
      await first
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("refuses work while the socket is not open", async () => {
    const transport = createRemoteTransport({ url: "ws://127.0.0.1:1/ws/v5/client", resetDelayMs: 10 })
    expect(await transport.request("session.list")).toEqual({ status: "unavailable", reason: "not-connected" })
    transport.close()
  })

  test("answers relay pings and drops non-retryable authorization closes", async () => {
    const relay = await startRelayDouble()
    const statuses: RemoteTransportStatus[] = []
    const transport = createRemoteTransport({
      url: relay.wsURL("dev_1"),
      handlers: { onStatus: (status) => statuses.push(status) },
      resetDelayMs: 10,
      maxDelayMs: 20,
    })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      relay.dropConnections(4401, "credential revoked")
      await waitFor(() => statuses.some((status) => status.kind === "closed"))
      const closed = statuses.find((status) => status.kind === "closed")
      expect(closed).toMatchObject({ code: 4401, retryable: false })
      await Bun.sleep(60)
      expect(relay.connections).toBe(1)
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("reconnects after a retryable close and asks for a read-only reload", async () => {
    const relay = await startRelayDouble()
    let reconnects = 0
    const transport = createRemoteTransport({
      url: relay.wsURL("dev_1"),
      handlers: { onReconnect: () => (reconnects += 1) },
      resetDelayMs: 10,
      maxDelayMs: 20,
    })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      relay.dropConnections(1006, "")
      await waitFor(() => reconnects > 0, 3_000)
      expect(transport.status().kind).toBe("open")
      expect(relay.connections).toBeGreaterThanOrEqual(2)
    } finally {
      transport.close()
      await relay.stop()
    }
  })
})
