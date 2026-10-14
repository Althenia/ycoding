import { expect, test } from "bun:test"
import {
  create,
  decodeStrict,
  encodeLossless,
  encodeRemoteRequest,
  remotePayloadCodecs,
  session_attachment_upload_RequestSchema,
  session_list_RequestSchema,
  session_list_ResultSchema,
  session_snapshot_ResultSchema,
  PublicEventSchema,
} from "@ycoding-ai/remote"
import { readWireMessage, writeWireMessage, prepareRemoteRequest } from "./wire"

test("canonical request preparation places Session IDs, queries and workspace scopes in their declared fields", () => {
  const request = prepareRemoteRequest("session.list", {
    input: { limit: 25, parentID: null, order: "active", workspace: "wsp_browser" },
  })
  const decoded = decodeStrict(session_list_RequestSchema, request.payload)
  expect(decoded.query?.limit).toBe(25n)
  expect(decoded.query?.parentID?.kind.case).toBe("clear")
  expect(request.scope.target).toEqual({ case: "machine", value: { $typeName: "ycoding.v5.Empty" } })
  expect(prepareRemoteRequest("catalog.get", { workspaceID: "wsp_browser" }).scope.target).toEqual({
    case: "workspace",
    value: "wsp_browser",
  })
  expect(() => prepareRemoteRequest("session.subscribe", { sessionID: "ses_browser" })).toThrow(
    "Unknown remote operation",
  )
})

test("raw upload octets and contiguous byte offsets use the canonical upload payload", () => {
  const request = prepareRemoteRequest("session.attachment.upload", {
    sessionID: "ses_browser",
    input: {
      uploadID: "00000000-0000-4000-8000-000000000000",
      index: 2,
      offset: 42000,
      last: true,
      data: Uint8Array.of(0, 128, 255),
    },
  })
  const decoded = decodeStrict(session_attachment_upload_RequestSchema, request.payload)
  expect(decoded.payload?.data).toEqual(Uint8Array.of(0, 128, 255))
  expect(decoded.payload?.offset).toBe(42000n)
  expect(request.scope.target).toEqual({ case: "session", value: "ses_browser" })
})

test("notice.read encodes its repeated ID payload instead of an object wrapper", () => {
  const prepared = prepareRemoteRequest("notice.read", { input: { ids: ["ntc_1", "ntc_2"] } })
  expect(remotePayloadCodecs.get("notice.read")!.request.decode(prepared.payload)).toMatchObject({
    ids: ["ntc_1", "ntc_2"],
  })
})

test("Session form reads and replies use the declared Form scope and retain the Session owner", () => {
  for (const operation of ["session.form.list", "session.form.reply", "session.form.cancel"]) {
    const prepared = prepareRemoteRequest(operation, {
      sessionID: "ses_browser",
      input: { formID: "frm_browser", answer: { q0: "answer" } },
    })
    expect(prepared.scope.target).toEqual({ case: "form", value: "ses_browser" })
    expect(
      readWireMessage(prepared.codec.request.schema, prepared.codec.request.decode(prepared.payload)),
    ).toMatchObject({ params: { sessionID: "ses_browser" } })
  }
})

test("presentation decoding preserves empty cursor pages, absent quota values and unsafe-integer rejection", () => {
  const value = create(session_list_ResultSchema, {
    data: { data: { items: [] }, cursor: { next: encodeLossless("opaque") } },
  })
  expect(readWireMessage(session_list_ResultSchema, value)).toEqual({ data: { data: [], cursor: { next: "opaque" } } })
  const quota = remotePayloadCodecs.get("providerUsage.list")!.result.schema
  const location = { directory: "/work", project: { id: "prj_browser", directory: "/work" } }
  expect(readWireMessage(quota, writeWireMessage(quota, { location, data: [] }))).toEqual({ location, data: [] })
  expect(() => writeWireMessage(session_list_RequestSchema, { query: { limit: Number.MAX_SAFE_INTEGER + 1 } })).toThrow(
    "Unsafe domain integer",
  )
})

test("the canonical snapshot wrapper and lossless strings reach the presentation unchanged", () => {
  const schema = remotePayloadCodecs.get("session.snapshot")!.result.schema
  const snapshot = {
    data: {
      sourceEpoch: "source",
      session: {
        id: "ses_browser",
        projectID: "prj_browser",
        title: "A\ud800B",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
        location: { directory: "/work" },
      },
      messages: [],
      watermark: { type: "log.synced", aggregateID: "ses_browser", seq: 0 },
    },
  }
  const encoded = encodeRemoteRequest(
    "session.snapshot",
    writeWireMessage(remotePayloadCodecs.get("session.snapshot")!.request.schema, {
      params: { sessionID: "ses_browser" },
      query: { limit: 100 },
    }),
  )
  expect(encoded.byteLength).toBeGreaterThan(0)
  expect(readWireMessage(session_snapshot_ResultSchema, writeWireMessage(schema, snapshot))).toEqual(snapshot)
})

test("public event decoding selects the typed branch rather than parsing a JSON envelope", () => {
  const event = {
    id: "evt_browser",
    created: 1,
    type: "session.text.delta",
    data: { sessionID: "ses_browser", assistantMessageID: "msg_browser", ordinal: 0, delta: "answer" },
  }
  expect(readWireMessage(PublicEventSchema, writeWireMessage(PublicEventSchema, event))).toEqual(event)
})
