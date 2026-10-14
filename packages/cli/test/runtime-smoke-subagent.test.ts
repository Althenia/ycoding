import { expect, test } from "bun:test"
import { decodeDomain, encodeDomain, V5ClientError, YCoding } from "@ycoding-ai/client/v5"
import { ScriptedPeer } from "../../client/test/fixture/v5-peer"
import { assertUnsentSubagentDescription } from "../script/runtime-smoke"

const launch = {
  parentID: "ses_smoke_parent",
  parentAssistantMessageID: "msg_smoke_parent",
  toolCallID: "call_smoke_child",
  agent: "reviewer",
  prompt: "Runtime smoke child",
  background: true,
}

test("runtime smoke rejects a 4097-unit subagent description as unsent without dispatch", async () => {
  const peer = new ScriptedPeer()
  const client = YCoding.make({
    endpoint: { url: "http://127.0.0.1:12345" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  peer.onRequest = (dispatch) => peer.reject(dispatch)
  try {
    const error = await client.session.subagent.launch({ ...launch, description: "d".repeat(4097) }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(() => assertUnsentSubagentDescription(error)).not.toThrow()
    expect(error).toBeInstanceOf(V5ClientError)
    expect(peer.requests).toHaveLength(0)
  } finally {
    client.transport.close()
  }
})

test("runtime smoke accepts and preserves a 4096-unit subagent description", async () => {
  const peer = new ScriptedPeer()
  const description = "d".repeat(4096)
  const task = {
    sessionID: "ses_smoke_child",
    parentID: launch.parentID,
    description,
    agent: launch.agent,
    model: { id: "smoke-model", providerID: "openrouter" },
    background: true,
    state: "starting" as const,
    revision: 0,
    time: { created: 0, updated: 0 },
  }
  const client = YCoding.make({
    endpoint: { url: "http://127.0.0.1:12345" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  peer.onRequest = (dispatch) =>
    peer.result(dispatch, {
      typeName: dispatch.operation.resultType,
      payload: encodeDomain(dispatch.operation.resultType, { data: task }),
    })
  try {
    expect(await client.session.subagent.launch({ ...launch, description })).toEqual(task)
    expect(peer.requests).toHaveLength(1)
    const received = peer.requests[0]
    expect(received.operation.diagnosticName).toBe("session.subagent.launch")
    expect(decodeDomain(received.operation.requestType, received.request.payload)).toMatchObject({
      payload: { description },
    })
  } finally {
    client.transport.close()
  }
})

test("runtime smoke does not accept a server rejection or uncertain failure as an unsent description", () => {
  for (const error of [
    undefined,
    { _tag: "InvalidRequestError", message: "Rejected" },
    new V5ClientError("unknown", "session.subagent.launch", "Input cannot be represented by v5"),
    new V5ClientError("unsent", "session.prompt", "Input cannot be represented by v5"),
    new V5ClientError("unsent", "session.subagent.launch", "Request allocation limit"),
  ])
    expect(() => assertUnsentSubagentDescription(error)).toThrow("before transmission")
})
