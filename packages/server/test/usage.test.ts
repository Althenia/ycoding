import { expect, test } from "bun:test"
import { SessionV2 } from "@ycoding-ai/core/session"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Api } from "../src/api"
import { UsageHandler } from "../src/handlers/usage"

const tokens = { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } }
const metrics = { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens }

test("keeps global usage behind the server authorization boundary", () => {
  expect(Api.groups["server.usage"].endpoints["usage.get"].middlewares.has(Authorization)).toBe(true)
  expect(Api.groups["server.usage"].endpoints["usage.report"].middlewares.has(Authorization)).toBe(true)
})

function fixture(service: Pick<SessionV2.Interface, "usageAll" | "usageReportAll">) {
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.usage"])).pipe(
      Layer.provide(
        UsageHandler.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(SessionV2.Service, {
                ...service,
                autonomy: { get: () => Effect.die("unused"), set: () => Effect.die("unused") },
                revert: {
                  stage: () => Effect.die("unused"),
                  clear: () => Effect.die("unused"),
                  commit: () => Effect.die("unused"),
                },
              }),
              Layer.succeed(Authorization, effect => effect),
              Layer.succeed(SchemaErrorMiddleware, effect => effect),
            ),
          ),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
    ),
  )
  return {
    request: (path: string) => handler.handler(new Request(`http://localhost${path}`)),
    [Symbol.asyncDispose]: () => handler.dispose(),
  }
}

test("serves backend-wide summary and forwards the complete report query without a Location", async () => {
  const received: unknown[] = []
  await using f = fixture({
    usageAll: () => Effect.succeed(metrics),
    usageReportAll: (input) =>
      Effect.sync(() => {
        received.push(input)
        return { group: input.group, rows: [], total: metrics, rowCount: 0 }
      }),
  })

  const summary = await f.request("/api/usage")
  expect(summary.status).toBe(200)
  expect(await summary.json()).toEqual({ data: metrics })
  const report = await f.request(
    "/api/usage/report?group=project&from=1&to=3&offset=2&limit=25&sort=cost&order=desc",
  )
  expect(report.status).toBe(200)
  expect(await report.json()).toEqual({ data: { group: "project", rows: [], total: metrics, rowCount: 0 } })
  expect(received).toEqual([
    { group: "project", from: 1, to: 3, offset: 2, limit: 25, sort: "cost", order: "desc" },
  ])
})

test("rejects an invalid global report query before the Core read", async () => {
  const calls = { value: 0 }
  await using f = fixture({
    usageAll: () => Effect.die("unused"),
    usageReportAll: () => Effect.sync(() => {
      calls.value++
      return { group: "project", rows: [], total: metrics, rowCount: 0 }
    }),
  })

  expect((await f.request("/api/usage/report?group=project&sort=requests")).status).toBe(400)
  expect(calls.value).toBe(0)
})
