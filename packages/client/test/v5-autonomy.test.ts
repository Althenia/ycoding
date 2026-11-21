import { expect, test } from "bun:test"
import { make } from "../src/v5/index.js"
import { decodeDomain, encodeDomain } from "../src/v5/codec.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

test.each([
  { permissions: "yolo" },
  { guardrails: "auto" },
  { answers: "manual" },
  { permissions: "auto", guardrails: "manual", answers: "yolo" },
  { guardrails: "yolo", answers: "auto" },
] as const)("autonomy mutation %j preserves Session scope and effective category modes", async (payload) => {
  const peer = new ScriptedPeer()
  const view = {
    mode: "normal",
    permissions: "manual",
    guardrails: "manual",
    answers: "manual",
    ...payload,
    effective: {
      permissions: "yolo",
      guardrails: "manual",
      answers: "auto",
      inherited: { permissions: "ses_parent" },
      deferred: false,
      guardrailsEnabled: true,
    },
  } as const
  peer.onRequest = (dispatch) => {
    expect(dispatch.operation.diagnosticName).toBe("session.autonomy.set")
    expect(dispatch.request.scope?.target).toEqual({ case: "session", value: "ses_owner" })
    expect(decodeDomain(dispatch.operation.requestType, dispatch.request.payload)).toEqual({
      params: { sessionID: "ses_owner" },
      payload,
    })
    peer.result(dispatch, {
      typeName: dispatch.operation.resultType,
      payload: encodeDomain(dispatch.operation.resultType, { data: view }),
    })
  }
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    expect(await client.session.autonomy.set({ sessionID: "ses_owner", payload })).toEqual(view)
    expect(peer.requests).toHaveLength(1)
  } finally {
    client.transport.close()
  }
})

test("autonomy codec rejects retired controls, unknown modes, and combined unrelated controls", () => {
  for (const payload of [
    { yolo: true },
    { yolo: 1 },
    { autoAnswer: true },
    { autoPermission: false },
    { autoGuardrail: true },
    { permissions: "on" },
    { permissions: true },
    { guardrails: 1 },
    { answers: "auto", sleep: true },
    { permissions: "auto", goal: true },
    { sleep: false, goal: null },
  ])
    expect(() => encodeDomain("ycoding.v5.SessionAutonomySet", payload)).toThrow()
})
