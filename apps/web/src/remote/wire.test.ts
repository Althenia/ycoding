import { expect, test } from "bun:test"
import {
  create,
  decodeStrict,
  encodeStrict,
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
import { readAutonomy } from "./projection"

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

test("a Waiting list query and a page status envelope with lost identifiers cross the wire by label", () => {
  const request = prepareRemoteRequest("session.list", {
    input: { limit: 25, order: "active", status: "waiting", parentID: null },
  })
  expect(
    readWireMessage(session_list_RequestSchema, decodeStrict(session_list_RequestSchema, request.payload)),
  ).toMatchObject({
    query: { order: "active", status: "waiting" },
  })
  const status = { running: ["ses_running"], attention: ["ses_waiting", "ses_lost"], lost: ["ses_lost"] }
  const result = writeWireMessage(session_list_ResultSchema, { data: { data: [], cursor: {}, status } })
  expect(readWireMessage(session_list_ResultSchema, result)).toEqual({ data: { data: [], cursor: {}, status } })
  const noLoss = { running: [], attention: ["ses_waiting"] }
  expect(
    readWireMessage(
      session_list_ResultSchema,
      writeWireMessage(session_list_ResultSchema, { data: { data: [], cursor: {}, status: noLoss } }),
    ),
  ).toEqual({
    data: { data: [], cursor: {}, status: noLoss },
  })
})

test("autonomy state crosses the wire flattened with its effective values, and auto-answer is its own exclusive set", () => {
  const codec = remotePayloadCodecs.get("session.autonomy.get")!.result.schema
  const effective = {
    yolo: 1,
    asleep: true,
    guardrailsEnabled: true,
    ordinaryReviewsAuto: false,
    modelReviews: true,
    hardModelReviews: false,
  }
  const state = { mode: "normal", yolo: 1, autoAnswer: true, sleep: {}, effective }
  expect(readWireMessage(codec, writeWireMessage(codec, { data: state }))).toEqual({ data: state })
  const request = prepareRemoteRequest("session.autonomy.set", {
    sessionID: "ses_browser",
    input: { autoAnswer: false },
  })
  const setCodec = remotePayloadCodecs.get("session.autonomy.set")!
  expect(
    readWireMessage(setCodec.request.schema, decodeStrict(setCodec.request.schema, request.payload)),
  ).toMatchObject({
    params: { sessionID: "ses_browser" },
    payload: { autoAnswer: false },
  })
  // YOLO bounds belong to the domain reader; the wire branches carry doubles.
  for (const invalid of [
    { ...state, yolo: 3 },
    { ...state, effective: { ...effective, yolo: 3 } },
  ]) {
    const decoded = readWireMessage(
      codec,
      decodeStrict(codec, encodeStrict(codec, writeWireMessage(codec, { data: invalid }))),
    )
    expect(decoded).toEqual({ data: invalid })
    expect(readAutonomy(decoded)).toBeUndefined()
  }
  expect(() =>
    prepareRemoteRequest("session.autonomy.set", { sessionID: "ses_browser", input: { autoAnswer: true, yolo: 1 } }),
  ).toThrow()
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

const breakdown = {
  requests: 2,
  tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 3 } },
  cost: { known: 0.5, pricedRequests: 1, unpricedRequests: 1, provenance: "recorded" },
}

test("usage accounting requests carry their ID arrays in the declared query and keep the Session in the params", () => {
  const ids = Array.from({ length: 100 }, (_, index) => `msg_${index}`)
  for (const [operation, field] of [
    ["session.promptCosts", "inputIDs"],
    ["session.taskCosts", "sessionIDs"],
  ] as const) {
    const request = prepareRemoteRequest(operation, { sessionID: "ses_root", input: { [field]: ids } })
    const codec = remotePayloadCodecs.get(operation)!
    const decoded = readWireMessage(codec.request.schema, decodeStrict(codec.request.schema, request.payload)) as {
      params: { sessionID: string }
      query: Record<string, string[]>
    }
    expect(decoded.params.sessionID).toBe("ses_root")
    expect(decoded.query[field]).toEqual(ids)
    expect(request.scope.target).toEqual({ case: "session", value: "ses_root" })
  }
})

test("the native forecast and report requests encode their scope, groups and filters by label", () => {
  const forecast = prepareRemoteRequest("providerUsage.forecast", { input: { localScope: "backend" } })
  const forecastCodec = remotePayloadCodecs.get("providerUsage.forecast")!
  expect(
    readWireMessage(forecastCodec.request.schema, decodeStrict(forecastCodec.request.schema, forecast.payload)),
  ).toEqual({ query: { localScope: "backend" } })
  expect(forecast.scope.target).toEqual({ case: "machine", value: { $typeName: "ycoding.v5.Empty" } })
  const reportCodec = remotePayloadCodecs.get("usage.report")!
  for (const group of [
    "provider",
    "provider-profile-model",
    "provider-model",
    "model-id",
    "profile",
    "prompt",
    "task",
  ]) {
    const input = { group, providerID: "openai", profile: "Work", modelID: "gpt", selectedEffort: "high", limit: 25 }
    const report = prepareRemoteRequest("usage.report", { input })
    expect(
      readWireMessage(reportCodec.request.schema, decodeStrict(reportCodec.request.schema, report.payload)),
    ).toEqual({
      query: input,
    })
  }
})

test("accounting, forecast and report results decode their breakdowns, dimensions and optional sections", () => {
  const unit = {
    anchor: { sessionID: "ses_root", inputID: "msg_first" },
    status: "so-far",
    attribution: "partial",
    history: "partial",
    total: breakdown,
    main: breakdown,
    children: breakdown,
    helpers: [{ ...breakdown, source: "decision" }],
  }
  const prompt = remotePayloadCodecs.get("session.promptCosts")!.result.schema
  const prompts = { data: { units: [unit], unattributed: breakdown, history: "partial" } }
  expect(readWireMessage(prompt, writeWireMessage(prompt, prompts))).toEqual(prompts)
  const task = remotePayloadCodecs.get("session.taskCosts")!.result.schema
  const { anchor: _anchor, ...taskUnit } = unit
  const tasks = { data: { tasks: [{ sessionID: "ses_child", ...taskUnit }], total: breakdown, history: "retained" } }
  expect(readWireMessage(task, writeWireMessage(task, tasks))).toEqual(tasks)
  const forecast = remotePayloadCodecs.get("providerUsage.forecast")!.result.schema
  const location = { directory: "/work", project: { id: "prj_browser", directory: "/work" } }
  const quota = {
    providerID: "openai",
    windowID: "week",
    unit: "percent",
    source: "provider_api",
    stability: "stable",
    updatedAt: 1,
    state: "insufficient",
    evidence: "insufficient",
    reason: "Warming up",
  }
  for (const data of [
    { asOf: 2, localScope: "backend", localRates: [], quotas: [quota] },
    { asOf: 2, localScope: "backend", quotas: [quota] },
    { asOf: 2, localScope: "backend", localRates: [] },
  ])
    expect(readWireMessage(forecast, writeWireMessage(forecast, { location, data }))).toEqual({ location, data })
  const report = remotePayloadCodecs.get("usage.report")!.result.schema
  const metrics = {
    logical: 1,
    physical: 1,
    helpers: 0,
    continued: 0,
    fallback: 0,
    costCoverage: { pricedRequests: 1, unpricedRequests: 0 },
    tokens: breakdown.tokens,
    cost: 0,
    costProvenance: "recorded",
  }
  const row = (key: string, dimensions: unknown) => ({
    key,
    label: key,
    dimensions,
    ...metrics,
    speed: { generationSamples: 2, providerTimedSamples: 1, observedSamples: 1, samples: 2 },
  })
  const rows = [
    row("a", { group: "provider", providerID: "openai" }),
    row("b", {
      group: "provider-profile-model",
      providerID: "openai",
      profileState: "provider-default",
      modelID: "gpt",
    }),
    row("c", { group: "profile", providerID: "openai", profile: "Work", profileState: "recorded" }),
    row("d", { group: "prompt", anchor: { sessionID: "ses_a", inputID: "msg_a" }, attribution: "complete" }),
    row("e", { group: "task", attribution: "unattributed" }),
  ]
  const { speed: _speed, dimensions: _dimensions, key: _key, label: _label, ...total } = rows[0]!
  const value = { data: { group: "provider", rows, total, rowCount: 5 } }
  expect(readWireMessage(report, writeWireMessage(report, value))).toEqual(value)
})

test("snapshot generation-speed history carries the estimated flag, its model and an unreported reason through the wire", () => {
  const model = { providerID: "openai", id: "speed-model", variant: "high", profile: "work" }
  const measured = { model, tokens: 80, durationNs: 1_000_000_000, tokensPerSecond: 80 }
  const histories = [
    { model, latest: { ...measured, estimated: true }, recent: [measured] },
    { model, latest: measured, recent: [measured, { ...measured, tokens: 40, tokensPerSecond: 40 }] },
    { model, recent: [], unreportedReason: "No usable provider measurement" },
  ]
  const schema = remotePayloadCodecs.get("session.snapshot")!.result.schema
  for (const generationSpeed of histories) {
    const snapshot = {
      data: {
        sourceEpoch: "source",
        session: {
          id: "ses_browser",
          projectID: "prj_browser",
          title: "Speed",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          location: { directory: "/work" },
        },
        messages: [],
        watermark: { type: "log.synced", aggregateID: "ses_browser", seq: 0 },
        generationSpeed,
      },
    }
    expect(readWireMessage(schema, writeWireMessage(schema, snapshot))).toEqual(snapshot)
  }
})
