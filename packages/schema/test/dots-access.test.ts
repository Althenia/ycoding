import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Dots } from "../src/dots.js"
import { EventManifest } from "../src/event-manifest.js"
import { DurableEventManifest } from "../src/durable-event-manifest.js"
import { SessionEvent } from "../src/session-event.js"

test("access schemas enforce closed setters and nonnegative integer revisions", () => {
  expect(Schema.decodeUnknownSync(Dots.Access)({ enabled: false, revision: 0 })).toEqual({ enabled: false, revision: 0 })
  expect(Schema.decodeUnknownSync(Dots.AccessSet)({ enabled: true, expectedRevision: 0 })).toEqual({ enabled: true, expectedRevision: 0 })
  for (const value of [{ enabled: 1, expectedRevision: 0 }, { enabled: false, expectedRevision: -1 }, { enabled: false, expectedRevision: 0.5 }, { enabled: false, expectedRevision: 0, source: {} }])
    expect(() => Schema.decodeUnknownSync(Dots.AccessSet)(value)).toThrow()
})

test("native status separates global consent, configuration and actual connection with bounded display fields", () => {
  const value: Dots.NativeStatus = { access: { enabled: false, revision: 0 }, configuration: { ready: true, profile: "trusted" }, connection: { state: "unavailable" } }
  expect(Schema.decodeUnknownSync(Dots.NativeStatus)(value)).toEqual(value)
  expect(Schema.decodeUnknownSync(Dots.NativeStatus)({ ...value, connection: { state: "error", message: "x".repeat(500), hostname: "h".repeat(256) } }).connection.message).toHaveLength(500)
  for (const connection of [{ state: "invented" }, { state: "error", message: "x".repeat(501) }, { state: "connected", hostname: "h".repeat(257) }, { state: "connected", hostname: "unsafe\u001b" }])
    expect(() => Schema.decodeUnknownSync(Dots.NativeStatus)({ ...value, connection })).toThrow()
})

test("access change is the same durable definition in public and replay manifests", () => {
  expect(EventManifest.Server.get("session.dots.access.changed")).toBe(SessionEvent.DotsAccessChanged)
  expect(DurableEventManifest.Durable.get("session.dots.access.changed.1")).toBe(SessionEvent.DotsAccessChanged)
})
