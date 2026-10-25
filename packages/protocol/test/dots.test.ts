import { expect, test } from "bun:test"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { makeDotsGroup } from "../src/groups/dots.js"

class SessionLocation extends HttpApiMiddleware.Service<SessionLocation>()("dots-test-location") {}
const group = makeDotsGroup(SessionLocation)

test("status explicitly reports whether the Location enables Dots", () => {
  const schema = [...group.endpoints["session.dots.status"].success][0]
  if (!schema) throw new Error("Dots status response is missing")
  expect(Schema.is(schema)({ data: { state: "disconnected", enabled: false } })).toBe(true)
  expect(Schema.is(schema)({ data: { state: "disconnected", enabled: true } })).toBe(true)
  expect(Schema.is(schema)({ data: { state: "disconnected" } })).toBe(false)
  expect(Schema.is(schema)({ data: { state: "disconnected", enabled: "true" } })).toBe(false)
})

test("Dots controls are Session-owned and do not expose credentials", () => {
  const document = OpenApi.fromApi(HttpApi.make("dots-test").add(group))
  expect(document.paths["/api/session/{sessionID}/dots/send"]?.post?.operationId).toBe("session.dots.send")
  expect(document.paths["/api/session/{sessionID}/dots/targets"]?.get?.operationId).toBe("session.dots.targets")
  expect(document.paths["/api/session/{sessionID}/dots/bind"]?.post?.operationId).toBe("session.dots.bind")
  expect(document.paths["/api/session/{sessionID}/dots/pause"]?.post?.operationId).toBe("session.dots.pause")
  expect(document.paths["/api/session/{sessionID}/dots/resume"]?.post?.operationId).toBe("session.dots.resume")
  expect(document.paths["/api/session/{sessionID}/dots/cancel"]).toBeUndefined()
  expect(JSON.stringify(document)).not.toContain("accessToken")
  expect(JSON.stringify(document)).not.toContain("refreshToken")
})

test("runtime controls require a confirmed target and return the runtime status", () => {
  const expectedTarget = { profile: "synthetic", dotID: "dot", threadID: "thread", generation: "generation", label: "Fixture" }
  for (const name of ["session.dots.pause", "session.dots.resume"] as const) {
    const endpoint = group.endpoints[name]
    const payload = endpoint?.payload.values().next().value?.schemas[0]
    const success = endpoint && [...endpoint.success][0]
    expect(payload).toBeDefined()
    expect(success).toBeDefined()
    if (!payload || !success) continue
    expect(Schema.is(payload)({ expectedTarget })).toBe(true)
    expect(Schema.is(payload)({ turnID: "turn" })).toBe(false)
    expect(Schema.is(payload)({ expectedTarget: { ...expectedTarget, generation: "" } })).toBe(false)
    for (const runtimeState of ["paused", "unpaused", "unknown"])
      expect(Schema.is(success)({ data: { enabled: true, state: "connected", target: expectedTarget, runtimeState } })).toBe(true)
  }
})

test("send requires a client identity and carries explicit attachments only", () => {
  const endpoint = group.endpoints["session.dots.send"]
  const schema = endpoint.payload.values().next().value?.schemas[0]
  if (!schema) throw new Error("Dots send payload is missing")
  expect(Schema.is(schema)({ text: "hello" })).toBe(false)
  expect(
    Schema.is(schema)({
      id: "send-1",
      text: "hello",
      expectedTarget: {
        profile: "synthetic",
        dotID: "dot-1",
        threadID: "thread-1",
        generation: "generation-1",
        label: "Fixture conversation",
      },
      files: [{ uri: "data:text/plain;base64,eA==", name: "chosen.txt" }],
    }),
  ).toBe(true)
  expect(Schema.is(schema)({ id: "send-1", text: "hello" })).toBe(false)
})

test("target binding requires stable Dot, thread and generation identities", () => {
  const schema = group.endpoints["session.dots.bind"].payload.values().next().value?.schemas[0]
  if (!schema) throw new Error("Dots binding payload is missing")
  expect(Schema.is(schema)({ profile: "synthetic", label: "Fixture" })).toBe(false)
  expect(
    Schema.is(schema)({
      profile: "synthetic",
      dotID: "dot-1",
      threadID: "thread-1",
      generation: "generation-1",
      label: "Fixture conversation",
    }),
  ).toBe(true)
})
