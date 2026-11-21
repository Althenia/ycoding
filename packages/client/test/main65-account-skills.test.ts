import { expect, test } from "bun:test"
import { make } from "../src/v5/index.js"
import { decodeDomain, encodeDomain } from "../src/v5/codec.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

test("account skills public client sends its query and preserves the proof envelope and typed error", async () => {
  const peer = new ScriptedPeer()
  const input = {
    integrationID: "openai",
    sessionID: "ses_fixture",
    agent: "agent_fixture",
    profile: "profile_fixture",
    id: "skill_fixture",
  }
  const result = {
    location: { directory: "/fixture", project: { id: "project_fixture", directory: "/fixture" } },
    data: {
      status: 200,
      keys: ["items"],
      count: 1,
      hasNext: false,
      paginationKeys: [],
      detail: { status: 200, keys: ["id"] },
    },
  }
  const error = { _tag: "InvalidRequestError", message: "Not listed", kind: "unlisted_skill_id" }
  const requests: unknown[] = []
  peer.onRequest = (dispatch) => {
    expect(dispatch.operation.diagnosticName).toBe("integration.accountSkills.read")
    expect(dispatch.request.scope?.target.case).toBe("location")
    requests.push(decodeDomain(dispatch.operation.requestType, dispatch.request.payload))
    const denied = peer.requests.length === 2
    const typeName = denied ? "ycoding.v5.InvalidRequestError" : dispatch.operation.resultType
    peer.result(dispatch, { typeName, payload: encodeDomain(typeName, denied ? error : result) }, denied)
  }
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    location: { directory: "/fixture" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    expect(await client.integration.accountSkills.read(input)).toEqual(result)
    await expect(client.integration.accountSkills.read(input)).rejects.toEqual(error)
    expect(peer.requests).toHaveLength(2)
    expect(requests).toEqual(
      Array(2).fill({
        params: { integrationID: input.integrationID },
        query: {
          location: { directory: "/fixture" },
          sessionID: input.sessionID,
          agent: input.agent,
          profile: input.profile,
          id: input.id,
        },
      }),
    )
  } finally {
    client.transport.close()
  }
})
