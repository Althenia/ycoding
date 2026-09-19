import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeSessionGroup, SessionAutonomySet, SessionAutonomyState } from "../src/groups/session.js"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionAutonomyLocationMiddleware",
) {}

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

test("R7 accepts explicit goal resume without replacing objective text", () => {
  const decode = Schema.decodeUnknownSync(SessionAutonomySet)
  expect(decode({ goal: true })).toEqual({ goal: true })
  for (const goal of [true, null, "New objective"] as const) {
    expect(decode({ yolo: 1, goal })).toEqual({ yolo: 1, goal })
  }
  expect(() => decode({ goal: false })).toThrow()
  expect(() => decode({ goal: {} })).toThrow()
  expect(() => decode({ yolo: 1, goal: false })).toThrow()
  expect(() => decode({ yolo: 1, goal: "  " })).toThrow()
  expect(() => decode({})).toThrow()
  expect(() => decode({ maxNoProgress: 3 })).toThrow()
})

test("R7 documents typed goal resume, stale calculation, and provider failures", () => {
  const group = makeSessionGroup(SessionLocationMiddleware)
  const document = OpenApi.fromApi(HttpApi.make("goal-test").add(group))
  const responses = document.paths["/api/session/{sessionID}/autonomy"]?.put?.responses
  for (const status of [200, 400, 404, 409, 500]) expect(responses?.[status]).toBeDefined()
  expect(group.endpoints["session.autonomy.set"].middlewares.has(SessionLocationMiddleware)).toBe(true)
})
