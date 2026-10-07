import { expect, test } from "bun:test"
import { Integration } from "@ycoding-ai/schema/integration"
import { Location } from "@ycoding-ai/schema/location"
import { Schema } from "effect"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
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
