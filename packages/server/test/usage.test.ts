import { expect, test } from "bun:test"
import { Session } from "@ycoding-ai/core/session"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { UsageDashboardRuntime } from "@ycoding-ai/core/usage-dashboard"
import { UsageDashboardRead } from "@ycoding-ai/core/usage-dashboard-read"
import { UsageViews } from "@ycoding-ai/core/usage-view"
import { GenerationActivity } from "@ycoding-ai/core/generation-activity"
import { Deferred, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Api } from "../src/api"
import { UsageHandler } from "../src/handlers/usage"
import { fixedLocations } from "../../core/test/fixture/location-map"

const tokens = { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } }
const metrics = { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens }

test("keeps global usage behind the server authorization boundary", () => {
  expect(Api.groups["server.usage"].endpoints["usage.get"].middlewares.has(Authorization)).toBe(true)
  expect(Api.groups["server.usage"].endpoints["usage.report"].middlewares.has(Authorization)).toBe(true)
  expect(Api.groups["server.usage"].endpoints["usage.dashboard"].middlewares.has(Authorization)).toBe(true)
})

const unusedSession = { usageAll: () => Effect.die("unused"), usageReportAll: () => Effect.die("unused") }

type DashboardService = UsageDashboardRead.Interface
type DashboardInput = Parameters<DashboardService["read"]>[1]
type DashboardInfo = Effect.Success<ReturnType<DashboardService["read"]>>

const reading = (read: DashboardService["read"]) => Layer.mock(UsageDashboardRead.Service, { read })

function fixture(
  service: Pick<Session.Interface, "usageAll" | "usageReportAll">,
  dashboard: Layer.Layer<UsageDashboardRead.Service> = reading(() => Effect.die("unused")),
) {
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.usage"])).pipe(
      Layer.provide(
        UsageHandler.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Session.Service, {
                ...service,
                autonomy: { get: () => Effect.die("unused"), set: () => Effect.die("unused"), effective: () => Effect.die("unused") },
                daybreak: { set: () => Effect.die("unused") },
                revert: {
                  stage: () => Effect.die("unused"),
                  clear: () => Effect.die("unused"),
                  commit: () => Effect.die("unused"),
                },
              }),
              dashboard,
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
    post: (path: string, body: unknown) =>
      handler.handler(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })),
    postWith: (path: string, body: unknown, headers: Record<string, string>) =>
      handler.handler(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })),
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
    "/api/usage/report?group=project&from=1&to=3&offset=2&limit=25&sort=cost&order=desc&timeZone=Asia%2FKathmandu",
  )
  expect(report.status).toBe(200)
  expect(await report.json()).toEqual({ data: { group: "project", rows: [], total: metrics, rowCount: 0 } })
  expect(received).toEqual([
    { group: "project", from: 1, to: 3, offset: 2, limit: 25, sort: "cost", order: "desc", timeZone: "Asia/Kathmandu" },
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
  expect((await f.request("/api/usage/report?group=day&timeZone=Mars%2FOlympus_Mons")).status).toBe(400)
  expect(calls.value).toBe(0)
})

const dashboardInput = {
  daily: { group: "day", from: 0, to: 10, timeZone: "Asia/Kathmandu" },
  monthly: { group: "month", timeZone: "UTC" },
  breakdown: { group: "provider-model", limit: 25 },
} as const
const dashboardReady = {
  status: "ready",
  asOf: 5,
  revision: "r1",
  summary: metrics,
  quota: { status: "ready", providers: [], forecast: { asOf: 4, localScope: "backend" } },
  live: { asOf: 6, active: 0, streaming: 0, models: [], history: [] },
  daily: { group: "day", rows: [], total: metrics, rowCount: 0 },
  monthly: { group: "month", rows: [], total: metrics, rowCount: 0 },
  breakdown: { group: "provider-model", rows: [], total: metrics, rowCount: 0 },
} as const

test("serves the composed dashboard through one runtime read and returns every status unchanged", async () => {
  const received: unknown[] = []
  const answers: DashboardInfo[] = [{ status: "preparing" }, { status: "error", message: "failed" }, dashboardReady]
  await using f = fixture(
    unusedSession,
    reading((_location, input) =>
      Effect.sync(() => {
        received.push(input)
        return answers.shift()!
      }),
    ),
  )

  for (const expected of [{ status: "preparing" }, { status: "error", message: "failed" }, dashboardReady]) {
    const response = await f.post("/api/usage/dashboard", { ...dashboardInput, refresh: true })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: expected })
  }
  expect(received).toEqual([{ ...dashboardInput, refresh: true }, { ...dashboardInput, refresh: true }, { ...dashboardInput, refresh: true }])
})

test("passes only the requested dashboard slots to the runtime and returns only those slots", async () => {
  const received: DashboardInput[] = []
  const { daily: _daily, monthly: _monthly, breakdown: _breakdown, ...base } = dashboardReady
  await using f = fixture(
    unusedSession,
    reading((_location, input) =>
      Effect.sync(() => {
        received.push(input)
        return {
          ...base,
          ...(input.daily === undefined ? {} : { daily: dashboardReady.daily }),
          ...(input.monthly === undefined ? {} : { monthly: dashboardReady.monthly }),
          ...(input.breakdown === undefined ? {} : { breakdown: dashboardReady.breakdown }),
        }
      }),
    ),
  )

  const none = await f.post("/api/usage/dashboard", {})
  expect(none.status).toBe(200)
  expect(await none.json()).toEqual({ data: base })
  const single = await f.post("/api/usage/dashboard", { breakdown: dashboardInput.breakdown })
  expect(await single.json()).toEqual({ data: { ...base, breakdown: dashboardReady.breakdown } })
  const pair = await f.post("/api/usage/dashboard", { daily: dashboardInput.daily, monthly: dashboardInput.monthly, refresh: true })
  expect(await pair.json()).toEqual({ data: { ...base, daily: dashboardReady.daily, monthly: dashboardReady.monthly } })
  expect(received).toEqual([{}, { breakdown: dashboardInput.breakdown }, { daily: dashboardInput.daily, monthly: dashboardInput.monthly, refresh: true }])
})

test("rejects an invalid dashboard payload or time zone before the runtime read", async () => {
  const calls = { value: 0 }
  await using f = fixture(unusedSession, reading(() => Effect.sync(() => { calls.value++; return { status: "preparing" } as const })))

  for (const body of [
    [],
    { daily: "day" },
    { ...dashboardInput, refresh: "yes" },
    { ...dashboardInput, daily: { group: "day", from: 10, to: 10 } },
    { ...dashboardInput, monthly: { group: "month", limit: 201 } },
    { ...dashboardInput, breakdown: { group: "secret" } },
  ]) expect((await f.post("/api/usage/dashboard", body)).status).toBe(400)
  for (const field of ["daily", "monthly", "breakdown"] as const) {
    const response = await f.post("/api/usage/dashboard", { ...dashboardInput, [field]: { ...dashboardInput[field], timeZone: "Mars/Olympus_Mons" } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ field: `${field}.timeZone` })
  }
  expect(calls.value).toBe(0)
})

test("reads the dashboard for each request's own Location", async () => {
  const locations: { directory: string; workspaceID: string | undefined }[] = []
  await using f = fixture(
    unusedSession,
    reading((location) =>
      Effect.sync(() => {
        locations.push({ directory: location.directory, workspaceID: location.workspaceID })
        return { ...dashboardReady, revision: `rev:${location.directory}` }
      }),
    ),
  )
  const post = (headers: Record<string, string>) => f.postWith("/api/usage/dashboard", dashboardInput, headers)

  const first = await post({ "x-ycoding-directory": encodeURIComponent("/work/alpha") })
  const second = await post({ "x-ycoding-directory": encodeURIComponent("/work/beta"), "x-ycoding-workspace": "wrk_beta" })
  const fallback = await post({})
  expect(await first.json()).toMatchObject({ data: { revision: "rev:/work/alpha" } })
  expect(await second.json()).toMatchObject({ data: { revision: "rev:/work/beta" } })
  expect(await fallback.json()).toMatchObject({ data: { revision: `rev:${process.cwd()}` } })
  expect(locations).toEqual([
    { directory: "/work/alpha", workspaceID: undefined },
    { directory: "/work/beta", workspaceID: "wrk_beta" },
    { directory: process.cwd(), workspaceID: undefined },
  ])
})

test("answers prepared accounting without waiting for the request's Location to boot, then serves its quota", async () => {
  const gate = Effect.runSync(Deferred.make<void>())
  const booted: string[] = []
  const quota = { status: "ready", providers: [], forecast: { asOf: 4, localScope: "backend" } } as const
  const views = Layer.mock(UsageViews.Service, {
    read: () =>
      Effect.succeed({
        status: "ready" as const,
        revision: "r1",
        publishedAt: 5,
        summary: metrics,
        reports: [dashboardReady.breakdown],
      }),
  })
  const boot = (ref: Location.Ref) =>
    Layer.effect(
      UsageDashboardRuntime.Service,
      Deferred.await(gate).pipe(
        Effect.andThen(Effect.sync(() => booted.push(ref.directory))),
        Effect.as({ quota: () => Effect.succeed(quota) }),
      ),
    )
  const locations = Layer.effect(
    LocationServiceMap.Service,
    fixedLocations(boot),
  )
  const live = {
    asOf: 6,
    active: 1,
    streaming: 1,
    outputTokensPerSecond: 12.5,
    models: [],
    history: [{ at: 6, active: 1, outputTokensPerSecond: 12.5 }],
  }
  const activity = Layer.mock(GenerationActivity.Service, { snapshot: () => Effect.succeed(live) })
  await using f = fixture(
    unusedSession,
    UsageDashboardRead.layer.pipe(Layer.provide(Layer.mergeAll(views, locations, activity))),
  )
  const post = () =>
    f.postWith("/api/usage/dashboard", { breakdown: dashboardInput.breakdown }, { "x-ycoding-directory": encodeURIComponent("/work/cold") })

  const first = await Promise.race([post(), Bun.sleep(2_000).then(() => undefined)])
  expect(first?.status).toBe(200)
  expect(await first!.json()).toEqual({
    data: { status: "ready", asOf: 5, revision: "r1", summary: metrics, quota: { status: "preparing" }, live, breakdown: dashboardReady.breakdown },
  })
  expect(booted).toEqual([])
  Effect.runSync(Deferred.succeed(gate, undefined))
  const served = { data: { status: "ready", asOf: 5, revision: "r1", summary: metrics, quota, live, breakdown: dashboardReady.breakdown } }
  let later: unknown
  for (let attempt = 0; attempt < 100 && !Bun.deepEquals(later, served); attempt++) {
    if (attempt > 0) await Bun.sleep(10)
    later = await (await post()).json()
  }
  expect(later).toEqual(served)
  expect(booted).toEqual(["/work/cold"])
})

test("keeps backend-wide usage reads and invalid dashboard input from reading the dashboard", async () => {
  let reads = 0
  await using f = fixture(
    { usageAll: () => Effect.succeed(metrics), usageReportAll: () => Effect.succeed({ group: "day", rows: [], total: metrics, rowCount: 0 }) },
    reading(() =>
      Effect.sync(() => {
        reads++
        return { status: "preparing" } as const
      }),
    ),
  )

  expect((await f.request("/api/usage")).status).toBe(200)
  expect((await f.request("/api/usage/report?group=day")).status).toBe(200)
  expect((await f.post("/api/usage/dashboard", { ...dashboardInput, daily: { group: "day", timeZone: "Mars/Olympus_Mons" } })).status).toBe(400)
  expect(reads).toBe(0)
})
