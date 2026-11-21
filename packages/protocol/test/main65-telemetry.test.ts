import { expect, test } from "bun:test"
import { Telemetry } from "@ycoding-ai/schema/telemetry"
import { Schema } from "effect"
import { CONTRACT_DIGEST, messages } from "../src/generated/v5/contract.js"
import { operations } from "../src/generated/v5/operations.js"
import { platformEndpoints, platformRpcEndpoints } from "./platform-source.js"

test("native telemetry projection uses the canonical page and rejects retired operations", () => {
  const source = platformRpcEndpoints().find(({ endpoint }) => endpoint.identifier === "telemetry.list")!
  const pageSchema = [...source.endpoint.success][0]
  const sample = {
    kind: "request",
    at: "2026-01-01T00:00:00.000Z",
    operation: "session.message.delete",
    outcome: "ok",
    queueMs: 0,
    totalMs: 1,
  } satisfies Telemetry.Sample
  const page = { data: [{ receivedAt: 1, sample }], cursor: { next: "next" } }
  expect(Schema.is(pageSchema)(page)).toBe(true)
  expect(Schema.is(Telemetry.Page)(page)).toBe(true)
  expect(
    Schema.is(pageSchema)({
      ...page,
      data: [{ receivedAt: 1, sample: { ...sample, operation: "session.dots.send" } }],
    }),
  ).toBe(false)
})

test("telemetry list retains the canonical descriptor and Page field tags", () => {
  expect(CONTRACT_DIGEST).toBe("d5f41604d11dc02a212300b3e387bb51bbb8554537fe3f428891a22f180969c5")
  const operation = operations.find((item) => item.diagnosticName === "telemetry.list")!
  expect(operation.operationId).toBe(3049)
  expect(operation.resultType).toBe("ycoding.v5.telemetry_list_Result")
  expect(
    messages["ycoding.v5.Telemetry_Page_dataItem"].fields.map((field) => [
      field.name,
      field.tag,
      "target" in field ? field.target : undefined,
    ]),
  ).toEqual([
    ["receivedAt", 1, ""],
    ["sample", 2, "ycoding.v5.Telemetry_Sample"],
  ])
})

test("Bun HTTP and v5 append accept both canonical delete labels", () => {
  const appendSchema = (endpoints: ReturnType<typeof platformEndpoints>) => {
    const endpoint = endpoints.find(({ endpoint }) => endpoint.identifier === "telemetry.append")!.endpoint
    return [...endpoint.payload.values()][0].schemas[0]
  }
  const sample = {
    kind: "request",
    at: "2026-01-01T00:00:00.000Z",
    outcome: "ok",
    queueMs: 0,
    totalMs: 0,
  }
  const json = { samples: [{ ...sample, operation: "session.message.delete" }] }
  const binary = { samples: [{ ...sample, operation: "session.deleteMessage" }] }
  const http = Schema.is(appendSchema(platformEndpoints()))
  const v5 = Schema.is(appendSchema(platformRpcEndpoints()))
  expect(http(json)).toBe(true)
  expect(http(binary)).toBe(true)
  expect(v5(binary)).toBe(true)
  expect(v5(json)).toBe(true)
})
