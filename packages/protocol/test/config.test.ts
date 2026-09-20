import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { Config } from "@ycoding-ai/schema/config"
import { ClientApi, effectOmitEndpoints, groupNames, promiseOmitEndpoints } from "../src/client.js"

const group = ClientApi.groups["server.config"].endpoints

const decode = (schema: Schema.ConstraintDecoder<unknown, never>, input: unknown) =>
  Schema.decodeUnknownOption(schema)(input)

function payload(endpoint: (typeof group)[keyof typeof group]) {
  const schema = endpoint.payload.values().next().value?.schemas[0]
  if (!schema) throw new Error("endpoint has no payload schema")
  return schema as unknown as Schema.ConstraintDecoder<unknown, never>
}

function success(endpoint: (typeof group)[keyof typeof group]) {
  const schema = endpoint.success.values().next().value
  if (!schema) throw new Error("endpoint has no success schema")
  return schema as unknown as Schema.ConstraintDecoder<unknown, never>
}

test("config routes are Location-scoped and expose read, preview, and commit", () => {
  expect(group["config.get"].path).toBe("/api/config")
  expect(group["config.get"].method).toBe("GET")
  expect(group["config.preview"].path).toBe("/api/config/preview")
  expect(group["config.preview"].method).toBe("POST")
  expect(group["config.commit"].path).toBe("/api/config")
  expect(group["config.commit"].method).toBe("PUT")
  for (const endpoint of Object.values(group)) expect(endpoint.middlewares.size).toBeGreaterThan(0)
})

test("the patch payload carries no filesystem path and no session override", () => {
  const patch = payload(group["config.commit"])

  expect(Option.isSome(decode(patch, { patch: { shell: "fish" }, scope: "project" }))).toBe(true)
  expect(Option.isSome(decode(patch, { patch: { shell: null }, scope: "global" }))).toBe(true)
  expect(
    Option.isSome(decode(patch, { patch: { shell: "fish" }, scope: "project", expectedRevision: "a".repeat(64) })),
  ).toBe(true)
  // Session overrides belong to the session contract, not to configuration files.
  expect(Option.isSome(decode(patch, { patch: {}, scope: "session" }))).toBe(false)

  // A client cannot choose the write target: the decoded payload has no path field for a handler
  // to read, even when the request body carries one.
  const withPath = decode(patch, { patch: {}, scope: "project", path: "/etc/passwd" })
  expect(Option.isSome(withPath)).toBe(true)
  expect(Option.isSome(withPath) && "path" in (withPath.value as object)).toBe(false)
})

test("the read response shape carries redacted values with provenance and revisions", () => {
  const response = success(group["config.get"])

  const decoded = decode(response, {
    location: { directory: "/tmp/x", project: { id: "global", directory: "/tmp/x" } },
    data: {
      values: { shell: "fish", providers: { openai: { settings: { apiKey: Config.REDACTED } } } },
      sources: [{ path: "/tmp/x/ycoding.json", scope: "project", keys: ["shell"], revision: "a".repeat(64) }],
    },
  })

  expect(Option.isSome(decoded)).toBe(true)
  const value = Option.getOrUndefined(decoded) as
    | { data: { sources: ReadonlyArray<{ scope: string }> } }
    | undefined
  expect(value?.data.sources[0]?.scope).toBe("project")
})

test("generated clients expose the config group without omitting its operations", () => {
  expect(groupNames["server.config"]).toBe("config")
  expect(promiseOmitEndpoints.has("config.get")).toBe(false)
  expect(promiseOmitEndpoints.has("config.commit")).toBe(false)
  expect(effectOmitEndpoints.has("config.commit")).toBe(false)
})
