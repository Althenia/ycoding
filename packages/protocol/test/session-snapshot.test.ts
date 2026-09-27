import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeSessionGroup, SessionProjection, SessionSnapshotQuery } from "../src/groups/session.js"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionSnapshotLocationMiddleware",
) {}

test("windowed snapshot query bounds and optional cursor are published on the Session route", () => {
  const group = makeSessionGroup(SessionLocationMiddleware)
  const endpoint = group.endpoints["session.snapshot"]
  if (!endpoint.query) throw new Error("snapshot endpoint has no query schema")
  const decode = Schema.decodeUnknownSync(SessionSnapshotQuery)
  expect(decode({})).toEqual({})
  expect(decode({ limit: "200", before: "opaque_1" })).toEqual({ limit: 200, before: "opaque_1" })
  for (const input of [{ limit: "0" }, { limit: "201" }, { limit: "1.5" }, { limit: "1", before: "x".repeat(257) }])
    expect(() => decode(input)).toThrow()
  expect(endpoint.middlewares.has(SessionLocationMiddleware)).toBe(true)
  const operation = OpenApi.fromApi(HttpApi.make("session-snapshot-test").add(group)).paths["/api/session/{sessionID}/snapshot"]?.get
  expect(operation?.parameters?.map((parameter) => "$ref" in parameter ? parameter.$ref : parameter.name)).toEqual(["sessionID", "limit", "before"])
  expect(operation?.responses?.[400]).toBeDefined()
  expect(Schema.decodeUnknownSync(SessionProjection)({
    sourceEpoch: "epoch_test",
    session: { id: "ses_test", projectID: "project", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, title: "Test", location: { directory: "/project" } },
    messages: [], watermark: { type: "log.synced", aggregateID: "ses_test", seq: 0 }, before: "opaque_1",
  }).before).toBe("opaque_1")
})

test("Session-scoped managed attachment reads publish a bounded base64 result", () => {
  const group = makeSessionGroup(SessionLocationMiddleware)
  const endpoint = group.endpoints["session.attachment.read"]
  expect(endpoint.middlewares.has(SessionLocationMiddleware)).toBe(true)
  const digest = "a".repeat(64)
  const operation = OpenApi.fromApi(HttpApi.make("session-attachment-test").add(group)).paths["/api/session/{sessionID}/attachment/{digest}"]?.get
  expect(operation?.operationId).toBe("v2.session.attachment.read")
  for (const status of [200, 400, 404, 413]) expect(operation?.responses?.[status]).toBeDefined()
  const success = [...endpoint.success][0]
  if (!success) throw new Error("attachment read has no success schema")
  if (!endpoint.params) throw new Error("attachment read has no path params")
  expect(Schema.is(success)({ mime: "image/png", bytes: 3, data: "YWJj" })).toBe(true)
  expect(Schema.is(success)({ mime: "image/png", bytes: -1, data: "YWJj" })).toBe(false)
  expect(Schema.is(endpoint.params)({ sessionID: "ses_test", digest })).toBe(true)
  expect(Schema.is(endpoint.params)({ sessionID: "ses_test", digest: "../bad" })).toBe(false)
})
