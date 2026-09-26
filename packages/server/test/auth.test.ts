import { expect, test } from "bun:test"
import { ServerAuth } from "@ycoding-ai/server/auth"
import { Effect, Option, Redacted } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { authorizedRequest } from "../src/middleware/authorization"

test("accepts only the fixed ycoding username", () => {
  const config = { password: Option.some("secret"), username: "ycoding" }
  expect(ServerAuth.authorized({ username: "ycoding", password: Redacted.make("secret") }, config)).toBe(true)
  expect(ServerAuth.authorized({ username: "custom", password: Redacted.make("secret") }, config)).toBe(false)
})

test("encodes the fixed ycoding username", () => {
  expect(ServerAuth.header({ password: "secret" })).toBe(`Basic ${Buffer.from("ycoding:secret").toString("base64")}`)
})

test("authenticates HTTP requests only from the Authorization header", async () => {
  const config = { password: Option.some("secret"), username: "ycoding" }
  const token = encodeURIComponent(Buffer.from("ycoding:secret").toString("base64"))
  const request = (url: string, authorization?: string) =>
    Effect.runPromise(
      authorizedRequest(
        HttpServerRequest.fromWeb(
          new Request(url, {
            headers: authorization ? { authorization } : undefined,
          }),
        ),
        config,
      ),
    )

  expect(await request(`http://localhost/api/health?auth_token=${token}`)).toBe(false)
  expect(await request(`http://localhost/openapi.json?auth_token=${token}`)).toBe(false)
  expect(
    await request(`http://localhost/api/health?auth_token=${token}`, ServerAuth.header({ password: "secret" })),
  ).toBe(true)
  expect(await request("http://localhost/api/health", ServerAuth.header({ password: "secret" }))).toBe(true)
})
