import { expect, test } from "bun:test"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsGroup } from "../src/groups/dots.js"

const document = OpenApi.fromApi(HttpApi.make("dots-test").add(DotsGroup))
const bare = {
  access: { enabled: true, revision: 1 },
  configuration: { ready: true, profile: "work" },
  connection: { state: "connected", hostname: "host" },
}
const status = { ...bare, computer: { state: "attached" } }
const success = (name: "dots.get" | "dots.set" | "dots.attach") => {
  const schema = [...DotsGroup.endpoints[name].success][0]
  if (!schema) throw new Error(`${name} success schema is missing`)
  return schema
}
const payload = (name: "dots.set" | "dots.attach") => {
  const schema = DotsGroup.endpoints[name].payload.values().next().value?.schemas[0]
  if (!schema) throw new Error(`${name} payload schema is missing`)
  return schema
}

test("global Dots access is read and written at one global path without a Session or Location", () => {
  expect(document.paths["/api/dots"]?.get?.operationId).toBe("dots.get")
  expect(document.paths["/api/dots"]?.put?.operationId).toBe("dots.set")
  expect(document.paths["/api/dots/computer"]?.post?.operationId).toBe("dots.attach")
  for (const path of Object.keys(document.paths)) expect(path).not.toContain("{")
  const set = payload("dots.set")
  expect("schema" in set && set.schema).toBe(Dots.AccessSet)
  expect(Schema.is(Dots.AccessSet)({ enabled: true, expectedRevision: 0 })).toBe(true)
  expect(Schema.is(Dots.AccessSet)({ enabled: true })).toBe(false)
  expect(Schema.is(Dots.AccessSet)({ expectedRevision: 0 })).toBe(false)
  expect(Schema.is(Dots.AccessSet)({ enabled: "true", expectedRevision: 0 })).toBe(false)
  expect(Schema.is(Dots.AccessSet)({ enabled: true, expectedRevision: -1 })).toBe(false)
})

test("every global Dots operation returns the wrapped native status", () => {
  for (const name of ["dots.get", "dots.set", "dots.attach"] as const) {
    const schema = success(name)
    expect(Schema.is(schema)({ data: status })).toBe(true)
    expect(Schema.is(schema)({ data: bare })).toBe(true)
    expect(Schema.is(schema)(status)).toBe(false)
    expect(Schema.is(schema)({ data: { ...status, access: undefined } })).toBe(false)
    expect(Schema.is(schema)({ data: { ...status, connection: { state: "open" } } })).toBe(false)
    expect(Schema.is(schema)({ data: { ...status, computer: { state: "other" } } })).toBe(false)
  }
})

test("computer attachment accepts either consent value with an optional expected target and rejects missing and excess fields", () => {
  const attach = payload("dots.attach")
  expect("schema" in attach && attach.schema).toBe(Dots.ComputerAttach)
  const decode = Schema.decodeUnknownSync(Dots.ComputerAttach)
  expect(decode({ replaceOthers: true })).toEqual({ replaceOthers: true })
  expect(decode({ replaceOthers: false })).toEqual({ replaceOthers: false })
  const expectedTarget = { dotID: "dot_1", threadID: "thr_1", environmentID: "env_1", revision: "a".repeat(64) }
  expect(decode({ replaceOthers: false, expectedTarget })).toEqual({ replaceOthers: false, expectedTarget })
  for (const value of [
    {},
    { replaceOthers: "true" },
    { replaceOthers: true, profile: "work" },
    { replaceOthers: true, expectedTarget: { ...expectedTarget, revision: "short" } },
    null,
  ])
    expect(() => decode(value)).toThrow()
})

test("Dots administration documents expose no credentials", () => {
  expect(JSON.stringify(document)).not.toContain("accessToken")
  expect(JSON.stringify(document)).not.toContain("refreshToken")
})
