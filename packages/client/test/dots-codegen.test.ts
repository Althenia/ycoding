import { expect, test } from "bun:test"
import { compile, emitEffectImported, emitEffectShape, emitPromise } from "@ycoding-ai/httpapi-codegen"
import { makeDotsGroup } from "@ycoding-ai/protocol/groups/dots"
import { ClientApi } from "@ycoding-ai/protocol/client"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware } from "effect/unstable/httpapi"

class SessionLocation extends HttpApiMiddleware.Service<SessionLocation>()("dots-codegen-location") {}

test("Dots task delegation contracts compile for both clients", () => {
  const contract = compile(HttpApi.make("dots-codegen").add(makeDotsGroup(SessionLocation)))
  const promise = emitPromise(contract)
  const effect = emitEffectImported(contract, { module: "@ycoding-ai/protocol/client", api: "ClientApi" })
  const shape = emitEffectShape(contract, { module: "@ycoding-ai/protocol/client", api: "ClientApi" })
  expect(promise.operations).toEqual(effect.operations)
  expect(promise.operations).toEqual(shape.operations)
  expect(effect.files.find((file) => file.path === "client.ts")?.content).toContain("HttpApiClient.make(ClientApi")
  expect(promise.operations.map((operation) => operation.name)).toEqual(expect.arrayContaining([
    "exchange.create", "delegation.status", "delegation.create", "delegation.revoke",
  ]))
  const native = ClientApi.groups["server.dots"].endpoints["session.dots.delegation.create"].payload.values().next().value?.schemas[0]
  const exchange = ClientApi.groups["server.dots"].endpoints["session.dots.exchange.create"].payload.values().next().value?.schemas[0]
  if (!native || !exchange) throw new Error("Canonical Dots payloads are missing")
  const expectedAttachment = { profile: "fixture", dotID: "dot", threadID: "thread", generation: "1", label: "Fixture" }
  const proposal = { proposalID: "proposal", sourceExchangeID: "source", targetSessionID: "ses_target", taskInputID: "msg_human", expectedAttachment, scope: { operations: ["continue"] }, expiresAt: 1 }
  expect(Schema.decodeUnknownSync(native)(proposal)).toEqual(proposal)
  for (const scope of [{ operations: ["continue", "continue"] }, { operations: ["continue"], format: ["bullets"] }, { operations: ["presentation"] }])
    expect(() => Schema.decodeUnknownSync(native)({ ...proposal, scope })).toThrow()
  const routine = { exchangeID: "routine", expectedAttachment, targetSessionID: "ses_target", channel: "task", delivery: "queue", delegation: { id: "proposal", revision: 1 }, taskInputID: "msg_human", instruction: { operation: "presentation", preferences: {} }, remoteSource: { requestID: "request", epoch: "epoch", principal: { ownerID: "owner", deviceID: "device", clientID: "client" } } }
  expect(() => Schema.decodeUnknownSync(exchange)(routine)).toThrow()
})
