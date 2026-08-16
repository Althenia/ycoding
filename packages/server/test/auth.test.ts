import { expect, test } from "bun:test"
import { ServerAuth } from "@ycoding-ai/server/auth"
import { Option, Redacted } from "effect"

test("accepts only the fixed ycoding username", () => {
  const config = { password: Option.some("secret"), username: "ycoding" }
  expect(ServerAuth.authorized({ username: "ycoding", password: Redacted.make("secret") }, config)).toBe(true)
  expect(ServerAuth.authorized({ username: "custom", password: Redacted.make("secret") }, config)).toBe(false)
})

test("encodes the fixed ycoding username", () => {
  expect(ServerAuth.header({ password: "secret" })).toBe(`Basic ${Buffer.from("ycoding:secret").toString("base64")}`)
})
