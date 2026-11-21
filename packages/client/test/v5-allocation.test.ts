import { expect, test } from "bun:test"
import { operations, PeerRole } from "@ycoding-ai/protocol/v5"
import { make } from "../src/v5/index.js"
import { decodeDomain, encodeDomain } from "../src/v5/codec.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

const status = {
  access: { enabled: true, revision: 7 },
  configuration: { ready: true, profile: "Synthetic" },
  connection: { state: "connected", hostname: "fixture" },
  computer: { state: "attached" },
} as const

const items = [
  {
    kind: "permission",
    sessionID: "ses_one",
    sessionTitle: "One",
    directory: "/one",
    id: "per_one",
    summary: "Allow read",
    decide: [{ label: "Allow", argv: ["ycoding", "decision", "reply", "per_one", "once"] }],
  },
  {
    kind: "form",
    sessionID: "ses_two",
    sessionTitle: "Two",
    directory: "/two",
    id: "frm_two",
    summary: "Pick",
    options: [{ key: "choice", type: "string" }],
    decide: [{ label: "Answer", argv: ["ycoding", "decision", "answer", "frm_two"], template: true, hint: "--choice" }],
  },
] as const

test("computer attachment and the decision list dispatch as local machine operations without session or location input", async () => {
  const peer = new ScriptedPeer()
  const expected = [
    { name: "dots.attach", id: 2071, payload: { replaceOthers: true }, result: status, roles: [PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY] },
    { name: "decision.list", id: 4102, payload: undefined, result: items, roles: [PeerRole.LOCAL_CLIENT] },
  ]
  peer.onRequest = (dispatch) => {
    const entry = expected[peer.requests.length - 1]
    expect(dispatch.operation.diagnosticName).toBe(entry.name)
    expect(dispatch.operation.operationId).toBe(entry.id)
    expect(dispatch.operation.roles).toEqual(entry.roles)
    expect(dispatch.request.scope?.target.case).toBe("machine")
    const request = decodeDomain(dispatch.operation.requestType, dispatch.request.payload)
    if (entry.payload) expect(request).toEqual({ payload: entry.payload })
    else expect(request).toEqual({})
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
    expect(await client.dots.attach({ replaceOthers: true })).toEqual(status)
    expect(await client.decision.list()).toEqual(items)
    expect(peer.requests).toHaveLength(2)
  } finally {
    client.transport.close()
  }
})

test("the attach payload is never defaulted or coerced into the authorized literal true", () => {
  const name = operations.find((operation) => operation.diagnosticName === "dots.attach")!.requestType
  const encoded = encodeDomain(name, { payload: { replaceOthers: true } })
  expect(decodeDomain(name, encoded)).toEqual({ payload: { replaceOthers: true } })
  expect(decodeDomain(name, encodeDomain(name, { payload: { replaceOthers: false } }))).toEqual({
    payload: { replaceOthers: false },
  })
  for (const payload of [
    {},
    { replaceOthers: undefined },
    { replaceOthers: "true" },
    { replaceOthers: 1 },
    { extra: true },
  ])
    expect(() => encodeDomain(name, { payload }), JSON.stringify(payload)).toThrow()
  expect(() => encodeDomain(name, {})).toThrow()
})
