import { expect, test } from "bun:test"
import { Schema } from "effect"
import { UsageForecast } from "../src/usage-forecast.js"

test("forecast encoding omits unavailable populations", () => {
  expect(Schema.encodeSync(UsageForecast.Info)({ asOf: 0, localScope: "backend", localRates: undefined, quotas: undefined })).toEqual({ asOf: 0, localScope: "backend" })
})

test("forecast decoding distinguishes successful empty reads from unavailable reads", () => {
  const decode = Schema.decodeUnknownSync(UsageForecast.Info)
  expect(decode({ asOf: 0, localScope: "backend" })).toEqual({ asOf: 0, localScope: "backend" })
  expect(decode({ asOf: 0, localScope: "backend", localRates: [], quotas: [] })).toEqual({ asOf: 0, localScope: "backend", localRates: [], quotas: [] })
})
