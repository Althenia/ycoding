import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import type { ConfigDiagnostic } from "../src/promise/generated/types"

const diagnostics: ConfigDiagnostic[] = [
  { path: "/tmp/ycoding.jsonc", reason: "removed-keys", jsonPath: "$.snapshot", message: "Removed key" },
  { path: "/tmp/ycoding.jsonc", reason: "invalid-values", jsonPath: "$.permissions[0]", failClosed: true, message: "Invalid rule; fails closed" },
  { path: "/tmp/ycoding.json", reason: "invalid-json", message: "Invalid JSON" },
]
const response = {
  location: { directory: "/fixture", project: { id: "global", directory: "/fixture" } },
  data: diagnostics,
}

test("generated Promise config diagnostics retain dropped paths and fail-closed markers", async () => {
  const { YCoding } = await import("../src/promise/index")
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      expect(new URL(input instanceof Request ? input.url : String(input)).pathname).toBe("/api/config/diagnostics")
      return Response.json(response)
    },
  })
  expect(await client.config.diagnostics()).toEqual(response)
})

test("generated Effect config diagnostics decode dropped paths and fail-closed markers", async () => {
  const { YCoding } = await import("../src/effect/index")
  const http = HttpClient.make((request) => {
    expect(new URL(request.url).pathname).toBe("/api/config/diagnostics")
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response)))
  })
  expect(await Effect.runPromise(Effect.gen(function* () {
    const client = yield* YCoding.make({ baseUrl: "http://localhost:3000" })
    return yield* client.config.diagnostics()
  }).pipe(Effect.provideService(HttpClient.HttpClient, http)))).toEqual(response)
})
