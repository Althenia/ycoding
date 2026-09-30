import { describe, expect, test } from "bun:test"
import {
  RemoteLimits,
  parseAgentMessage,
  parseClientMessage,
  parseRelayToAgentMessage,
  parseRelayToClientMessage,
  serializeCancel,
  serializeEvents,
  serializePriority,
} from "../src/index"

const session = "ses_stream_1"

describe("remote envelope: event batches", () => {
  test("round-trips an ordered event batch on the agent and relay-to-client surfaces", () => {
    const frame = serializeEvents({ type: "events", sessionID: session, events: [{ type: "a" }, { type: "b" }] })
    expect(JSON.parse(frame)).toEqual({ type: "events", sessionID: session, events: [{ type: "a" }, { type: "b" }] })
    expect(parseAgentMessage(frame)).toEqual({ ok: true, value: { type: "events", sessionID: session, events: [{ type: "a" }, { type: "b" }] } })
    expect(parseRelayToClientMessage(frame)).toEqual({ ok: true, value: { type: "events", sessionID: session, events: [{ type: "a" }, { type: "b" }] } })
  })

  test("bounds the batch to one or more entries up to the shared limit", () => {
    expect(parseAgentMessage(JSON.stringify({ type: "events", sessionID: session, events: [] }))).toMatchObject({ ok: false })
    const full = Array.from({ length: RemoteLimits.maxEventBatch }, (_, index) => ({ seq: index }))
    expect(parseAgentMessage(JSON.stringify({ type: "events", sessionID: session, events: full }))).toMatchObject({ ok: true })
    expect(parseAgentMessage(JSON.stringify({ type: "events", sessionID: session, events: [...full, { seq: -1 }] }))).toMatchObject({ ok: false })
  })

  test("rejects malformed batches and keeps them off the client and relay-to-agent surfaces", () => {
    expect(parseAgentMessage(JSON.stringify({ type: "events", sessionID: "nope", events: [{}] }))).toMatchObject({ ok: false })
    expect(parseAgentMessage(JSON.stringify({ type: "events", sessionID: session, events: {} }))).toMatchObject({ ok: false })
    expect(parseAgentMessage(JSON.stringify({ type: "events", sessionID: session, events: [{}], extra: 1 }))).toMatchObject({ ok: false })
    expect(parseAgentMessage(JSON.stringify({ type: "events", sessionID: session }))).toMatchObject({ ok: false })
    const frame = serializeEvents({ type: "events", sessionID: session, events: [{}] })
    expect(parseClientMessage(frame)).toMatchObject({ ok: false })
    expect(parseRelayToAgentMessage(frame)).toMatchObject({ ok: false })
  })
})

describe("remote envelope: client cancellation", () => {
  test("accepts a bounded cancel on the client surface only", () => {
    expect(parseClientMessage(serializeCancel("req_1"))).toEqual({ ok: true, value: { type: "cancel", id: "req_1" } })
    expect(parseAgentMessage(serializeCancel("req_1"))).toMatchObject({ ok: false })
    expect(parseRelayToClientMessage(serializeCancel("req_1"))).toMatchObject({ ok: false })
  })

  test("rejects malformed cancel frames", () => {
    expect(parseClientMessage('{"type":"cancel"}')).toMatchObject({ ok: false })
    expect(parseClientMessage('{"type":"cancel","id":""}')).toMatchObject({ ok: false })
    expect(parseClientMessage('{"type":"cancel","id":"a b"}')).toMatchObject({ ok: false })
    expect(parseClientMessage(`{"type":"cancel","id":"${"x".repeat(RemoteLimits.maxRequestIDChars + 1)}"}`)).toMatchObject({ ok: false })
    expect(parseClientMessage('{"type":"cancel","id":"a","operation":"x"}')).toMatchObject({ ok: false })
  })
})

describe("remote envelope: delivery priority", () => {
  test("accepts a client priority hint and the relay's per-client translation for the agent", () => {
    expect(parseClientMessage(serializePriority({ type: "priority", mode: "background" }))).toEqual({ ok: true, value: { type: "priority", mode: "background" } })
    expect(parseClientMessage('{"type":"priority","mode":"interactive"}')).toEqual({ ok: true, value: { type: "priority", mode: "interactive" } })
    const forwarded = serializePriority({ type: "priority", clientID: "c1", mode: "background" })
    expect(JSON.parse(forwarded)).toEqual({ type: "priority", clientID: "c1", mode: "background" })
    expect(parseRelayToAgentMessage(forwarded)).toEqual({ ok: true, value: { type: "priority", clientID: "c1", mode: "background" } })
  })

  test("keeps each priority shape on its own surface", () => {
    expect(parseClientMessage('{"type":"priority","clientID":"c1","mode":"background"}')).toMatchObject({ ok: false })
    expect(parseRelayToAgentMessage('{"type":"priority","mode":"background"}')).toMatchObject({ ok: false })
    expect(parseAgentMessage('{"type":"priority","mode":"background"}')).toMatchObject({ ok: false })
    expect(parseRelayToClientMessage('{"type":"priority","mode":"background"}')).toMatchObject({ ok: false })
  })

  test("rejects unknown modes and malformed client identifiers", () => {
    expect(parseClientMessage('{"type":"priority","mode":"turbo"}')).toMatchObject({ ok: false })
    expect(parseClientMessage('{"type":"priority"}')).toMatchObject({ ok: false })
    expect(parseRelayToAgentMessage('{"type":"priority","clientID":"","mode":"background"}')).toMatchObject({ ok: false })
    expect(parseRelayToAgentMessage('{"type":"priority","clientID":"c 1","mode":"background"}')).toMatchObject({ ok: false })
    expect(parseRelayToAgentMessage('{"type":"priority","clientID":"c1","mode":"background","extra":true}')).toMatchObject({ ok: false })
  })
})
