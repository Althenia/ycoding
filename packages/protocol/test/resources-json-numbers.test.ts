import { expect, test } from "bun:test"
import { Integration } from "@ycoding-ai/schema/integration"
import { Schema } from "effect"
import { ModelGroup } from "../src/groups/model.js"
import { IntegrationGroup } from "../src/groups/integration.js"
import { Location } from "@ycoding-ai/schema/location"
import { Project } from "@ycoding-ai/schema/project"
import { AbsolutePath } from "@ycoding-ai/schema/schema"

test("current JSON transport preserves fractional attempt timestamps but cannot round-trip nonfinite numbers", () => {
  const encode = Schema.encodeSync(Integration.AttemptStatus)
  const decode = Schema.decodeUnknownSync(Integration.AttemptStatus)
  const finite = { status: "pending" as const, time: { created: -0.5, expires: 0.5 } }
  expect(decode(JSON.parse(JSON.stringify(encode(finite))))).toEqual(finite)
  for (const value of [NaN, Infinity, -Infinity]) {
    const input = { status: "pending" as const, time: { created: value, expires: value } }
    expect(Schema.is(Integration.AttemptStatus)(input)).toBe(true)
    const json = JSON.parse(JSON.stringify(encode(input)))
    expect(json.time).toEqual({ created: null, expires: null })
    expect(() => decode(json)).toThrow()
  }
})

test("undefined-valued results encode as a required null branch, unlike optional fields", () => {
  const location = new Location.Info({
    directory: AbsolutePath.make("/example"),
    project: { id: Project.ID.make("example"), directory: AbsolutePath.make("/example") },
  })
  for (const endpoint of [ModelGroup.endpoints["model.default"], IntegrationGroup.endpoints["integration.get"]]) {
    const schema = [...endpoint.success][0] as
      | (typeof ModelGroup.endpoints)["model.default"]["~Success"]
      | (typeof IntegrationGroup.endpoints)["integration.get"]["~Success"]
    const json = JSON.parse(JSON.stringify(Schema.encodeSync(schema)({ location, data: undefined })))
    expect(json.data).toBeNull()
    expect(Schema.decodeUnknownSync(schema)(json).data).toBeUndefined()
    expect(() => Schema.decodeUnknownSync(schema)({ location: json.location })).toThrow("Missing key")
  }
})
