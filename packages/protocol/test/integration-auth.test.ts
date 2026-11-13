import { expect, test } from "bun:test"
import { Integration } from "@ycoding-ai/schema/integration"
import { Location } from "@ycoding-ai/schema/location"
import { Schema } from "effect"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { CredentialGroup } from "../src/groups/credential.js"
import { IntegrationGroup } from "../src/groups/integration.js"

const connect = IntegrationGroup.endpoints["integration.oauth.connect"]
const complete = IntegrationGroup.endpoints["integration.oauth.complete"]

test("automatic OAuth advertises manual code only when supported", () => {
  expect(connect.path).toBe("/api/integration/:integrationID/connect/oauth")
  const success = [...connect.success][0]
  if (!success) throw new Error("OAuth connect has no response schema")
  const decode = Schema.decodeUnknownSync(Location.response(Integration.Attempt))
  const location = { directory: "/project", project: { id: "proj_test", directory: "/project" } }
  const attempt = {
    attemptID: "con_test",
    url: "https://example.test/authorize",
    instructions: "Sign in or enter the code",
    mode: "auto",
    time: { created: 1, expires: 2 },
  }
  expect(decode({ location, data: attempt }).data.manualCode).toBeUndefined()
  expect(decode({ location, data: { ...attempt, manualCode: true } }).data.manualCode).toBe(true)
  expect(() => decode({ location, data: { ...attempt, manualCode: "true" } })).toThrow()
  const encoded = Schema.encodeSync(Integration.Attempt)(new Integration.Attempt({ ...decode({ location, data: attempt }).data, manualCode: undefined }))
  expect(Object.hasOwn(encoded, "manualCode")).toBe(false)
})

test("OAuth completion accepts optional code for an already-running automatic attempt", () => {
  expect(complete.path).toBe("/api/integration/:integrationID/connect/oauth/:attemptID/complete")
  const payload = complete.payload.values().next().value?.schemas[0]
  if (!payload) throw new Error("OAuth completion has no request schema")
  expect(Schema.is(payload)({ code: "code#state" })).toBe(true)
  expect(Schema.is(payload)({})).toBe(true)
  expect(Schema.is(payload)({ code: 42 })).toBe(false)
})

test("OpenAPI exposes the optional manual-code capability on the connect response", () => {
  const document = OpenApi.fromApi(HttpApi.make("integration-test").add(IntegrationGroup))
  const operation = document.paths["/api/integration/{integrationID}/connect/oauth"]?.post
  const response = operation?.responses?.[200]?.content?.["application/json"]?.schema
  expect(operation?.operationId).toBe("integration.oauth.connect")
  expect(response).toMatchObject({ properties: { data: { $ref: "#/components/schemas/Integration.Attempt" } } })
  const attempt = document.components?.schemas?.["Integration.Attempt"]
  expect(attempt).toMatchObject({ properties: { manualCode: { type: "boolean" } } })
  expect(attempt).not.toMatchObject({ required: expect.arrayContaining(["manualCode"]) })
})

test("integration list and get decode credential connections from servers that predate kind", () => {
  expect(IntegrationGroup.endpoints["integration.list"].path).toBe("/api/integration")
  expect(IntegrationGroup.endpoints["integration.get"].path).toBe("/api/integration/:integrationID")
  const location = { directory: "/project", project: { id: "proj_test", directory: "/project" } }
  const integration = {
    id: "acme",
    name: "Acme",
    methods: [],
    connections: [
      { type: "credential", id: "cred_old", label: "Old", active: true },
      { type: "credential", id: "cred_new", label: "New", active: false, kind: "oauth" },
      { type: "env", name: "ACME_KEY" },
    ],
  }
  const listed = Schema.decodeUnknownSync(Location.response(Schema.Array(Integration.Info)))({ location, data: [integration] })
  const fetched = Schema.decodeUnknownSync(Location.response(Schema.UndefinedOr(Integration.Info)))({ location, data: integration })
  const summary = (connections: Integration.Info["connections"] = []): unknown[] =>
    connections.map((connection) =>
      connection.type === "credential" ? [connection.id, Object.hasOwn(connection, "kind"), connection.kind] : [connection.name],
    )
  const expected = [["cred_old", false, undefined], ["cred_new", true, "oauth"], ["ACME_KEY"]]
  expect(summary(listed.data[0]?.connections)).toEqual(expected)
  expect(summary(fetched.data?.connections)).toEqual(expected)
})

test("credential refresh returns a refreshed expiry or the exact failure message", () => {
  const refresh = CredentialGroup.endpoints["credential.refresh"]
  expect(refresh.method).toBe("POST")
  expect(refresh.path).toBe("/api/credential/:credentialID/refresh")
  const location = { directory: "/project", project: { id: "proj_test", directory: "/project" } }
  const decode = Schema.decodeUnknownSync(Location.response(Integration.RefreshResult))
  expect(decode({ location, data: { status: "refreshed", expires: 10 } }).data).toEqual({ status: "refreshed", expires: 10 })
  expect(decode({ location, data: { status: "failed", message: "invalid_grant" } }).data).toEqual({
    status: "failed",
    message: "invalid_grant",
  })
  expect(() => decode({ location, data: { status: "refreshed" } })).toThrow()
  expect(() => decode({ location, data: { status: "pending", message: "x" } })).toThrow()
  const document = OpenApi.fromApi(HttpApi.make("credential-test").add(CredentialGroup))
  const operation = document.paths["/api/credential/{credentialID}/refresh"]?.post
  expect(operation?.operationId).toBe("credential.refresh")
  expect(operation?.responses?.[200]?.content?.["application/json"]?.schema).toMatchObject({
    properties: { data: { $ref: "#/components/schemas/Integration.RefreshResult" } },
  })
})

test("OAuth and key connection payloads accept an optional replacement target", () => {
  for (const [name, base] of [
    ["integration.oauth.connect", { methodID: "browser", inputs: {} }],
    ["integration.connect.key", { key: "sk-synthetic-key" }],
  ] as const) {
    const payload = IntegrationGroup.endpoints[name].payload.values().next().value?.schemas[0]
    if (!payload) throw new Error(`${name} has no request schema`)
    expect(Schema.is(payload)({ ...base, credentialID: "cred_target" })).toBe(true)
    expect(Schema.is(payload)(base)).toBe(true)
    expect(Schema.is(payload)({ ...base, credentialID: 7 })).toBe(false)
  }
})

test("credential connections carry connection status and the last refresh failure", () => {
  const location = { directory: "/project", project: { id: "proj_test", directory: "/project" } }
  const integration = {
    id: "acme",
    name: "Acme",
    methods: [],
    connections: [
      { type: "credential", id: "cred_a", label: "A", active: true, kind: "oauth", status: "connected" },
      { type: "credential", id: "cred_b", label: "B", active: false, kind: "oauth", status: "expired" },
      { type: "credential", id: "cred_c", label: "C", active: false, kind: "oauth", status: "refresh_failed", message: "invalid_grant" },
      { type: "env", name: "ACME_KEY" },
    ],
  }
  const decoded = Schema.decodeUnknownSync(Location.response(Schema.Array(Integration.Info)))({ location, data: [integration] })
  expect(JSON.parse(JSON.stringify(decoded.data[0]?.connections))).toEqual(integration.connections)
  expect(() =>
    Schema.decodeUnknownSync(Location.response(Schema.Array(Integration.Info)))({
      location,
      data: [{ ...integration, connections: [{ type: "credential", id: "cred_d", label: "D", active: true, status: "revoked" }] }],
    }),
  ).toThrow()
})
