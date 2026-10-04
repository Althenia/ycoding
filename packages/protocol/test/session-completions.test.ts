import { expect, test } from "bun:test"
import { Session } from "@ycoding-ai/schema/session"
import { SessionWorkCompletion } from "@ycoding-ai/schema/session-work-completion"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeSessionGroup, SessionCompletionsQuery } from "../src/groups/session.js"

class CompletionLocation extends HttpApiMiddleware.Service<CompletionLocation>()("test/CompletionLocation") {}

test("exposes bounded root completion receipts without a caller-supplied Location", () => {
  const group = makeSessionGroup(CompletionLocation)
  const operation = OpenApi.fromApi(HttpApi.make("completion-test").add(group)).paths["/api/session/completions"]?.get
  expect(operation?.operationId).toBe("session.completions")
  expect(operation?.parameters?.map((item) => "$ref" in item ? item.$ref : item.name)).toEqual(["after", "limit"])
  const endpoint = group.endpoints["session.completions"]
  expect([...endpoint.middlewares]).toHaveLength(0)
  const success = [...endpoint.success][0]
  expect(operation?.responses?.["200"]).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/SessionWorkCompletion.Page" } } } })
  const receipt = { id: "evt_complete", seq: 14, created: 1000, sessionID: "ses_root", inputID: "msg_input", assistantMessageID: "msg_final" }
  expect(Schema.is(success)({ data: [receipt], next: "ses_root" })).toBe(true)
  expect(Schema.encodeSync(SessionWorkCompletion.Page)(Schema.decodeUnknownSync(SessionWorkCompletion.Page)({ data: [receipt], next: "ses_root" }))).toEqual({ data: [receipt], next: "ses_root" })
  expect(Schema.is(success)({ data: [] })).toBe(true)
  expect(Schema.is(success)({ data: [{ ...receipt, seq: -1 }] })).toBe(false)
  expect(Schema.is(success)({ data: [{ ...receipt, sessionID: "wrong" }] })).toBe(false)
  expect(Schema.decodeUnknownSync(SessionCompletionsQuery)({ after: "ses_root", limit: "200" })).toEqual({ after: Session.ID.make("ses_root"), limit: 200 })
  for (const limit of ["0", "201", "1.5", "no"])
    expect(() => Schema.decodeUnknownSync(SessionCompletionsQuery)({ limit })).toThrow()
})
