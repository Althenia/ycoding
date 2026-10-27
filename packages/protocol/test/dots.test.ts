import { expect, test } from "bun:test"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { SessionID } from "@ycoding-ai/schema/session-id"
import { SessionMessageID } from "@ycoding-ai/schema/session-message-id"
import { makeDotsGroup } from "../src/groups/dots.js"

class SessionLocation extends HttpApiMiddleware.Service<SessionLocation>()("dots-test-location") {}
const group = makeDotsGroup(SessionLocation)

test("native task delegation exposes only scoped typed status, human activation and revocation", () => {
  const document = OpenApi.fromApi(HttpApi.make("native-delegation-test").add(group))
  for (const [path, operation] of [["/api/session/{sessionID}/dots/delegation/status", "status"], ["/api/session/{sessionID}/dots/delegation", "create"], ["/api/session/{sessionID}/dots/delegation/revoke", "revoke"]])
    expect(document.paths[path!]?.post?.operationId).toBe(`session.dots.delegation.${operation}`)
  const payload = group.endpoints["session.dots.delegation.create"].payload.values().next().value?.schemas[0]
  if (!payload) throw new Error("Native delegation payload is missing")
  expect("schema" in payload && payload.schema).toBe(Dots.DelegationCreate)
  const decode = Schema.decodeUnknownSync(Schema.toCodecJson(Dots.DelegationCreate))
  const value: Dots.DelegationCreate = { proposalID: "proposal", sourceExchangeID: "exchange", targetSessionID: SessionID.make("ses_target"), taskInputID: SessionMessageID.ID.make("msg_human"), expectedAttachment: { profile: "fixture", dotID: "dot", threadID: "thread", generation: "1", label: "Fixture" }, scope: { operations: ["continue"] }, expiresAt: 1 }
  expect(decode(value)).toEqual(value)
  expect(() => decode({ ...value, principal: { ownerID: "spoofed" } })).toThrow()
})

test("device delegation administration and Dots decision inventory use Session-scoped POST routes", () => {
  const document = OpenApi.fromApi(HttpApi.make("device-delegation-test").add(group))
  for (const [path, operation] of [
    ["/api/session/{sessionID}/dots/delegation/device", "session.dots.delegation.device.create"],
    ["/api/session/{sessionID}/dots/delegation/device/read", "session.dots.delegation.device.read"],
    ["/api/session/{sessionID}/dots/delegation/device/revoke", "session.dots.delegation.device.revoke"],
    ["/api/session/{sessionID}/dots/decisions/list", "session.dots.decisions.list"],
  ]) expect(document.paths[path!]?.post?.operationId).toBe(operation)
})

test("device authority routes require authenticated source context and reject extra payload fields", () => {
  const remoteSource = { requestID: "request_fixture", epoch: "epoch_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" } }
  const expectedAttachment = { profile: "fixture", dotID: "dot", threadID: "thread", generation: "1", label: "Fixture" }
  const inputs = [
    ["session.dots.delegation.device.create", { id: "device_grant", exchangeID: "create_exchange", bindingID: "binding", expectedAttachment, scope: { target: "device", operations: ["decision"] } }],
    ["session.dots.delegation.device.read", {}],
    ["session.dots.delegation.device.revoke", { id: "device_grant", revision: 1, exchangeID: "revoke_exchange", bindingID: "binding", expectedAttachment }],
    ["session.dots.decisions.list", { bindingID: "binding", expectedAttachment, delegation: { id: "device_grant", revision: 1 } }],
  ] as const
  for (const [name, input] of inputs) {
    const payload = group.endpoints[name].payload.values().next().value?.schemas[0]
    if (!payload) throw new Error(`Missing payload for ${name}`)
    expect(Schema.is(payload)({ ...input, remoteSource })).toBe(true)
    expect(Schema.is(payload)(input)).toBe(false)
    expect(Schema.is(payload)({ ...input, remoteSource, caller: "spoofed" })).toBe(false)
  }
})

test("exchange create and read are typed Session-scoped operations with an authenticated source envelope", () => {
  const document = OpenApi.fromApi(HttpApi.make("dots-exchange-test").add(group))
  expect(document.paths["/api/session/{sessionID}/dots/exchanges"]?.post?.operationId).toBe("session.dots.exchange.create")
  expect(document.paths["/api/session/{sessionID}/dots/exchanges/read"]?.post?.operationId).toBe("session.dots.exchange.read")
})

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
  expect(document.paths["/api/session/{sessionID}/dots/unbind"]?.post?.operationId).toBe("session.dots.unbind")
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

test("unbind takes the confirmed target and returns the local status without credentials", () => {
  const expectedTarget = { profile: "synthetic", dotID: "dot", threadID: "thread", generation: "generation", label: "Fixture" }
  const endpoint = group.endpoints["session.dots.unbind"]
  const payload = endpoint?.payload.values().next().value?.schemas[0]
  const success = endpoint && [...endpoint.success][0]
  if (!payload || !success) throw new Error("Dots unbind schemas are missing")
  expect(Schema.is(payload)({ expectedTarget })).toBe(true)
  expect(Schema.is(payload)({})).toBe(false)
  expect(Schema.is(payload)({ expectedTarget: { ...expectedTarget, threadID: "" } })).toBe(false)
  expect(Schema.is(payload)({ expectedTarget, credentialID: "credential" })).toBe(true)
  expect(Schema.is(success)({ data: { enabled: true, state: "disconnected" } })).toBe(true)
  expect(Schema.is(success)({ data: { enabled: false, state: "disconnected" } })).toBe(true)
  expect(Schema.is(success)({ state: "disconnected" })).toBe(false)
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
