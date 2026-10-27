import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Telemetry } from "../src/telemetry.js"

test("remote access administration is admitted by telemetry", () => {
  expect(Schema.is(Telemetry.Operation)("session.dots.access.get")).toBe(true)
  expect(Schema.is(Telemetry.Operation)("session.dots.access.set")).toBe(true)
})
