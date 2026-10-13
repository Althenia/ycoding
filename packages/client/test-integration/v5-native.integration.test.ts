import { expect, test } from "bun:test"
import { create, encodeStrict, health_get_ResultSchema } from "@ycoding-ai/protocol/v5"
import { make } from "../src/v5/index.js"
import { ScriptedPeer } from "../test/fixture/v5-peer.js"

test("REQ-WIRE-002/006 native Bun WebSocket carries authenticated binary frames", async () => {
  const peer = new ScriptedPeer()
  const upgrades: { path: string; authorization: string | null }[] = []
  peer.onRequest = (dispatch) =>
    peer.result(dispatch, {
      typeName: health_get_ResultSchema.typeName,
      payload: encodeStrict(
        health_get_ResultSchema,
        create(health_get_ResultSchema, {
          data: {
            healthy: true,
            version: { encoding: { case: "utf8", value: "fixture" } },
            pid: 1n,
            sourceEpoch: { encoding: { case: "utf8", value: "source-1" } },
          },
        }),
      ),
    })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      upgrades.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") })
      if (request.headers.get("authorization") !== "Basic Zml4dHVyZS1vd25lcjo=")
        return new Response(null, { status: 401 })
      if (server.upgrade(request)) return
      return new Response(null, { status: 400 })
    },
    websocket: {
      open(socket) {
        peer.socket.deliver = (bytes) => {
          socket.send(bytes)
        }
      },
      message(_socket, data) {
        if (typeof data === "string") throw new Error("Expected binary WebSocket frame")
        peer.receive(data)
      },
    },
  })
  const client = make({
    endpoint: {
      url: `http://127.0.0.1:${server.port}`,
      auth: { type: "basic", username: "fixture-owner", password: "" },
    },
  })
  try {
    expect(await client.health.get()).toEqual({ healthy: true, version: "fixture", pid: 1, sourceEpoch: "source-1" })
    expect(upgrades).toEqual([{ path: "/ws/v5/local", authorization: "Basic Zml4dHVyZS1vd25lcjo=" }])
  } finally {
    client.transport.close()
    await server.stop(true)
  }
})
