import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionAutonomySet, SessionAutonomyState } from "../src/groups/session.js"

describe("category autonomy controls", () => {
  const decode = Schema.decodeUnknownSync(SessionAutonomySet, { onExcessProperty: "error" })

  for (const category of ["permissions", "guardrails", "answers"] as const) {
    for (const value of ["manual", "yolo", "auto"]) {
      test(`${category} preserves ${value} without setting another category`, () => {
        expect<unknown>(decode({ [category]: value })).toEqual({ [category]: value })
      })
    }

    for (const value of [0, 1, true, false, "on", "off", "Manual", null]) {
      test(`${category} rejects ${JSON.stringify(value)}`, () => {
        expect(() => decode({ [category]: value })).toThrow()
      })
    }
  }

  test("an omitted category is unchanged and an empty update is rejected", () => {
    expect(() => decode({})).toThrow()
    expect(decode({ answers: "manual" })).not.toHaveProperty("permissions")
  })

  test("set-all accepts every combination in one update", () => {
    for (const permissions of ["manual", "yolo", "auto"] as const)
      for (const guardrails of ["manual", "yolo", "auto"] as const)
        for (const answers of ["manual", "yolo", "auto"] as const) {
          const input = { permissions, guardrails, answers }
          expect(decode(input)).toEqual(input)
          expect(Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", ...input })).toEqual({ mode: "normal", ...input })
        }
  })

  test("old Boolean controls and mixed operations are rejected without aliases", () => {
    for (const flag of ["yolo", "autoPermission", "autoGuardrail", "autoAnswer"])
      for (const value of [true, false, 0, "yolo"])
        expect(() => decode({ [flag]: value })).toThrow()
    for (const input of [{ permissions: "auto", sleep: true }, { answers: "yolo", goal: true }, { permissions: "manual", yolo: true }])
      expect(() => decode(input)).toThrow()
  })

  test("current state retains each explicit mode and requires every category", () => {
    const state = {
      mode: "normal" as const,
      permissions: "manual",
      guardrails: "yolo",
      answers: "auto",
    } as const
    expect(Schema.decodeUnknownSync(SessionAutonomyState, { onExcessProperty: "error" })(state)).toEqual(state)
    expect(() => Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", permissions: "manual" })).toThrow()
  })
})
