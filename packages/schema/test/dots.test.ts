import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Dots } from "../src/dots.js"
import { Dots as RootDots } from "../src/index.js"
import { SessionID } from "../src/session-id.js"

const target = { profile: "fixture-a", dotID: "dot_1", threadID: "thread_1", generation: "3", label: "Fixture Dot" }

describe("Dots contract", () => {
  test("L10 named exchange metadata requires canonical attachment and target identity", () => {
    expect(Dots.ExchangeMetadata).toBeDefined()
    const value = { sessionID: "ses_anchor", targetSessionID: "ses_target", exchangeID: "exchange_named", attachment: { ...target, label: "V" } }
    const decode = Schema.decodeUnknownSync(Dots.ExchangeMetadata)
    expect(decode(value)).toMatchObject(value)
    for (const invalid of [
      { ...value, targetSessionID: "" },
      { ...value, attachment: { ...value.attachment, dotID: "" } },
      { ...value, attachment: { ...value.attachment, generation: "" } },
      { ...value, attachment: { ...value.attachment, label: "   " } },
    ]) expect(() => decode(invalid)).toThrow()
  })

  test("exchange creation requires an explicit task recipient, generation, identity and delivery", () => {
    expect(Dots.ExchangeCreate).toBeDefined()
    const input = { exchangeID: "exchange_1", expectedAttachment: target, targetSessionID: SessionID.make("ses_target"), channel: "task", delivery: "queue", text: "Inspect a synthetic module" } as const
    expect(Schema.decodeUnknownSync(Dots.ExchangeCreate)(input)).toEqual(input)
    for (const invalid of [
      { ...input, exchangeID: "" }, { ...input, targetSessionID: "" }, { ...input, channel: "human" },
      { ...input, delivery: "background" }, { ...input, expectedAttachment: { ...target, generation: "" } },
    ]) expect(() => Schema.decodeUnknownSync(Dots.ExchangeCreate)(invalid)).toThrow()
    expect(() => Schema.decodeUnknownSync(Dots.ExchangeCreate)({ ...input, origin: "human" }, { onExcessProperty: "error" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Dots.ExchangeCreate)({ ...input, remoteSource: {} }, { onExcessProperty: "error" })).toThrow()
  })

  test("drops non-final revision identity from completed-reply attribution", () => {
    const peer: Dots.Peer = {
      origin: "dots-peer",
      profile: "fixture",
      dotID: "dot",
      threadID: "room-thread",
      itemID: "message",
    }
    expect(Dots.peer({ dots: { ...peer, revision: "content-digest" } })).toEqual(peer)
  })
  test("exports one canonical namespace from the root barrel", () => {
    expect(RootDots).toBe(Dots)
  })

  test("decodes a confirmed target and omits an absent status target and error", () => {
    expect(Schema.decodeUnknownSync(Dots.Target)(target)).toEqual(target)
    expect(Schema.encodeSync(Dots.Status)({ enabled: false, state: "disconnected", target: undefined, error: undefined })).toEqual({
      enabled: false,
      state: "disconnected",
    })
    expect(
      Schema.decodeUnknownSync(Dots.Status)({ enabled: true, target, state: "failed", error: "Reconnect that profile." }),
    ).toEqual({
      enabled: true,
      target,
      state: "failed",
      error: "Reconnect that profile.",
    })
  })

  test("rejects an empty target identity and an unknown connection state", () => {
    expect(() => Schema.decodeUnknownSync(Dots.Target)({ ...target, threadID: "" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Dots.Status)({ enabled: true, state: "open" })).toThrow()
  })

  test("requires an explicit enabled flag on every status and names the disabled error", () => {
    for (const status of [{ state: "disconnected" }, { enabled: "true", state: "disconnected" }, { enabled: undefined, state: "disconnected" }, { enabled: null, state: "disconnected" }])
      expect(() => Schema.decodeUnknownSync(Dots.Status)(status)).toThrow()
    for (const enabled of [true, false])
      expect(Schema.decodeUnknownSync(Dots.Status)({ enabled, state: "disconnected" })).toEqual({ enabled, state: "disconnected" })
    expect(Schema.is(Dots.ErrorCode)("feature_disabled")).toBe(true)
  })

  test("reports Dot runtime state independently from connection and generation", () => {
    for (const runtimeState of ["paused", "unpaused", "unknown"] as const) {
      expect(Schema.decodeUnknownSync(Dots.RuntimeState)(runtimeState)).toBe(runtimeState)
      expect(Schema.encodeSync(Dots.Status)({ enabled: true, state: "connected", target, runtimeState })).toEqual({
        enabled: true, state: "connected", target, runtimeState,
      })
    }
    expect(Schema.encodeSync(Dots.Status)({ enabled: true, state: "connected", target, runtimeState: undefined })).toEqual({
      enabled: true, state: "connected", target,
    })
    for (const runtimeState of ["running", "stopped", "", null])
      expect(() => Schema.decodeUnknownSync(Dots.Status)({ enabled: true, state: "connected", target, runtimeState })).toThrow()
    expect(Schema.decodeUnknownSync(Dots.Status)({ enabled: true, state: "connected", activeTurn: { threadID: "thread", turnID: "turn" } })).not.toHaveProperty("activeTurn")
  })

  test("requires the confirmed target for runtime controls and uses current control errors", () => {
    expect(Schema.decodeUnknownSync(Dots.Control)({ expectedTarget: target })).toEqual({ expectedTarget: target })
    for (const control of [{}, { turnID: "turn" }, { expectedTarget: { ...target, generation: "" } }])
      expect(() => Schema.decodeUnknownSync(Dots.Control)(control)).toThrow()
    for (const code of ["runtime_unknown", "control_failed"])
      expect(Schema.is(Dots.ErrorCode)(code)).toBe(true)
    for (const code of ["turn_unknown", "cancel_failed"])
      expect(Schema.is(Dots.ErrorCode)(code)).toBe(false)
    expect(Reflect.has(Dots, "ActiveTurn")).toBe(false)
  })

  test("carries only explicit text, file references, and an optional causal message", () => {
    const send = {
      id: "f1d2c3b4-0000-4000-8000-000000000001",
      text: "Summarize the attached report",
      files: [{ uri: "file:///synthetic/report.pdf", name: "report.pdf" }],
      causalMessageID: "msg_assistant",
      expectedTarget: target,
    }
    expect(Schema.decodeUnknownSync(Dots.Send)(send)).toEqual(send)
    expect(
      Schema.encodeSync(Dots.Send)({
        id: send.id,
        text: "Hi",
        files: undefined,
        causalMessageID: undefined,
        expectedTarget: target,
      }),
    ).toEqual({ id: send.id, text: "Hi", expectedTarget: target })
    expect(() => Schema.decodeUnknownSync(Dots.Send)({ ...send, id: "" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Dots.Send)({ id: send.id, text: "Hi" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Dots.Send)({ ...send, editor: "selection" })).not.toThrow()
    expect(Schema.decodeUnknownSync(Dots.Send)({ ...send, editor: "selection" })).not.toHaveProperty("editor")
  })

  test("reports a delivery as accepted or unknown only", () => {
    expect(Schema.decodeUnknownSync(Dots.Delivery)({ messageID: "m1", status: "accepted", turnID: "turn_1" })).toEqual({
      messageID: "m1",
      status: "accepted",
      turnID: "turn_1",
    })
    expect(Schema.decodeUnknownSync(Dots.Delivery)({ messageID: "m1", status: "unknown" })).toEqual({
      messageID: "m1",
      status: "unknown",
    })
    expect(() => Schema.decodeUnknownSync(Dots.Delivery)({ messageID: "m1", status: "failed" })).toThrow()
  })

  test("reads peer attribution only from a complete Dots metadata record", () => {
    const peer = {
      origin: "dots-peer" as const,
      profile: "fixture-a",
      dotID: "dot_1",
      threadID: "thread_1",
      turnID: "turn_1",
      itemID: "item_1",
      causalMessageID: "m1",
    }
    expect(Dots.peer({ dots: peer })).toEqual(peer)
    const { causalMessageID: _causal, ...uncorrelated } = peer
    expect(Dots.peer({ dots: uncorrelated })).toEqual(uncorrelated)
    expect(Dots.peer({ dots: { ...peer, origin: "user" } })).toBeUndefined()
    expect(Dots.peer({ dots: { ...peer, itemID: "" } })).toBeUndefined()
    expect(Dots.peer({ inputOrigin: "coordination" })).toBeUndefined()
    expect(Dots.peer(undefined)).toBeUndefined()
  })

  test("uses stable domain identifiers", () => {
    const identifiers = [Dots.Target, Dots.State, Dots.RuntimeState, Dots.Status, Dots.Control, Dots.Send, Dots.Delivery, Dots.ErrorCode, Dots.Peer].map(
      (schema) => schema.ast.annotations?.identifier,
    )
    expect(identifiers).toEqual([
      "Dots.Target",
      "Dots.State",
      "Dots.RuntimeState",
      "Dots.Status",
      "Dots.Control",
      "Dots.Send",
      "Dots.Delivery",
      "Dots.ErrorCode",
      "Dots.Peer",
    ])
  })

  test("accepts room peer identity without fabricating a remote turn", () => {
    const peer: Dots.Peer = {
      origin: "dots-peer",
      profile: "fixture-a",
      dotID: "dot_1",
      threadID: "thread_1",
      itemID: "room_message_1",
    }
    expect(Dots.peer({ dots: peer })).toEqual(peer)
    expect(Dots.peer({ dots: peer })).not.toHaveProperty("turnID")
    expect(Dots.peer({ dots: { ...peer, turnID: "" } })).toBeUndefined()
  })
})

describe("routing envelope", () => {
  const shared = {
    coordinator: { ownerID: "owner_1", deviceID: "device_1", clientID: "client_1" },
    scope: { epoch: "epoch_1", grantID: "grant_1" },
    exchangeID: "exchange_1",
    messageID: "msg_1",
  }
  const task = { ...shared, kind: "task", origin: "plugin", targetSessionID: "ses_target" }
  const report = (kind: string) => ({ ...shared, kind, origin: "agent", sourceSessionID: "ses_source", replyToMessageID: "msg_0" })
  const reportKinds = ["progress", "blocker", "decision_request", "completion"]
  const strict = { onExcessProperty: "error" } as const
  const decode = (schema: Schema.Decoder<unknown>, value: unknown) => Schema.decodeUnknownSync(schema)(value, strict)
  const metadata = { sessionID: "ses_anchor", targetSessionID: "ses_target", exchangeID: "exchange_1", attachment: { ...target, label: "V" } }

  test("routing envelope decodes the task kind with its target session", () => {
    expect(decode(Dots.TaskEnvelope, task)).toEqual(task)
    expect(decode(Dots.Envelope, task)).toEqual(task)
  })

  test("routing envelope decodes every report kind with source session and reply message", () => {
    for (const kind of reportKinds) {
      expect(decode(Dots.ReportEnvelope, report(kind))).toEqual(report(kind))
      expect(decode(Dots.Envelope, report(kind))).toEqual(report(kind))
    }
  })

  test("routing envelope rejects the wrong direction for each kind", () => {
    const { targetSessionID: _targetSessionID, ...taskWithoutTarget } = task
    expect(() => decode(Dots.TaskEnvelope, report("completion"))).toThrow()
    expect(() => decode(Dots.TaskEnvelope, { ...task, sourceSessionID: "ses_source", replyToMessageID: "msg_0" })).toThrow()
    expect(() => decode(Dots.TaskEnvelope, { ...task, origin: "agent" })).toThrow()
    expect(() => decode(Dots.TaskEnvelope, taskWithoutTarget)).toThrow()
    for (const kind of reportKinds) {
      expect(() => decode(Dots.ReportEnvelope, { ...report(kind), kind: "task" })).toThrow()
      expect(() => decode(Dots.ReportEnvelope, { ...report(kind), origin: "plugin" })).toThrow()
      expect(() => decode(Dots.ReportEnvelope, { ...report(kind), targetSessionID: "ses_target" })).toThrow()
    }
    expect(() => decode(Dots.Envelope, { ...task, kind: "progress" })).toThrow()
    expect(() => decode(Dots.Envelope, { ...report("progress"), kind: "unknown" })).toThrow()
  })

  test("routing envelope requires every identifier and rejects empties", () => {
    const cases = [
      [Dots.TaskEnvelope, task, ["kind", "origin", "targetSessionID", "coordinator", "scope", "exchangeID", "messageID"]],
      ...reportKinds.map((kind) => [Dots.ReportEnvelope, report(kind), ["kind", "origin", "sourceSessionID", "replyToMessageID", "coordinator", "scope", "exchangeID", "messageID"]] as const),
    ] as const
    for (const [schema, value, keys] of cases) {
      for (const key of keys) {
        const { [key]: _removed, ...rest } = value as Record<string, unknown>
        expect(() => decode(schema, rest)).toThrow()
      }
    }
    for (const value of [task, ...reportKinds.map(report)]) {
      for (const invalid of [
        { ...value, exchangeID: "" },
        { ...value, messageID: "" },
        { ...value, messageID: "bad_1" },
        { ...value, scope: { ...shared.scope, epoch: "" } },
        { ...value, scope: { ...shared.scope, grantID: "" } },
        { ...value, scope: { grantID: "grant_1" } },
        { ...value, scope: { epoch: "epoch_1" } },
        { ...value, coordinator: { ...shared.coordinator, ownerID: "" } },
        { ...value, coordinator: { ...shared.coordinator, deviceID: "" } },
        { ...value, coordinator: { ...shared.coordinator, clientID: "" } },
        { ...value, coordinator: "Display Name" },
      ]) expect(() => decode(Dots.Envelope, invalid)).toThrow()
    }
    expect(() => decode(Dots.TaskEnvelope, { ...task, targetSessionID: "" })).toThrow()
    expect(() => decode(Dots.ReportEnvelope, { ...report("progress"), sourceSessionID: "" })).toThrow()
    expect(() => decode(Dots.ReportEnvelope, { ...report("progress"), replyToMessageID: "" })).toThrow()
  })

  test("routing envelope rejects spoofed excess fields under strict parsing", () => {
    for (const value of [task, ...reportKinds.map(report)]) {
      for (const extra of [{ spoofed: true }, { grantID: "grant_2" }, { epoch: "epoch_2" }, { principal: shared.coordinator }]) {
        expect(() => decode(Dots.Envelope, { ...value, ...extra })).toThrow()
      }
      expect(() => decode(Dots.Envelope, { ...value, coordinator: { ...shared.coordinator, displayName: "Spoof" } })).toThrow()
      expect(() => decode(Dots.Envelope, { ...value, scope: { ...shared.scope, extra: "x" } })).toThrow()
    }
  })

  test("routing envelope is optional on exchange metadata and keeps historical metadata valid", () => {
    expect(decode(Dots.ExchangeMetadata, metadata)).toEqual(metadata)
    expect(decode(Dots.ExchangeMetadata, { ...metadata, envelope: task })).toEqual({ ...metadata, envelope: task })
    expect(() => decode(Dots.ExchangeMetadata, { ...metadata, envelope: report("progress") })).toThrow()
    expect(() => decode(Dots.ExchangeMetadata, { ...metadata, envelope: { ...task, scope: { ...shared.scope, grantID: "" } } })).toThrow()
  })

  test("routing envelope is required on exchange output as a report", () => {
    const output = { deliveryID: "delivery_1", messageID: "msg_1", text: "done" }
    expect(decode(Dots.ExchangeOutput, { ...output, envelope: report("completion") })).toEqual({ ...output, envelope: report("completion") })
    expect(() => decode(Dots.ExchangeOutput, output)).toThrow()
    expect(() => decode(Dots.ExchangeOutput, { ...output, envelope: task })).toThrow()
  })

  test("routing envelope is required on exchange as a task", () => {
    const exchange = { exchangeID: "exchange_1", sessionID: "ses_anchor", targetSessionID: "ses_target", inputID: "msg_1", channel: "task", state: "pending", progress: [] }
    expect(decode(Dots.Exchange, { ...exchange, envelope: task })).toEqual({ ...exchange, envelope: task })
    expect(() => decode(Dots.Exchange, exchange)).toThrow()
    expect(() => decode(Dots.Exchange, { ...exchange, envelope: report("progress") })).toThrow()
  })

  test("routing envelope requires a nonempty grant on exchange records", () => {
    const record = {
      exchangeID: "exchange_1",
      sessionID: "ses_anchor",
      targetSessionID: "ses_target",
      inputID: "msg_1",
      expectedAttachment: target,
      accountDigest: "digest_1",
      fingerprint: "fingerprint_1",
      source: { requestID: "request_1", principal: shared.coordinator, epoch: "epoch_1" },
      scope: { rootSessionID: "ses_root" },
      grantID: "grant_1",
    }
    expect(decode(Dots.ExchangeRecord, record)).toEqual(record)
    const { grantID: _grant, ...withoutGrant } = record
    expect(() => decode(Dots.ExchangeRecord, withoutGrant)).toThrow()
    expect(() => decode(Dots.ExchangeRecord, { ...record, grantID: "" })).toThrow()
  })

  test("routing envelope is never accepted from exchange creation callers", () => {
    const input = { exchangeID: "exchange_1", expectedAttachment: target, targetSessionID: "ses_target", channel: "task", delivery: "queue", text: "Inspect" }
    expect(decode(Dots.ExchangeCreate, input)).toEqual(input)
    for (const extra of [{ envelope: task }, { grantID: "grant_1" }, { origin: "plugin" }, { coordinator: shared.coordinator }, { scope: shared.scope }]) {
      expect(() => decode(Dots.ExchangeCreate, { ...input, ...extra })).toThrow()
    }
  })

  test("routing envelope exports are reachable from the root barrel", () => {
    expect(RootDots.TaskEnvelope).toBe(Dots.TaskEnvelope)
    expect(RootDots.ReportEnvelope).toBe(Dots.ReportEnvelope)
    expect(RootDots.Envelope).toBe(Dots.Envelope)
  })
})
