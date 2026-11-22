import { expect, test } from "bun:test"
import { ResultSchema, TypedPayloadSchema, create, remotePayloadCodecs } from "@ycoding-ai/remote"
import type { RemoteRequestTiming } from "../src/remote/transport"
import { writeWireMessage } from "../src/remote/wire"
import { requestView, transportFixture } from "./wire-peer"

test("message deletion sends operation 4112 and records the connector name after settlement", async () => {
  const timings: RemoteRequestTiming[] = []
  const { transport, sockets, advance } = transportFixture({
    handlers: { onRequestTiming: (sample) => timings.push(sample) },
  })
  try {
    const sessionID = "ses_delete"
    const messageID = "msg_unread"
    const pending = transport.request("session.message.delete", { sessionID, input: { messageID } })
    const [socket] = sockets
    const [dispatch] = socket!.dispatches
    expect(dispatch!.operation.operationId).toBe(4112)
    expect(requestView(dispatch!)).toMatchObject({ operation: "session.deleteMessage", sessionID, input: { messageID } })
    expect(timings).toEqual([])
    advance(17)
    socket!.result(dispatch!, { data: {} })
    expect(await pending).toMatchObject({ status: "ok" })
    expect(timings).toEqual([
      { operation: "session.message.delete", outcome: "ok", queueMs: 0, settlementMs: 17, totalMs: 17 },
    ])
  } finally {
    transport.close()
  }
})

test("message deletion records the connector name when no connection is open", async () => {
  const timings: RemoteRequestTiming[] = []
  const { transport, sockets } = transportFixture({
    open: false,
    handlers: { onRequestTiming: (sample) => timings.push(sample) },
  })
  try {
    expect(
      await transport.request("session.message.delete", {
        sessionID: "ses_delete",
        input: { messageID: "msg_unread" },
      }),
    ).toEqual({ status: "unavailable", reason: "not-connected" })
    expect(sockets[0]!.dispatches).toHaveLength(0)
    expect(timings).toEqual([
      { operation: "session.message.delete", outcome: "unavailable", reason: "not-connected", queueMs: 0, totalMs: 0 },
    ])
  } finally {
    transport.close()
  }
})

test.each([
  ["read", "message_read", "YCoding has already read this message."],
  ["not_owned", "message_not_owned", "You can only delete your own messages."],
] as const)("message deletion returns the typed %s refusal without replaying the request", async (reason, code, message) => {
  const { transport, sockets, advance } = transportFixture()
  try {
    const sessionID = "ses_delete"
    const messageID = "msg_sent"
    const pending = transport.request("session.message.delete", { sessionID, input: { messageID } })
    const [socket] = sockets
    const [dispatch] = socket!.dispatches
    expect(dispatch!.operation.operationId).toBe(4112)
    expect(requestView(dispatch!)).toMatchObject({ operation: "session.deleteMessage", sessionID, input: { messageID } })

    const typeName = "ycoding.v5.MessageDeleteRefusedError"
    const codec = remotePayloadCodecs.get("session.deleteMessage")!.errors.get(typeName)!
    socket!.body({
      case: "result",
      value: create(ResultSchema, {
        requestId: dispatch!.requestID,
        operationId: dispatch!.operation.operationId,
        settlement: dispatch!.operation.settlement,
        outcome: {
          case: "error",
          value: create(TypedPayloadSchema, {
            typeName,
            payload: codec.encode(writeWireMessage(codec.schema, {
              _tag: "MessageDeleteRefusedError", sessionID, messageID, reason, message: "The server refused the mutation",
            })),
          }),
        },
      }),
    })
    expect(await pending).toEqual({ status: "failed", error: { code, message } })
    advance(30_000)
    expect(socket!.dispatches).toHaveLength(1)
  } finally {
    transport.close()
  }
})

test("message deletion does not replay after the socket drops before settlement", async () => {
  const { transport, sockets, statuses, advance } = transportFixture()
  try {
    const pending = transport.request("session.message.delete", { sessionID: "ses_delete", input: { messageID: "msg_sent" } })
    expect(sockets[0]!.dispatches).toHaveLength(1)
    sockets[0]!.drop()
    expect(await pending).toMatchObject({ status: "unknown", error: { code: "outcome_unknown" } })
    const reconnect = statuses.at(-1)
    if (reconnect?.kind !== "reconnecting") throw new Error("No reconnect was scheduled after the socket dropped")
    advance(reconnect.delayMs)
    expect(sockets).toHaveLength(2)
    sockets[1]!.open()
    expect(sockets[1]!.dispatches).toHaveLength(0)
  } finally {
    transport.close()
  }
})
