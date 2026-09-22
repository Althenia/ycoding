import { expect, test } from "bun:test"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { ServiceStatus } from "@ycoding-ai/protocol/groups/health"
import { Api } from "../src/api"
import { SessionHandler } from "../src/handlers/session"
import { SessionLocationMiddleware } from "../src/middleware/session-location"
import { LocationMiddleware, type LocationServices } from "../src/location"
import { processIdentityLayer } from "../src/process-identity"

const sessionID = SessionV2.ID.make("ses_usage_report_http")
const metrics = {
  logical: 2,
  physical: 3,
  helpers: 1,
  continued: 1,
  fallback: 0,
  tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 20, write: 1 } },
  cacheReadReported: true,
}

function fixture(usageReport: SessionV2.Interface["usageReport"]) {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const location = Context.empty() as Context.Context<LocationServices>
  const locationCalls = { value: 0 }
  const services = Layer.mergeAll(
    Layer.mock(SessionV2.Service, {
      usageReport,
      autonomy: { get: () => Effect.die("unused"), set: () => Effect.die("unused") },
      daybreak: { set: () => Effect.die("unused") },
      revert: { stage: () => Effect.die("unused"), clear: () => Effect.die("unused"), commit: () => Effect.die("unused") },
    }),
    Layer.mock(SessionOrchestration.Service, {}),
    processIdentityLayer(ServiceStatus.Epoch.make("epoch_usage_report_test")),
    Layer.succeed(
      SessionLocationMiddleware,
      SessionLocationMiddleware.of((effect) =>
        Effect.sync(() => locationCalls.value++).pipe(Effect.andThen(Effect.provide(effect, location))),
      ),
    ),
    Layer.succeed(LocationMiddleware, effect => Effect.provide(effect, location)),
    Layer.succeed(Authorization, effect => effect),
    Layer.succeed(SchemaErrorMiddleware, effect => effect),
  )
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.session"])).pipe(
      Layer.provide(SessionHandler.pipe(Layer.provide(services))),
      Layer.provide(HttpServer.layerServices),
    ),
  )
  return {
    request: (query: string) =>
      handler.handler(new Request(`http://localhost/api/session/${sessionID}/usage/report?${query}`)),
    locationCalls,
    [Symbol.asyncDispose]: () => handler.dispose(),
  }
}

test("decodes a filtered report request through location middleware and returns the safe envelope", async () => {
  const received: unknown[] = []
  await using f = fixture((input) =>
    Effect.sync(() => {
      received.push(input)
      return {
        group: input.group,
        rows: [{ key: "2026-02-01", label: "2026-02-01", ...metrics }],
        total: metrics,
        rowCount: 1,
      }
    }),
  )

  const response = await f.request(
    "group=day&from=1769904000000&to=1769990400000&offset=0&limit=25&sort=tokens&order=desc",
  )
  expect(response.status).toBe(200)
  expect(f.locationCalls.value).toBe(1)
  expect(received).toEqual([
    {
      sessionID,
      group: "day",
      from: 1769904000000,
      to: 1769990400000,
      offset: 0,
      limit: 25,
      sort: "tokens",
      order: "desc",
    },
  ])
  const body = await response.json()
  expect(body).toEqual({
    data: {
      group: "day",
      rows: [{ key: "2026-02-01", label: "2026-02-01", ...metrics }],
      total: metrics,
      rowCount: 1,
    },
  })
  expect(JSON.stringify(body)).not.toMatch(/route|namespace|digest|promptCache|credential|payload|models/)
})

test("rejects invalid ranges and page limits before the Core report read", async () => {
  const calls = { value: 0 }
  await using f = fixture(() => Effect.sync(() => {
    calls.value++
    return { group: "day", rows: [], total: metrics, rowCount: 0 }
  }))

  for (const query of [
    "group=day&from=2&to=2",
    "group=day&limit=201",
    "group=day&sort=requests",
    "group=day&order=newest",
  ]) {
    const response = await f.request(query)
    expect(response.status).toBe(400)
  }
  expect(calls.value).toBe(0)
})

test("retains the typed unknown-Session response", async () => {
  await using f = fixture(() => Effect.fail(new SessionV2.NotFoundError({ sessionID })))
  const response = await f.request("group=project")

  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID })
})
