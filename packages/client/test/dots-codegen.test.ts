import { expect, test } from "bun:test"
import { compile, emitEffectImported, emitEffectShape, emitPromise } from "@ycoding-ai/httpapi-codegen"
import { makeDotsGroup } from "@ycoding-ai/protocol/groups/dots"
import { ClientApi } from "@ycoding-ai/protocol/client"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware } from "effect/unstable/httpapi"

class SessionLocation extends HttpApiMiddleware.Service<SessionLocation>()("dots-codegen-location") {}

test("Dots contracts compile for both clients", () => {
  const contract = compile(HttpApi.make("dots-codegen").add(makeDotsGroup(SessionLocation)))
  const promise = emitPromise(contract)
  const effect = emitEffectImported(contract, { module: "@ycoding-ai/protocol/client", api: "ClientApi" })
  const shape = emitEffectShape(contract, { module: "@ycoding-ai/protocol/client", api: "ClientApi" })
  expect(promise.operations).toEqual(effect.operations)
  expect(promise.operations).toEqual(shape.operations)
  expect(effect.files.find((file) => file.path === "client.ts")?.content).toContain("HttpApiClient.make(ClientApi")
  expect(promise.operations.map((operation) => operation.name)).toEqual(["access.get", "access.set"])
  const access = ClientApi.groups["server.dots"].endpoints["session.dots.access.set"].payload.values().next().value?.schemas[0]
  if (!access) throw new Error("Canonical Dots access payload is missing")
  const setter = { enabled: true, expectedRevision: 0 }
  expect(Schema.decodeUnknownSync(access)(setter)).toEqual(setter)
  for (const value of [{ enabled: true }, { ...setter, expectedRevision: -1 }, { ...setter, source: {} }, { ...setter, explicitDecision: true }])
    expect(() => Schema.decodeUnknownSync(access)(value)).toThrow()
})
