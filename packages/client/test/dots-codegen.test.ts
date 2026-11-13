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
  expect(promise.operations.map((operation) => operation.name)).toEqual([
    "get", "set", "attach", "detach", "remove", "threads", "task.updates", "thread.read", "thread.send", "thread.interrupt", "resume", "thread.requests", "thread.respond",
  ])
  const send = ClientApi.groups["server.dots"].endpoints["dots.thread.send"].payload.values().next().value?.schemas[0]
  if (!send) throw new Error("Canonical Dots send payload is missing")
  const message = { text: "Continue", clientMessageID: "client-1", mode: "queue" }
  expect(Schema.decodeUnknownSync(send)(message)).toEqual(message)
  for (const value of [{ ...message, mode: "steer" }, { text: "Continue", mode: "send" }, { ...message, threadID: "thr" }])
    expect(() => Schema.decodeUnknownSync(send)(value)).toThrow()
  const respond = ClientApi.groups["server.dots"].endpoints["dots.thread.respond"].payload.values().next().value?.schemas[0]
  if (!respond) throw new Error("Canonical Dots respond payload is missing")
  expect(Schema.decodeUnknownSync(respond)({ decision: "acceptForSession" })).toEqual({ decision: "acceptForSession" })
  expect(Schema.decodeUnknownSync(respond)({ answers: { q1: ["a"] } })).toEqual({ answers: { q1: ["a"] } })
  for (const value of [{ decision: "approved" }, { answers: { q1: [] } }, { decision: "accept", extra: true }])
    expect(() => Schema.decodeUnknownSync(respond)(value)).toThrow()
  const attach = ClientApi.groups["server.dots"].endpoints["dots.attach"].payload.values().next().value?.schemas[0]
  if (!attach) throw new Error("Canonical Dots attach payload is missing")
  expect(Schema.decodeUnknownSync(attach)({ replaceOthers: true })).toEqual({ replaceOthers: true })
  expect(Schema.decodeUnknownSync(attach)({ replaceOthers: false })).toEqual({ replaceOthers: false })
  for (const value of [{}, { replaceOthers: "true" }, { replaceOthers: true, environmentID: "env" }])
    expect(() => Schema.decodeUnknownSync(attach)(value)).toThrow()
  for (const name of ["dots.detach", "dots.remove"] as const) {
    const payload = ClientApi.groups["server.dots"].endpoints[name].payload.values().next().value?.schemas[0]
    if (!payload) throw new Error(`Canonical ${name} payload is missing`)
    expect(Schema.decodeUnknownSync(payload)({})).toEqual({})
    for (const value of [{ replaceOthers: true }, { expectedTarget: { dotID: "d" } }])
      expect(() => Schema.decodeUnknownSync(payload)(value)).toThrow()
  }
  const access = ClientApi.groups["server.dots"].endpoints["dots.set"].payload.values().next().value?.schemas[0]
  if (!access) throw new Error("Canonical Dots access payload is missing")
  const setter = { enabled: true, expectedRevision: 0 }
  expect(Schema.decodeUnknownSync(access)(setter)).toEqual(setter)
  for (const value of [{ enabled: true }, { ...setter, expectedRevision: -1 }, { ...setter, source: {} }, { ...setter, explicitDecision: true }])
    expect(() => Schema.decodeUnknownSync(access)(value)).toThrow()
})
