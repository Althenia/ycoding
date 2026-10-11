import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "../src/config.js"

test("configuration diagnostics preserve JSON paths and fail-closed markers and omit absent fields", () => {
  for (const diagnostic of [
    { path: "/tmp/ycoding.jsonc", reason: "invalid-json", message: "Invalid JSON" },
    { path: "/tmp/ycoding.jsonc", reason: "removed-keys", jsonPath: "$.snapshot", message: "Removed key" },
    { path: "/tmp/ycoding.jsonc", reason: "invalid-values", jsonPath: "$.permissions[0]", failClosed: true, message: "Invalid rule; fails closed" },
  ] as const) {
    const decoded = Schema.decodeUnknownSync(Config.Diagnostic)(diagnostic)
    expect(decoded).toEqual(diagnostic)
    expect(Schema.encodeSync(Config.Diagnostic)(decoded)).toEqual(diagnostic)
  }
})
