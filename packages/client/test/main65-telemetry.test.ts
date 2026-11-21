import { expect, test } from "bun:test"
import { CONTRACT_DIGEST } from "@ycoding-ai/protocol/v5"
import type { TelemetryPage } from "../src/promise/index.js"
import { make } from "../src/v5/index.js"
import type { V5Client } from "../src/v5/index.js"
import { decodeDomain, encodeDomain } from "../src/v5/codec.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

type V5Page = Awaited<ReturnType<V5Client["server"]["telemetry"]["list"]>>
type HttpOperation = Extract<TelemetryPage["data"][number]["sample"], { kind: "request" }>["operation"]
type V5Operation = Extract<V5Page["data"][number]["sample"], { kind: "request" }>["operation"]
type V5Append = Parameters<V5Client["server"]["telemetry"]["append"]>[0]
type V5AppendOperation = Extract<V5Append["samples"][number], { kind: "request" }>["operation"]
const contractTypes: [
  TelemetryPage extends V5Page ? true : false,
  V5Page extends TelemetryPage ? true : false,
  "artifact.demo.preview" extends HttpOperation | V5Operation ? false : true,
  "session.message.delete" extends V5Operation ? true : false,
  "session.message.delete" extends V5AppendOperation ? true : false,
  "session.deleteMessage" extends V5AppendOperation ? true : false,
] = [true, true, true, true, true, true]

test("HTTP and v5 expose the same telemetry page contract", async () => {
  expect(contractTypes).toEqual([true, true, true, true, true, true])
  const types = await Bun.file(new URL("../src/promise/generated/types.ts", import.meta.url)).text()
  expect(types).toMatch(
    /export type TelemetryPage = \{ data: Array<\{ receivedAt: number; sample: TelemetrySample \}>; cursor: \{ next\?: string \} \}/,
  )
  expect(CONTRACT_DIGEST).toBe("d5f41604d11dc02a212300b3e387bb51bbb8554537fe3f428891a22f180969c5")
})

test("v5 telemetry append preserves the connector delete label", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) => peer.result(dispatch, {
    typeName: dispatch.operation.resultType,
    payload: encodeDomain(dispatch.operation.resultType, { accepted: 2 }),
  })
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  const request = {
    kind: "request", at: "2026-01-01T00:00:00.000Z", operation: "session.message.delete",
    outcome: "ok", queueMs: 1, settlementMs: 2, totalMs: 3,
  } as const
  const longTask = { kind: "long-task", at: request.at, durationMs: 64 } as const
  try {
    expect(await client.server.telemetry.append({ samples: [request, longTask] })).toEqual({ accepted: 2 })
    expect(peer.requests).toHaveLength(1)
    const dispatch = peer.requests[0]
    expect(dispatch.operation.operationId).toBe(3046)
    expect(decodeDomain(dispatch.operation.requestType, dispatch.request.payload)).toEqual({
      payload: { samples: [request, longTask] },
    })
    expect(request.operation).toBe("session.message.delete")
  } finally {
    client.transport.close()
  }
})

test("v5 telemetry list returns the canonical samples and cursor", async () => {
  const peer = new ScriptedPeer()
  const page: V5Page = {
    data: [
      {
        receivedAt: 7,
        sample: {
          kind: "request",
          at: "2026-01-01T00:00:00.000Z",
          operation: "session.message.delete",
          outcome: "ok",
          queueMs: 0,
          settlementMs: 1,
          totalMs: 1,
        },
      },
    ],
    cursor: { next: "next" },
  }
  const pages: V5Page[] = [{ data: [], cursor: {} }, page]
  peer.onRequest = (dispatch) =>
    peer.result(dispatch, {
      typeName: dispatch.operation.resultType,
      payload: encodeDomain(dispatch.operation.resultType, { data: pages[peer.requests.length - 1] }),
    })
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    expect(await client.server.telemetry.list()).toEqual(pages[0])
    expect(await client.server.telemetry.list()).toEqual(page)
    expect(peer.requests.map((request) => request.operation.diagnosticName)).toEqual([
      "telemetry.list",
      "telemetry.list",
    ])
  } finally {
    client.transport.close()
  }
})
