import { describe, expect, test } from "bun:test"
import { RemoteLimits, serializeResponse } from "@ycoding-ai/remote"
import { createRemoteTransport, type RemoteTransportStatus } from "../src/remote/transport"
import { startRelayDouble, waitFor } from "./relay-double"

describe("remote transport integration", () => {
  test("reports the session advertisement and round-trips a request", async () => {
    const relay = await startRelayDouble({ advertisedSessions: ["ses_a"] })
    let invalidations = 0
    const statuses: RemoteTransportStatus[] = []
    const transport = createRemoteTransport({
      url: relay.wsURL("dev_1"),
      handlers: {
        onStatus: (status) => statuses.push(status),
        onSessions: () => { invalidations += 1 },
      },
      resetDelayMs: 10,
      maxDelayMs: 20,
    })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      await waitFor(() => invalidations > 0)
      expect(invalidations).toBe(1)
      const response = await transport.request("session.list")
      expect(response.status).toBe("ok")
      if (response.status !== "ok") return
      const list = response.value as { data: readonly { id: string }[] }
      expect(list.data.map((session) => session.id)).toEqual(["ses_a", "ses_b"])
      expect(statuses.some((status) => status.kind === "connecting")).toBe(true)
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("assembles an out-of-order chunked response into one value", async () => {
    const relay = await startRelayDouble({
      handler: (request) => {
        if (request.operation !== "session.messages") return { ok: true, value: null }
        const json = JSON.stringify({ data: [{ id: "msg_1", type: "system", text: "hello", time: { created: 1 } }] })
        const third = Math.ceil(json.length / 3)
        return {
          ok: true,
          value: null,
          chunks: [
            { index: 1, slice: json.slice(third, third * 2) },
            { index: 0, slice: json.slice(0, third) },
            { index: 2, slice: json.slice(third * 2) },
          ],
        }
      },
    })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10 })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const response = await transport.request("session.messages", { sessionID: "ses_a" })
      expect(response.status).toBe("ok")
      if (response.status !== "ok") return
      expect(response.value).toMatchObject({ data: [{ id: "msg_1", text: "hello" }] })
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("assembles a legal multi-frame payload larger than one frame, including multibyte text", async () => {
    // Measured case: a ~1 MiB shell capture is above the agent's single-frame
    // bound, so the agent chunks it. It must assemble instead of failing at one frame.
    const line = "\u65e5\u672c\u8a9e \u30c6\u30ad\u30b9\u30c8 \ud83c\udf0d shell output line\n"
    const output = line.repeat(Math.ceil(1_200_000 / line.length))
    const payload = { data: { id: "sh_1", output, cursor: 0, size: output.length } }
    const text = JSON.stringify(payload)
    expect(text.length).toBeGreaterThan(RemoteLimits.maxAgentMessageChars)
    // 32 768 code units stays inside the agent frame bound even if every
    // character escaped to six characters, so each emitted slice is legal.
    const sliceChars = 32_768
    const parts: string[] = []
    for (let offset = 0; offset < text.length; offset += sliceChars) parts.push(text.slice(offset, offset + sliceChars))
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.length).toBeLessThanOrEqual(RemoteLimits.maxChunksPerResponse)
    // The transport generates shorter ids than this placeholder, so a frame that
    // fits here always fits on the real wire.
    const placeholderID = `req_${"0".repeat(40)}`
    for (const [index, slice] of parts.entries()) {
      const raw = serializeResponse({
        type: "response",
        id: placeholderID,
        ok: true,
        value: slice,
        chunk: { index, last: index === parts.length - 1 },
      })
      expect(raw.length).toBeLessThanOrEqual(RemoteLimits.maxAgentMessageChars)
    }
    const relay = await startRelayDouble({
      handler: () => ({ ok: true, value: null, chunks: parts.map((slice, index) => ({ index, slice })) }),
    })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10 })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const response = await transport.request("session.snapshot", { sessionID: "ses_a" })
      expect(response.status).toBe("ok")
      if (response.status !== "ok") return
      expect(response.value).toEqual(payload)
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("rejects a chunked response whose slices assemble into malformed JSON", async () => {
    const relay = await startRelayDouble({
      handler: () => ({
        ok: true,
        value: null,
        chunks: [
          { index: 0, slice: '{"data":[1,' },
          { index: 1, slice: "2" },
        ],
      }),
    })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10, requestTimeoutMs: 500 })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const response = await transport.request("session.messages", { sessionID: "ses_a" })
      expect(response.status).toBe("failed")
      if (response.status !== "failed") return
      expect(response.error.code).toBe("invalid_message")
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("surfaces the agent's explicit failure above the chunk budget", async () => {
    const relay = await startRelayDouble({
      handler: () => ({
        ok: false,
        code: "message_too_large",
        message: "Response exceeds the bounded chunk count; read again with after",
      }),
    })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10 })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const response = await transport.request("session.messages", { sessionID: "ses_a" })
      expect(response.status).toBe("failed")
      if (response.status !== "failed") return
      expect(response.error.code).toBe("message_too_large")
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("rejects a chunked response with a missing slice", async () => {
    const relay = await startRelayDouble({
      handler: () => ({
        ok: true,
        value: null,
        chunks: [
          { index: 0, slice: '{"data":[' },
          { index: 2, slice: "1]}" },
        ],
      }),
    })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10, requestTimeoutMs: 500 })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const response = await transport.request("session.list")
      expect(response.status).toBe("failed")
      if (response.status !== "failed") return
      expect(response.error.code).toBe("invalid_message")
    } finally {
      transport.close()
      await relay.stop()
    }
  })

  test("surfaces relay error codes such as an unavailable agent", async () => {
    const relay = await startRelayDouble({
      handler: () => ({ ok: false, code: "agent_unavailable", message: "No agent is connected" }),
    })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10 })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const response = await transport.request("session.list")
      expect(response).toEqual({
        status: "failed",
        error: { code: "agent_unavailable", message: "No agent is connected" },
      })
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
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1"), resetDelayMs: 10, maxInFlight: 1, requestTimeoutMs: 200 })
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
    const transport = createRemoteTransport({ url: "ws://127.0.0.1:1/ws/v3/client", resetDelayMs: 10 })
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
