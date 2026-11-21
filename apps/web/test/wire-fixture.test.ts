import { expect, test } from "bun:test"
import {
  create,
  decodeStrict,
  FailureCategory,
  FrameSchema,
  ResultSchema,
  TypedPayloadSchema,
  type Frame,
} from "@ycoding-ai/remote"
import { createRemoteTransport } from "../src/remote/transport"
import { REMOTE_SCENARIOS } from "../verify/remote-scenarios"
import { startRelayDouble, waitFor } from "./relay-double"
import { typedFixtureOutcome } from "./wire-fixture"
import { BinarySocket, transportFixture } from "./wire-peer"

const scenarios = [...new Map(REMOTE_SCENARIOS.map((scenario) => [scenario.name, scenario])).values()].filter(
  (scenario) => scenario.sessions.length > 0,
)

test.each(scenarios)("public scenario $name retains its transcript through the v5 snapshot contract", (scenario) => {
  const outcome = typedFixtureOutcome("session.snapshot", {
    status: "ok",
    value: {
      sourceEpoch: "fixture-epoch",
      session: scenario.sessions[0],
      messages: scenario.messages,
      watermark: { type: "log.synced", aggregateID: scenario.sessions[0]!.id, seq: 1 },
    },
  })
  expect(outcome).toMatchObject({ status: "ok", value: { data: { messages: scenario.messages } } })
})

function observedClient(options: { readonly confirming: boolean }) {
  const deliveries: string[] = []
  const held: Uint8Array[] = []
  const fixture = transportFixture({
    open: !options.confirming,
    handlers: {
      onSessions: () => deliveries.push("sessions"),
      onSessionStatus: () => deliveries.push("status"),
    },
  })
  const socket = fixture.sockets[0]!
  if (options.confirming) {
    // The client reports open, but the relay peer has not yet received its first ping.
    let forwarded = 0
    socket.send = (data: Uint8Array) => {
      if (forwarded++ === 0) return BinarySocket.prototype.send.call(socket, data)
      held.push(data)
    }
    socket.open()
  }
  return {
    fixture,
    socket,
    deliveries,
    release: () => {
      socket.send = BinarySocket.prototype.send
      for (const data of held.splice(0)) socket.send(data)
      fixture.advance(0)
    },
  }
}

test("fixture pushes made before the relay peer is established are retained and delivered once in order", () => {
  const client = observedClient({ confirming: true })
  expect(client.socket.connection.state).toBe("confirm")

  client.socket.control({ case: "status", value: { running: ["ses_a"], attention: [] } })
  client.socket.control({ case: "inventoryInvalidated", value: {} })
  expect(client.socket.connection.state).toBe("confirm")
  expect(client.deliveries).toEqual([])

  client.release()
  expect(client.socket.connection.state).toBe("established")
  expect(client.deliveries).toEqual(["status", "sessions"])

  client.fixture.advance(0)
  expect(client.deliveries).toEqual(["status", "sessions"])
})

test("a fixture push after the relay peer is established is delivered once", () => {
  const client = observedClient({ confirming: false })
  expect(client.socket.connection.state).toBe("established")
  client.socket.control({ case: "inventoryInvalidated", value: {} })
  client.fixture.advance(0)
  client.fixture.advance(0)
  expect(client.deliveries).toEqual(["sessions"])
})

test("a Status control frame delivers its lost identifiers beside the failed ones", () => {
  const statuses: unknown[] = []
  const fixture = transportFixture({ open: true, handlers: { onSessionStatus: (status) => statuses.push(status) } })
  fixture.sockets[0]!.control({
    case: "status",
    value: {
      running: [],
      attention: ["ses_a", "ses_b"],
      failed: { items: ["ses_a"] },
      lost: { items: ["ses_b"] },
    },
  })
  fixture.advance(0)
  expect(statuses).toEqual([{ running: [], attention: ["ses_a", "ses_b"], failed: ["ses_a"], lost: ["ses_b"] }])
})

test("a rejected fixture body names the close category of the connection", () => {
  const client = observedClient({ confirming: false })
  const body: Frame["body"] = {
    case: "result",
    value: create(ResultSchema, {
      requestId: "req_unknown",
      operationId: 1,
      settlement: 1,
      outcome: {
        case: "success",
        value: create(TypedPayloadSchema, { typeName: "fixture.Unknown", payload: new Uint8Array() }),
      },
    }),
  }
  expect(() => client.socket.body(body)).toThrow(/MALFORMED/)
})

test("a fixture push to a closed relay peer is reported", () => {
  const client = observedClient({ confirming: false })
  client.socket.connection.close(FailureCategory.LIMIT)
  expect(() => client.socket.control({ case: "inventoryInvalidated", value: {} })).toThrow(/closed/i)
  expect(client.deliveries).toEqual([])
})

test("closing the relay peer while it is confirming discards queued pushes", () => {
  const client = observedClient({ confirming: true })
  client.socket.control({ case: "inventoryInvalidated", value: {} })

  client.socket.close(1000)
  expect(client.socket.readyState).toBe(3)
  expect(client.socket.connection.state).toBe("closed")
  expect(() => client.socket.control({ case: "inventoryInvalidated", value: {} })).toThrow(/closed/i)

  client.release()
  expect(client.deliveries).toEqual([])
})

test("a log reply to a closed relay peer is dropped", () => {
  const client = observedClient({ confirming: false })
  client.socket.connection.close(FailureCategory.LIMIT)
  expect(() => client.socket.log("ses_a", "log-1", [], 0)).not.toThrow()
})

test("an intentional relay close while the peer is confirming delivers no queued push", async () => {
  const relay = await startRelayDouble({ advertisedSessions: [] })
  const socket = relay.createSocket(relay.wsURL("dev_1"))
  const frames: Frame[] = []
  socket.binaryType = "arraybuffer"
  socket.addEventListener("message", (event) => frames.push(decodeStrict(FrameSchema, new Uint8Array(event.data))))
  const closed = new Promise((resolve) => socket.addEventListener("close", resolve))
  try {
    await waitFor(() => relay.connections === 1)
    relay.pushStatus(["ses_a"], [])
    relay.dropConnections(1000, "")
    await closed
    expect(relay.closeEvents).toHaveLength(1)
    expect(frames.filter((frame) => frame.body.case === "control")).toEqual([])
  } finally {
    await relay.stop()
  }
})

test.each(["session.log", "notice.list"] as const)(
  "a %s reply that the relay settles after its connection closed is dropped",
  async (operation) => {
    const settle = Promise.withResolvers<void>()
    const relay = await startRelayDouble({
      advertisedSessions: ["ses_a"],
      handler: async (request) => {
        if (request.operation !== "session.log") return "default"
        await settle.promise
        return { ok: true, value: { data: [] } }
      },
      noticeHandler: () => settle.promise,
    })
    const transport = createRemoteTransport({ url: relay.wsURL("dev_1") })
    const unhandled: unknown[] = []
    const record = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", record)
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      const reply = transport.request(operation, {
        ...(operation === "session.log"
          ? { sessionID: "ses_a", input: { after: 0, follow: false } }
          : { input: { before: "ntc_1" } }),
      })
      await waitFor(() => relay.requests.length + relay.noticeRequests.length > 0)
      relay.dropConnections(1000, "")
      transport.close()
      await waitFor(() => relay.closeEvents.length > 0)
      await reply
      settle.resolve()
      await Bun.sleep(5)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", record)
      settle.resolve()
      transport.close()
      await relay.stop()
    }
  },
)
