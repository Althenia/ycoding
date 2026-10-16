import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { makeReviewGroup, ReviewDecide } from "../src/groups/review.js"
import { ClientApi, groupNames } from "../src/client.js"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()("test/ReviewLocation") {}

test("review routes belong to the addressed Session and declare validation, lookup and conflict failures", () => {
  const group = makeReviewGroup(SessionLocationMiddleware)
  const list = group.endpoints["session.review.list"]
  const decide = group.endpoints["session.review.decide"]
  expect([list.method, list.path]).toEqual(["GET", "/api/session/:sessionID/review"])
  expect([decide.method, decide.path]).toEqual(["POST", "/api/session/:sessionID/review/:itemID/decide"])
  for (const endpoint of [list, decide]) expect(endpoint.middlewares.has(SessionLocationMiddleware)).toBe(true)
  const document = OpenApi.fromApi(HttpApi.make("review-contract").add(group))
  expect(document.paths["/api/session/{sessionID}/review"]?.get?.responses["200"]).toBeDefined()
  const responses = document.paths["/api/session/{sessionID}/review/{itemID}/decide"]?.post?.responses
  for (const status of [204, 400, 404, 409, 500]) expect(responses?.[status]).toBeDefined()
  expect([...decide.success].every((schema) => HttpApiSchema.isNoContent(schema.ast))).toBe(true)
  expect(ClientApi.groups["server.review"].endpoints["session.review.list"]).toBeDefined()
  expect(groupNames["server.review"]).toBe("review")
})

test("decide accepts only a kind-tagged human decision and exposes no internal delivery origin", () => {
  const input = { decision: { kind: "permission", reply: "once" } } as const
  expect(Schema.decodeUnknownSync(ReviewDecide)({ ...input, origin: "human-review" })).toEqual(input)
  for (const decision of [
    { reply: "once" },
    { kind: "guardrail", reply: "escalate" },
    { kind: "permission", dismissed: true },
  ])
    expect(() => Schema.decodeUnknownSync(ReviewDecide)({ decision })).toThrow()
})
