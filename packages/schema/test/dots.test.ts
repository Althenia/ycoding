import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Dots } from "../src/dots.js"
import { Dots as RootDots } from "../src/index.js"

const target = { profile: "fixture-a", dotID: "dot_1", threadID: "thread_1", generation: "3", label: "Fixture Dot" }

describe("Dots contract", () => {
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
