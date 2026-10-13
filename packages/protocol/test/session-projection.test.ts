import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApiEndpoint } from "effect/unstable/httpapi"
import { wireContract } from "./wire-contract.js"
import { resourceFieldConstraints } from "./resources-contract.js"
import { DateTimeUtcFromMillis } from "@ycoding-ai/schema/schema"

test("homogeneous nonempty arrays preserve their minimum and optional never has no wire field", () => {
  const endpoint = HttpApiEndpoint.post("test.shape", "/shape", {
    payload: Schema.Struct({ fields: Schema.NonEmptyArray(Schema.String), absent: Schema.optional(Schema.Never) }),
    success: Schema.Void,
  })
  const contract = wireContract(
    [{ group: "test", endpoint }],
    { "test.shape": 4000 },
    () => "packages/schema/src/form.ts#Form.Fields",
    [],
  )
  const fields = contract.messages.get("test_shape_Request_payload")!.fields
  expect(fields.map((field) => field.name)).toEqual(["fields"])
  const array = contract.messages.get(fields[0].type)!.fields[0]
  expect(array.presence).toBe("repeated")
  expect(array.type).toBe("LosslessString")
  expect(resourceFieldConstraints(array).countMin).toBe(1)
})

test("UTC admission timestamps retain the finite millisecond JSON representation", () => {
  const endpoint = HttpApiEndpoint.post("test.time", "/time", {
    success: Schema.Struct({ timeCreated: DateTimeUtcFromMillis }),
  })
  const contract = wireContract(
    [{ group: "test", endpoint }],
    { "test.time": 4000 },
    () => "packages/schema/src/schema.ts#DateTimeUtcFromMillis",
    [],
  )
  const field = contract.messages.get("test_time_Result")!.fields[0]
  expect(field.type).toBe("double")
  expect(field.source).toBe("packages/schema/src/schema.ts#DateTimeUtcFromMillis")
  expect(Schema.encodeSync(DateTimeUtcFromMillis)(Schema.decodeSync(DateTimeUtcFromMillis)(1234))).toBe(1234)
})
