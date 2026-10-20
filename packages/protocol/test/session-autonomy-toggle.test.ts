import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionAutonomySet, SessionAutonomyState } from "../src/groups/session.js"

describe("boolean autonomy controls", () => {
  const decode = Schema.decodeUnknownSync(SessionAutonomySet, { onExcessProperty: "error" })

  for (const flag of ["yolo", "autoPermission", "autoGuardrail", "autoAnswer"] as const) {
    for (const value of [false, true]) {
      test(`${flag} preserves ${value} without setting another control`, () => {
        expect<unknown>(decode({ [flag]: value })).toEqual({ [flag]: value })
      })
    }

    for (const value of [0, 1, 2, 3, "on", "off", null]) {
      test(`${flag} rejects ${JSON.stringify(value)}`, () => {
        expect(() => decode({ [flag]: value })).toThrow()
      })
    }
  }

  test("an omitted control is not interpreted as false", () => {
    expect(() => decode({})).toThrow()
    expect(decode({ autoAnswer: false })).not.toHaveProperty("yolo")
  })

  test("current state retains each explicit boolean control", () => {
    const state = {
      mode: "normal" as const,
      yolo: false,
      autoPermission: false,
      autoGuardrail: true,
      autoAnswer: false,
    }
    expect(Schema.decodeUnknownSync(SessionAutonomyState, { onExcessProperty: "error" })(state)).toEqual(state)
  })
})
