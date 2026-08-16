import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionAutonomySet, SessionAutonomyState } from "../src/groups/session.js"

test("session autonomy state preserves active goal progress", () => {
  expect(
    Schema.decodeUnknownSync(SessionAutonomyState)({
      mode: "normal",
      yolo: 2,
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
    mode: "normal",
    yolo: 2,
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

test("session autonomy state maps legacy boolean yolo", () => {
  expect(Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", yolo: false })).toEqual({
    mode: "normal",
    yolo: 0,
  })
  expect(Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", yolo: true })).toEqual({
    mode: "normal",
    yolo: 2,
  })
  expect(Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", yolo: 1 })).toEqual({
    mode: "normal",
    yolo: 1,
  })
  expect(Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", yolo: 3 })).toEqual({
    mode: "normal",
    yolo: 3,
  })
})

test("session autonomy set accepts modes and rejects empty goals", () => {
  expect(Schema.decodeUnknownSync(SessionAutonomySet)({ yolo: 2 })).toEqual({ yolo: 2 })
  expect(Schema.decodeUnknownSync(SessionAutonomySet)({ yolo: true })).toEqual({ yolo: 2 })
  expect(Schema.decodeUnknownSync(SessionAutonomySet)({ yolo: false })).toEqual({ yolo: 0 })
  expect(Schema.decodeUnknownSync(SessionAutonomySet)({ yolo: 0 })).toEqual({ yolo: 0 })
  expect(Schema.decodeUnknownSync(SessionAutonomySet)({ yolo: 1 })).toEqual({ yolo: 1 })
  expect(Schema.decodeUnknownSync(SessionAutonomySet)({ yolo: 3 })).toEqual({ yolo: 3 })
  expect(
    Schema.decodeUnknownSync(SessionAutonomySet)({
      goal: "Finish the migration",
      maxNoProgress: 4,
    }),
  ).toEqual({ goal: "Finish the migration", maxNoProgress: 4 })
  expect(() => Schema.decodeUnknownSync(SessionAutonomySet)({ goal: "   " })).toThrow()
})
