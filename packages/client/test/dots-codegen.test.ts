import { expect, test } from "bun:test"
import { compile, emitEffectImported, emitEffectShape, emitPromise } from "@ycoding-ai/httpapi-codegen"
import { ClientApi } from "@ycoding-ai/protocol/client"
import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"

test("Dots contracts compile for both clients", () => {
  const contract = compile(HttpApi.make("dots-codegen").add(ClientApi.groups["server.dots"]))
  const promise = emitPromise(contract)
  const effect = emitEffectImported(contract, { module: "@ycoding-ai/protocol/client", api: "ClientApi" })
  const shape = emitEffectShape(contract, { module: "@ycoding-ai/protocol/client", api: "ClientApi" })
  expect(promise.operations).toEqual(effect.operations)
  expect(promise.operations).toEqual(shape.operations)
  expect(effect.files.find((file) => file.path === "client.ts")?.content).toContain("HttpApiClient.make(ClientApi")
  expect(promise.operations.map((operation) => operation.name)).toEqual(["get", "set", "attach"])
  const attach = ClientApi.groups["server.dots"].endpoints["dots.attach"].payload.values().next().value?.schemas[0]
  if (!attach) throw new Error("Canonical Dots attach payload is missing")
  expect(Schema.decodeUnknownSync(attach)({ replaceOthers: true })).toEqual({ replaceOthers: true })
  for (const value of [{}, { replaceOthers: false }, { replaceOthers: "true" }, { replaceOthers: true, environmentID: "env" }])
    expect(() => Schema.decodeUnknownSync(attach)(value)).toThrow()
  const access = ClientApi.groups["server.dots"].endpoints["dots.set"].payload.values().next().value?.schemas[0]
  if (!access) throw new Error("Canonical Dots access payload is missing")
  const setter = { enabled: true, expectedRevision: 0 }
  expect(Schema.decodeUnknownSync(access)(setter)).toEqual(setter)
  for (const value of [{ enabled: true }, { ...setter, expectedRevision: -1 }, { ...setter, source: {} }, { ...setter, explicitDecision: true }])
    expect(() => Schema.decodeUnknownSync(access)(value)).toThrow()
})
