import { expect, test } from "bun:test"
import { make } from "../src/v5/index.js"
import type { V5Client } from "../src/v5/index.js"
import { encodeDomain, decodeDomain } from "../src/v5/codec.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

const cases: { name: string; call: (client: V5Client) => Promise<unknown>; payload: unknown; output: unknown }[] = [
  {
    name: "session.capturedChanges.list",
    call: (client) => client.session.capturedChanges.list({ sessionID: "ses_root", cursor: "opaque" }),
    payload: { cursor: "opaque" },
    output: {
      data: [
        {
          placementMessageID: "msg_placement",
          path: "src/\ud800.ts",
          additions: 1,
          deletions: 0,
          status: "modified",
          files: [
            {
              diff: "patch",
              path: "src/\ud800.ts",
              additions: 1,
              deletions: 0,
              status: "modified",
              unavailable: false,
            },
          ],
        },
      ],
      cursor: { next: "next" },
    },
  },
  {
    name: "session.team.economics",
    call: (client) => client.session.team.economics({ sessionID: "ses_root", sessionIDs: ["ses_root", "ses_child"] }),
    payload: { sessionIDs: ["ses_root", "ses_child"] },
    output: {
      data: [
        {
          sessionID: "ses_child",
          cost: 0.5,
          tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 0, write: 0 } },
          cacheHitRatio: 0,
        },
      ],
    },
  },
  {
    name: "session.family.activity",
    call: (client) => client.session.family.activity({ sessionID: "ses_root", sessionIDs: [] }),
    payload: { sessionIDs: [] },
    output: {
      data: [
        {
          sessionID: "ses_root",
          executing: true,
          activity: { kind: "tool", room: "developer", text: "Editing protocol" },
        },
        { sessionID: "ses_child", executing: false },
      ],
    },
  },
]

test.each(cases)("M7 generated $name binds Session scope and lossless domain results", async (item) => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) => {
    expect(dispatch.request.scope?.target).toEqual({ case: "session", value: "ses_root" })
    expect(decodeDomain(dispatch.operation.requestType, dispatch.request.payload)).toEqual({ payload: item.payload })
    peer.result(dispatch, {
      typeName: dispatch.operation.resultType,
      payload: encodeDomain(dispatch.operation.resultType, item.output),
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
    expect(await item.call(client)).toEqual(item.output)
    expect(peer.requests.map((dispatch) => dispatch.operation.diagnosticName)).toEqual([item.name])
  } finally {
    client.transport.close()
  }
})

test.each(cases)("M7 generated $name preserves Connector_Error without replay", async (item) => {
  const peer = new ScriptedPeer()
  const error = { code: "session_not_allowed", message: "Session placement is unavailable" }
  peer.onRequest = (dispatch) =>
    peer.result(
      dispatch,
      { typeName: "ycoding.v5.Connector_Error", payload: encodeDomain("ycoding.v5.Connector_Error", error) },
      true,
    )
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    await expect(item.call(client)).rejects.toEqual(error)
    expect(peer.requests).toHaveLength(1)
  } finally {
    client.transport.close()
  }
})
