import { expect, test } from "bun:test"
import { create, encodeStrict, encodeLossless, health_get_ResultSchema } from "@ycoding-ai/protocol/v5"
import { make } from "../src/v5/index.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

test.each([0, 65536, 65537])("asset socket consumes metadata once and releases a %i-byte body", async (length) => {
  const peer = new ScriptedPeer()
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  const data = new Uint8Array(length).fill(255)
  peer.onRequest = (dispatch) => {
    if (dispatch.operation.diagnosticName === "health.get") {
      peer.result(dispatch, {
        typeName: health_get_ResultSchema.typeName,
        payload: encodeStrict(
          health_get_ResultSchema,
          create(health_get_ResultSchema, {
            data: {
              healthy: true,
              version: encodeLossless("fixture"),
              pid: 1n,
              sourceEpoch: encodeLossless("source-1"),
            },
          }),
        ),
      })
      return
    }
    peer.asset(dispatch, data)
  }
  try {
    for (let repeat = 0; repeat < 3; repeat++) {
      const read = await client.session.attachment.read({ sessionID: "ses_asset", digest: "a".repeat(64) })
      expect(read).toEqual({
        mime: "application/octet-stream",
        bytes: length,
        data: Buffer.from(data).toString("base64"),
      })
      expect((await client.health.get()).healthy).toBe(true)
      expect(client.transport.state).toBe("established")
    }
  } finally {
    client.transport.close()
  }
  expect(client.transport.retainedBytes).toBe(0)
})
