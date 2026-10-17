import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  decodeStrict,
  decodeLossless,
  agent_list_ResultSchema,
  session_messages_ResultSchema,
  session_prompt_RequestSchema,
  session_prompt_ResultSchema,
  session_snapshot_ResultSchema,
  session_autonomy_get_ResultSchema,
} from "@ycoding-ai/protocol/v5"
import { make } from "../src/v5/index.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

const text = (value: string) => ({ encoding: { case: "utf8" as const, value } })

test("REQ-WIRE-001/004 preserves Location envelopes and unwraps message list envelopes exactly", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) => {
    if (dispatch.operation.diagnosticName === "agent.list")
      peer.result(dispatch, {
        typeName: agent_list_ResultSchema.typeName,
        payload: encodeStrict(
          agent_list_ResultSchema,
          create(agent_list_ResultSchema, {
            location: {
              directory: text("/fixture"),
              workspaceID: text("workspace_fixture"),
              project: { id: text("project_fixture"), directory: text("/fixture") },
            },
            data: { items: [] },
          }),
        ),
      })
    if (dispatch.operation.diagnosticName === "session.messages")
      peer.result(dispatch, {
        typeName: session_messages_ResultSchema.typeName,
        payload: encodeStrict(
          session_messages_ResultSchema,
          create(session_messages_ResultSchema, { data: { data: { items: [] } } }),
        ),
      })
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
    expect(await client.agent.list()).toEqual({
      location: {
        directory: "/fixture",
        workspaceID: "workspace_fixture",
        project: { id: "project_fixture", directory: "/fixture" },
      },
      data: [],
    })
    expect(await client.message.list({ sessionID: "ses_owner" })).toEqual([])
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-009 prompt success is a lossless durable-admission receipt, not execution completion", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) =>
    peer.result(dispatch, {
      typeName: session_prompt_ResultSchema.typeName,
      payload: encodeStrict(
        session_prompt_ResultSchema,
        create(session_prompt_ResultSchema, {
          data: {
            admittedSeq: 123n,
            id: text("msg_admitted"),
            sessionID: text("ses_owner"),
            timeCreated: 0,
            type: 1,
            data: {
              text: { encoding: { case: "utf16LeUnits", value: new Uint8Array([0, 216]) } },
              files: { items: [] },
              metadata: { entries: [{ key: text("price"), value: { kind: { case: "number", value: 0.125 } } }] },
            },
            delivery: 2,
          },
        }),
      ),
    })
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    expect(
      await client.session.prompt({
        sessionID: "ses_owner",
        id: "msg_admitted",
        text: "\ud800",
        files: [],
        delivery: "queue",
        resume: false,
      }),
    ).toEqual({
      admittedSeq: 123,
      id: "msg_admitted",
      sessionID: "ses_owner",
      timeCreated: 0,
      type: "user",
      data: { text: "\ud800", files: [], metadata: { price: 0.125 } },
      delivery: "queue",
    })
    const request = decodeStrict(session_prompt_RequestSchema, peer.requests[0].request.payload)
    expect(decodeLossless(request.payload!.text!)).toBe("\ud800")
    expect(Object.hasOwn(request.payload!, "resume")).toBe(true)
    expect(request.payload?.resume).toBe(false)
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-004/011 canonical snapshots retain source, exact watermark and opaque cursor", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) =>
    peer.result(dispatch, {
      typeName: session_snapshot_ResultSchema.typeName,
      payload: encodeStrict(
        session_snapshot_ResultSchema,
        create(session_snapshot_ResultSchema, {
          data: {
            sourceEpoch: text("source-1"),
            session: {
              id: text("ses_owner"),
              projectID: text("project_fixture"),
              cost: 0.125,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 0, updated: 0 },
              title: text("fixture"),
              location: { directory: text("/fixture") },
            },
            messages: { items: [] },
            watermark: { type: 1, aggregateID: text("ses_owner"), seq: BigInt(Number.MAX_SAFE_INTEGER) },
            before: text("opaque_cursor"),
          },
        }),
      ),
    })
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    const snapshot = await client.session.snapshot({ sessionID: "ses_owner" })
    expect(snapshot.sourceEpoch).toBe("source-1")
    expect(snapshot.watermark).toEqual({ type: "log.synced", aggregateID: "ses_owner", seq: Number.MAX_SAFE_INTEGER })
    expect(snapshot.before).toBe("opaque_cursor")
    expect(snapshot.messages).toEqual([])
    expect(snapshot.session.cost).toBe(0.125)
    expect(Object.hasOwn(snapshot, "generationSpeed")).toBe(false)
    expect(Object.hasOwn(snapshot.session, "model")).toBe(false)
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-004 reads autonomy values without truthiness or numeric remapping", async () => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) =>
    peer.result(dispatch, {
      typeName: session_autonomy_get_ResultSchema.typeName,
      payload: encodeStrict(
        session_autonomy_get_ResultSchema,
        create(session_autonomy_get_ResultSchema, {
          data: {
            mode: 1,
            yolo: { kind: { case: "value3", value: 2 } },
            effective: {
              yolo: { kind: { case: "value3", value: 2 } },
              asleep: false,
              guardrailsEnabled: true,
              ordinaryReviewsAuto: true,
              modelReviews: false,
              hardModelReviews: true,
            },
          },
        }),
      ),
    })
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    expect(await client.session.autonomy.get({ sessionID: "ses_owner" })).toEqual({
      mode: "normal",
      yolo: 2,
      effective: {
        yolo: 2,
        asleep: false,
        guardrailsEnabled: true,
        ordinaryReviewsAuto: true,
        modelReviews: false,
        hardModelReviews: true,
      },
    })
  } finally {
    client.transport.close()
  }
})
