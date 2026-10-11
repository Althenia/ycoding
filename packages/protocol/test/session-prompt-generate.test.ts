import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeSessionGroup } from "../src/groups/session.js"
import { SessionNotFoundError } from "../src/errors.js"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionPromptGenerateLocationMiddleware",
) {}

test("session.promptGenerate drafts one prompt and does not admit it", () => {
  const group = makeSessionGroup(SessionLocationMiddleware)
  const endpoint = group.endpoints["session.promptGenerate"]
  expect(endpoint.method).toBe("POST")
  expect(endpoint.path).toBe("/api/session/:sessionID/prompt-generate")
  expect(endpoint.middlewares.has(SessionLocationMiddleware)).toBe(true)

  const payload = endpoint.payload.values().next().value?.schemas[0]
  if (!payload) throw new Error("session.promptGenerate has no payload schema")
  expect(Schema.is(payload)({ mode: "start", intent: "  Open the task  ", memory: [] })).toBe(true)
  expect(Schema.is(payload)({ mode: "steer", intent: "Change it", memory: ["repository", "knowledge"] })).toBe(true)
  expect(Schema.is(payload)({ mode: "queue", intent: "x".repeat(4000), memory: ["knowledge"] })).toBe(true)
  expect(Schema.is(payload)({ mode: "goal", intent: "Ship it", memory: [] })).toBe(true)
  expect(Schema.is(payload)({ mode: "start", intent: "   ", memory: [] })).toBe(false)
  expect(Schema.is(payload)({ mode: "start", intent: "", memory: [] })).toBe(false)
  expect(Schema.is(payload)({ mode: "start", intent: "x".repeat(4001), memory: [] })).toBe(false)
  expect(Schema.is(payload)({ mode: "later", intent: "Open", memory: [] })).toBe(false)
  expect(Schema.is(payload)({ intent: "Open", memory: [] })).toBe(false)
  expect(Schema.is(payload)({ mode: "start", memory: [] })).toBe(false)

  const document = OpenApi.fromApi(HttpApi.make("prompt-generate").add(group))
  const post = document.paths["/api/session/{sessionID}/prompt-generate"]?.post
  expect(post?.description).toContain("one draft prompt for the mode from the intent")
  expect(post?.description).toContain("bounded recent conversation and selected memory")
  expect(post?.description).toContain("Nothing is admitted or sent")
  expect(post?.description).toContain("cancels an earlier in-flight one for the Session")
  expect(post?.responses?.["200"]).toBeDefined()
  expect(post?.responses?.["404"]).toBeDefined()
  expect(
    [...endpoint.error].some((schema) =>
      Schema.is(schema)(new SessionNotFoundError({ sessionID: "ses_missing", message: "Session not found" })),
    ),
  ).toBe(true)
})
