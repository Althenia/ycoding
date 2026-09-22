import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeSessionGroup, SessionLogItem } from "../src/groups/session.js"
import { SessionNotFoundError } from "../src/errors.js"
import { SourceEpoch } from "@ycoding-ai/schema/source-epoch"
import { Session } from "@ycoding-ai/schema/session"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionDaybreakLocationMiddleware",
) {}

const group = makeSessionGroup(SessionLocationMiddleware)
const endpoint = group.endpoints["session.daybreak.set"]

const session = {
  id: "ses_daybreak",
  projectID: "project",
  cost: 1,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  title: "Daybreak",
  location: { directory: "/project" },
}

test("session daybreak set registers the frozen endpoint contract", () => {
  expect(endpoint.method).toBe("POST")
  expect(endpoint.path).toBe("/api/session/:sessionID/daybreak")
  expect(endpoint.middlewares.has(SessionLocationMiddleware)).toBe(true)

  const payload = endpoint.payload.values().next().value?.schemas[0]
  if (!payload) throw new Error("session.daybreak.set has no payload schema")
  expect(Schema.is(payload)({ daybreak: "daybreak_blue" })).toBe(true)
  expect(Schema.is(payload)({ daybreak: "daybreak_red" })).toBe(true)
  expect(Schema.is(payload)({ daybreak: null })).toBe(true)
  expect(Schema.is(payload)({})).toBe(false)
  expect(Schema.is(payload)({ daybreak: "daybreak_green" })).toBe(false)

  const success = [...endpoint.success][0]
  if (!success) throw new Error("session.daybreak.set has no success schema")
  expect(success.ast).toEqual(Schema.Struct({ data: Session.Info }).ast)
  const decodeSuccess = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))
  expect(decodeSuccess({ data: session }).data.id).toBe(Session.ID.make("ses_daybreak"))
  expect(decodeSuccess({ data: { ...session, daybreak: "daybreak_red" } }).data.daybreak).toBe("daybreak_red")
  expect(() => decodeSuccess({ data: { ...session, daybreak: "daybreak_green" } })).toThrow()
  expect(() => decodeSuccess({ data: {} })).toThrow()

  expect(endpoint.error.size).toBe(1)
  expect(
    [...endpoint.error].some((schema) =>
      Schema.is(schema)(new SessionNotFoundError({ sessionID: "ses_missing", message: "Session not found" })),
    ),
  ).toBe(true)
})

test("session daybreak set publishes the annotated OpenAPI operation", () => {
  const document = OpenApi.fromApi(HttpApi.make("daybreak-test").add(group))
  const operation = document.paths["/api/session/{sessionID}/daybreak"]?.post

  expect(operation?.operationId).toBe("v2.session.daybreak.set")
  expect(operation?.summary).toBe("Set Daybreak")
  expect(operation?.description).toContain("daybreak_blue")
  expect(operation?.description).toContain("daybreak_red")
  expect(operation?.description).toContain("null clears")
  expect(operation?.description).toContain("access_programs.cyber")
  expect(operation?.responses?.[200]).toBeDefined()
  expect(operation?.responses?.[404]).toBeDefined()
})

test("SessionLogItem carries the durable session.daybreak.set event", () => {
  const log = Schema.decodeUnknownSync(SessionLogItem)({
    sourceEpoch: SourceEpoch.make("source_test"),
    id: "evt_daybreak",
    created: 1,
    type: "session.daybreak.set",
    durable: { aggregateID: "ses_test", seq: 0, version: 1 },
    data: { sessionID: "ses_test", daybreak: "daybreak_blue" },
  })
  expect(log).toMatchObject({
    type: "session.daybreak.set",
    durable: { aggregateID: "ses_test", seq: 0, version: 1 },
    data: { sessionID: "ses_test", daybreak: "daybreak_blue" },
  })

  const cleared = Schema.decodeUnknownSync(SessionLogItem)({
    sourceEpoch: SourceEpoch.make("source_test"),
    id: "evt_daybreak_clear",
    created: 1,
    type: "session.daybreak.set",
    durable: { aggregateID: "ses_test", seq: 1, version: 1 },
    data: { sessionID: "ses_test" },
  })
  expect(cleared).toHaveProperty("type", "session.daybreak.set")
  expect(cleared).not.toHaveProperty("data.daybreak")
})
