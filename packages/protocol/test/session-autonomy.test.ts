import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionAutonomySet, SessionAutonomyState } from "../src/groups/session.js"

test("session autonomy state preserves active goal progress", () => {
  expect(
    Schema.decodeUnknownSync(SessionAutonomyState)({
      mode: "goal",
      goal: {
        text: "Ship the release",
        status: "active",
        iteration: 2,
        noProgress: 1,
        maxNoProgress: 3,
        lastProgressDigest: "abc",
      },
    }),
  ).toEqual({
    mode: "goal",
    goal: {
      text: "Ship the release",
      status: "active",
      iteration: 2,
      noProgress: 1,
      maxNoProgress: 3,
      lastProgressDigest: "abc",
    },
  })
})

test("session autonomy set accepts modes and rejects empty goals", () => {
  expect(Schema.decodeUnknownSync(SessionAutonomySet)({ mode: "yolo" })).toEqual({ mode: "yolo" })
  expect(
    Schema.decodeUnknownSync(SessionAutonomySet)({
      mode: "goal",
      goal: "Finish the migration",
      maxNoProgress: 4,
    }),
  ).toEqual({ mode: "goal", goal: "Finish the migration", maxNoProgress: 4 })
  expect(() => Schema.decodeUnknownSync(SessionAutonomySet)({ mode: "goal", goal: "   " })).toThrow()
})
