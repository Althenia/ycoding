import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { CapturedInputsQuery, MessageGroup } from "../src/groups/message.js"

test("captured input pages have an additive bounded query and preserve complete message list", () => {
  const api = OpenApi.fromApi(HttpApi.make("message-test").add(MessageGroup))
  const operation = api.paths["/api/session/{sessionID}/message/captured-inputs"]?.get
  expect(operation?.operationId).toBe("message.capturedInputs")
  expect(operation?.parameters?.map((item) => "$ref" in item ? item.$ref : item.name)).toEqual(["sessionID", "after", "limit"])
  expect(api.paths["/api/session/{sessionID}/message"]?.get?.parameters?.map((item) => "$ref" in item ? item.$ref : item.name)).toEqual(["sessionID"])
  const endpoint = MessageGroup.endpoints["session.capturedInputs"]
  expect(endpoint).toBeDefined()
  const query = CapturedInputsQuery
  expect(Schema.decodeUnknownSync(query)({ after: "1", limit: "200" })).toEqual({ after: 1, limit: 200 })
  for (const input of [{ limit: "0" }, { limit: "201" }, { limit: "1.5" }, { after: "-1" }, { after: "NaN" }, { after: "Infinity" }])
    expect(() => Schema.decodeUnknownSync(query)(input)).toThrow()
})
