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
      yolo: true,
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
    yolo: true,
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

test("session autonomy state preserves boolean YOLO and rejects numeric levels", () => {
  expect(Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", yolo: false })).toEqual({
    mode: "normal",
    yolo: false,
  })
  expect(Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", yolo: true })).toEqual({
    mode: "normal",
    yolo: true,
  })
  for (const yolo of [0, 1, 2, 3])
    expect(() => Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", yolo })).toThrow()
})

test("session autonomy set accepts modes and rejects empty goals", () => {
  expect(Schema.decodeUnknownSync(SessionAutonomySet)({ yolo: true })).toEqual({ yolo: true })
  expect(Schema.decodeUnknownSync(SessionAutonomySet)({ yolo: false })).toEqual({ yolo: false })
  for (const yolo of [0, 1, 2, 3]) expect(() => Schema.decodeUnknownSync(SessionAutonomySet)({ yolo })).toThrow()
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
    expect(decode({ yolo: true, goal })).toEqual({ yolo: true, goal })
  }
  expect(() => decode({ goal: false })).toThrow()
  expect(() => decode({ goal: {} })).toThrow()
  expect(() => decode({ yolo: true, goal: false })).toThrow()
  expect(() => decode({ yolo: true, goal: "  " })).toThrow()
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

test("family autonomy accepts explicit switches without accepting empty or invalid requests", () => {
  const decode = Schema.decodeUnknownSync(SessionAutonomySet)
  expect(decode({ sleep: false })).toEqual({ sleep: false })
  expect(decode({ sleep: true })).toEqual({ sleep: true })
  expect(Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", yolo: false, guardrailDecision: true,
    sleep: { priorGuardrailDecision: false } })).toEqual({ mode: "normal", yolo: false, sleep: {} })
  for (const value of [{}, { goal: false }, { goal: " " }, { sleep: "true" }, { guardrailDecision: true }])
    expect(() => decode(value)).toThrow()
})

test("auto-answer is an independent Session switch", () => {
  const decode = Schema.decodeUnknownSync(SessionAutonomySet)
  for (const autoAnswer of [false, true]) {
    expect(decode({ autoAnswer })).toEqual({ autoAnswer })
    for (const yolo of [false, true]) {
      expect(Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", yolo, autoAnswer }))
        .toEqual({ mode: "normal", yolo, autoAnswer })
    }
  }
  for (const input of [{ autoAnswer: "true" }, { autoAnswer: 1 }, { autoAnswer: null },
    { autoAnswer: true, sleep: true }, { autoAnswer: true, goal: "Run checks" }, { autoAnswer: true, yolo: true }]) {
    expect(() => decode(input)).toThrow()
  }
})

test("autonomy responses publish effective policy separately from stored state", () => {
  const document = OpenApi.fromApi(HttpApi.make("autonomy-policy-test").add(makeSessionGroup(SessionLocationMiddleware)))
  expect(document.components?.schemas?.SessionAutonomyYolo).toEqual({ type: "boolean" })
  expect(document.components?.schemas?.SessionAutonomyEffective).toMatchObject({
    type: "object",
    required: ["yolo", "permissionsAuto", "permissionModelReviews", "asleep", "guardrailsEnabled", "ordinaryReviewsAuto", "modelReviews", "hardModelReviews"],
    properties: {
      yolo: { $ref: "#/components/schemas/SessionAutonomyYolo" },
      permissionsAuto: { type: "boolean" },
      permissionModelReviews: { type: "boolean" },
      asleep: { type: "boolean" },
      guardrailsEnabled: { type: "boolean" },
      ordinaryReviewsAuto: { type: "boolean" },
      modelReviews: { type: "boolean" },
      hardModelReviews: { type: "boolean" },
    },
  })
  expect(document.components?.schemas?.SessionAutonomyView).toMatchObject({
    type: "object",
    required: ["mode", "yolo", "effective"],
    properties: {
      effective: { $ref: "#/components/schemas/SessionAutonomyEffective" },
    },
  })
})
