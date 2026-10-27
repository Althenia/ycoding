import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Dots } from "../src/dots.js"
import { EventManifest } from "../src/event-manifest.js"
import { DurableEventManifest } from "../src/durable-event-manifest.js"
import { SessionEvent } from "../src/session-event.js"

test("access schemas enforce closed setters and nonnegative integer revisions", () => {
  expect(Schema.decodeUnknownSync(Dots.AccessSet)({ enabled: true, expectedRevision: 0 })).toEqual({ enabled: true, expectedRevision: 0 })
  for (const value of [{ enabled: 1, expectedRevision: 0 }, { enabled: false, expectedRevision: -1 }, { enabled: false, expectedRevision: 0.5 }, { enabled: false, expectedRevision: 0, source: {} }])
    expect(() => Schema.decodeUnknownSync(Dots.AccessSet)(value)).toThrow()
})

test("access change is the same durable definition in public and replay manifests", () => {
  expect(EventManifest.Server.get("session.dots.access.changed")).toBe(SessionEvent.DotsAccessChanged)
  expect(DurableEventManifest.Durable.get("session.dots.access.changed.1")).toBe(SessionEvent.DotsAccessChanged)
})
