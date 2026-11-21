import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { compile, emitPromise } from "../src"

test("response-reachable named samples emit concrete definitions", () => {
  const request = Schema.Struct({ kind: Schema.Literal("request"), count: Schema.Number }).annotate({
    identifier: "Example.Request",
  })
  const sample = Schema.Union([request, Schema.String]).annotate({ identifier: "Example.Sample" })
  const page = Schema.Struct({ data: Schema.Array(Schema.Struct({ sample })) }).annotate({ identifier: "Example.Page" })
  const contract = compile(
    HttpApi.make("test").add(HttpApiGroup.make("example").add(HttpApiEndpoint.get("read", "/", { success: page }))),
  )
  const output = emitPromise(contract)
  const types = output.files.find((file) => file.path === "types.ts")!.content
  expect(types).toContain('export type ExampleRequest = { readonly "kind": "request", readonly "count": number }')
  expect(types).toContain("export type ExampleSample = ExampleRequest | string")
  expect(types).toContain('export type ExampleReadOutput = (ExamplePage)["data"]')
  expect(types.match(/export type ExampleRequest =/g)).toHaveLength(1)
})
