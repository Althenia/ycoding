import { expect, test } from "bun:test"
import { operations } from "@ycoding-ai/protocol/v5"
import { make } from "../src/v5/index.js"
import { decodeDomain, encodeDomain } from "../src/v5/codec.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

const status = {
  access: { enabled: true, revision: 7 },
  configuration: { ready: true, profile: "Synthetic" },
  connection: { state: "connected", hostname: "fixture" },
} as const

test("global Dots and Usage dashboard use machine-scoped native operations", async () => {
  const peer = new ScriptedPeer()
  const expected = [
    { name: "dots.get", id: 2068, result: status },
    { name: "dots.set", id: 2069, payload: { enabled: true, expectedRevision: 6 }, result: status },
    { name: "usage.dashboard", id: 2070, payload: { refresh: true }, result: { status: "preparing" } },
  ]
  peer.onRequest = (dispatch) => {
    const entry = expected[peer.requests.length - 1]!
    expect(dispatch.operation.diagnosticName).toBe(entry.name)
    expect(dispatch.operation.operationId).toBe(entry.id)
    expect(dispatch.request.scope?.target.case).toBe("machine")
    const request = decodeDomain(dispatch.operation.requestType, dispatch.request.payload)
    if (entry.payload) expect(request).toMatchObject({ payload: entry.payload })
    peer.result(dispatch, {
      typeName: dispatch.operation.resultType,
      payload: encodeDomain(dispatch.operation.resultType, { data: entry.result }),
    })
  }
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    location: { directory: "/fixture", workspaceID: "workspace_fixture" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    expect(await client.dots.get()).toEqual(status)
    expect(await client.dots.set({ enabled: true, expectedRevision: 6 })).toEqual(status)
    expect(await client.usage.dashboard({ refresh: true })).toEqual({ status: "preparing" })
    expect(peer.requests).toHaveLength(3)
  } finally {
    client.transport.close()
  }
})

test("retired Dots and incoming MCP controls are not native operations", () => {
  const retired = new Set([3054, 3055, 5044, ...Array.from({ length: 12 }, (_, index) => 4090 + index)])
  expect(operations.filter((operation) => retired.has(operation.operationId))).toEqual([])
})
