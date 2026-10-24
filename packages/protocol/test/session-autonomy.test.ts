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
      permissions: "yolo", guardrails: "manual", answers: "auto",
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
    permissions: "yolo", guardrails: "manual", answers: "auto",
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

test("session autonomy state rejects obsolete Boolean and numeric controls", () => {
  for (const yolo of [false, true, 0, 1, 2, 3])
    expect(() => Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", yolo })).toThrow()
})

test("session autonomy set accepts modes and rejects empty goals", () => {
  expect(Schema.decodeUnknownSync(SessionAutonomySet)({ permissions: "yolo" })).toEqual({ permissions: "yolo" })
  expect(Schema.decodeUnknownSync(SessionAutonomySet)({ answers: "manual" })).toEqual({ answers: "manual" })
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
    expect(decode({ goal })).toEqual({ goal })
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
  expect(Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", permissions: "manual", guardrails: "manual", answers: "manual", guardrailDecision: true,
    sleep: { priorGuardrailDecision: false } })).toEqual({ mode: "normal", permissions: "manual", guardrails: "manual", answers: "manual", sleep: {} })
  for (const value of [{}, { goal: false }, { goal: " " }, { sleep: "true" }, { guardrailDecision: true }])
    expect(() => decode(value)).toThrow()
})

test("answer mode changes independently of permissions and guardrails", () => {
  const decode = Schema.decodeUnknownSync(SessionAutonomySet)
  for (const answers of ["manual", "yolo", "auto"] as const) {
    expect(decode({ answers })).toEqual({ answers })
    for (const permissions of ["manual", "yolo", "auto"] as const) {
      expect(Schema.decodeUnknownSync(SessionAutonomyState)({ mode: "normal", permissions, guardrails: "manual", answers }))
        .toEqual({ mode: "normal", permissions, guardrails: "manual", answers })
    }
  }
  for (const input of [{ autoAnswer: "true" }, { autoAnswer: 1 }, { autoAnswer: null },
    { autoAnswer: true, sleep: true }, { autoAnswer: true, goal: "Run checks" }, { autoAnswer: true, yolo: true }]) {
    expect(() => decode(input)).toThrow()
  }
})

test("autonomy responses publish effective policy separately from stored state", () => {
  const document = OpenApi.fromApi(HttpApi.make("autonomy-policy-test").add(makeSessionGroup(SessionLocationMiddleware)))
  expect(document.components?.schemas?.SessionAutonomyYolo).toBeUndefined()
  expect(document.components?.schemas?.SessionAutonomyEffective).toMatchObject({
    type: "object",
    required: ["permissions", "guardrails", "answers", "inherited", "asleep", "guardrailsEnabled"],
    properties: {
      permissions: { $ref: "#/components/schemas/SessionAutonomy.DecisionMode" },
      guardrails: { $ref: "#/components/schemas/SessionAutonomy.DecisionMode" },
      answers: { $ref: "#/components/schemas/SessionAutonomy.DecisionMode" },
      asleep: { type: "boolean" },
      guardrailsEnabled: { type: "boolean" },
      inherited: { type: "object" },
    },
  })
  expect(document.components?.schemas?.SessionAutonomyView).toMatchObject({
    type: "object",
    required: ["mode", "permissions", "guardrails", "answers", "effective"],
    properties: {
      effective: { $ref: "#/components/schemas/SessionAutonomyEffective" },
    },
  })
})
