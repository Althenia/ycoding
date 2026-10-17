import { expect, test } from "bun:test"
import { make } from "../src/v5/index.js"
import { decodeDomain, encodeDomain } from "../src/v5/codec.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

test.each([{ autoAnswer: true }, { autoAnswer: false }, { yolo: 0 }, { yolo: 2 }] as const)(
  "autonomy mutation %j preserves Session scope and effective approval settings",
  async (payload) => {
    const peer = new ScriptedPeer()
    const view = {
      mode: "normal",
      yolo: payload.yolo ?? 0,
      autoAnswer: payload.autoAnswer ?? false,
      effective: {
        yolo: 2,
        asleep: false,
        guardrailsEnabled: true,
        ordinaryReviewsAuto: true,
        modelReviews: false,
        hardModelReviews: true,
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
  },
)

test("autonomy codec rejects combined auto-answer mutations", () => {
  for (const payload of [{ autoAnswer: true, yolo: 1 }, { autoAnswer: false, sleep: true }])
    expect(() => encodeDomain("ycoding.v5.SessionAutonomySet", payload)).toThrow()
})
