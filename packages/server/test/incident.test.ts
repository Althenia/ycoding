import { expect, test } from "bun:test"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCapabilities } from "@ycoding-ai/core/config/capabilities"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { ModelIncident } from "@ycoding-ai/core/model-incident/index"
import { ModelGuidanceInstructions } from "@ycoding-ai/core/model-incident/instructions"
import { RetentionSettings } from "@ycoding-ai/core/retention-settings"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { sql } from "drizzle-orm"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { IncidentHandler } from "../src/handlers/incident"
import { LocationMiddleware, requestRef, type LocationServices } from "../src/location"

const rule = "standard.review.force-push"

const configFor = (capabilities: ConfigCapabilities.Info | undefined) =>
  Config.Service.of({
    entries: () =>
      Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({ capabilities }) })]),
    diagnostics: () => Effect.succeed([]),
    reload: () => Effect.void,
  })

const enabled = configFor(undefined)
const locations: Readonly<Record<string, Config.Interface>> = {
  "/enabled": enabled,
  "/denied": configFor(new ConfigCapabilities.Info({ builtin_instructions: { deny: ["model-guidance"] } })),
  "/disabled": configFor(new ConfigCapabilities.Info({ builtin_instructions: { enabled: false } })),
  "/allow-other": configFor(new ConfigCapabilities.Info({ builtin_instructions: { allow: ["date"] } })),
}

async function harness() {
  const scope = await Effect.runPromise(Scope.make())
  const services = await Effect.runPromise(
    Layer.buildWithScope(
      AppNodeBuilder.build(LayerNode.group([Database.node, ModelIncident.node]), [
        [
          RetentionSettings.node,
          Layer.succeed(RetentionSettings.Service, {
            read: () => Effect.succeed({ recordsDays: 7, usageDays: 30, latencyDays: 30, incidentDays: 30 }),
          }),
        ],
      ]),
      scope,
    ),
  )
  const resolved: string[] = []
  const locationMiddleware = Layer.succeed(LocationMiddleware, (effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const directory = requestRef(request).directory
      resolved.push(directory)
      return yield* Effect.provide(
        effect,
        Context.makeUnsafe<LocationServices>(Context.make(Config.Service, locations[directory] ?? enabled).mapUnsafe),
      )
    }),
  )
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.incident"])).pipe(
      Layer.provide(IncidentHandler),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeedContext(services),
          locationMiddleware,
          Layer.succeed(Authorization, (effect) => effect),
          Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
    ),
  )
  const put = (row: {
    id: string
    time: number
    kind?: string
    model?: string
    agent?: string
    request?: string
    rules?: ReadonlyArray<string>
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.run(sql`
          INSERT INTO model_incident
            (id, time_created, kind, provider_id, model_id, agent, project_id, session_id, request_id, category, rule_ids)
          VALUES (${row.id}, ${row.time}, ${row.kind ?? "guardrail-escalated"}, 'p', ${row.model ?? "m"}, ${row.agent ?? "build"},
            'global', 'ses_gone', ${row.request ?? null}, 'ordinary', ${JSON.stringify(row.rules ?? [])})
        `)
      }).pipe(Effect.provide(services)),
    )
  return {
    resolved,
    put,
    request: (path: string, init?: RequestInit) => handler.handler(new Request(`http://localhost${path}`, init)),
    json: async (path: string, init?: RequestInit) => (await handler.handler(new Request(`http://localhost${path}`, init))).json(),
    [Symbol.asyncDispose]: async () => {
      await handler.dispose()
      await Effect.runPromise(Scope.close(scope, Exit.void))
    },
  }
}

const seedGuidance = async (http: Awaited<ReturnType<typeof harness>>, model = "m") => {
  const time = Date.now() - 1_000
  await http.put({ id: `inc_${model}_1`, time, model, request: "req_1", rules: [rule] })
  await http.put({ id: `inc_${model}_2`, time, model, request: "req_2", rules: [rule] })
}
const guidanceText = ModelGuidanceInstructions.render([
  { requestID: "req_1", ruleIDs: [rule] },
  { requestID: "req_2", ruleIDs: [rule] },
])

test("serves the report with grouping, ranges and paging from the global record", async () => {
  await using http = await harness()
  await http.put({ id: "inc_01", time: 100, kind: "fallback", agent: "build" })
  await http.put({ id: "inc_02", time: 200, kind: "guardrail-escalated", agent: "build" })
  await http.put({ id: "inc_03", time: 300, kind: "guardrail-rejected", agent: "plan" })
  await http.put({ id: "inc_04", time: 400, kind: "fallback", agent: "plan", model: "other" })

  const byModel = await http.request("/api/incident/report?group=model")
  expect(byModel.status).toBe(200)
  const modelRows = [
    { providerID: "p", modelID: "m", fallbacks: 1, escalated: 1, rejected: 1, last: 300 },
    { providerID: "p", modelID: "other", fallbacks: 1, escalated: 0, rejected: 0, last: 400 },
  ]
  expect(await byModel.json()).toEqual({ data: { groups: 2, rows: modelRows } })

  const byAgent = await http.json("/api/incident/report?group=agent")
  expect(byAgent.data.groups).toBe(3)
  expect(byAgent.data.rows.map((row: { agent: string }) => row.agent).toSorted()).toEqual(["build", "plan", "plan"])

  expect((await http.json("/api/incident/report?group=model&from=200&to=400")).data).toEqual({
    groups: 1,
    rows: [{ providerID: "p", modelID: "m", fallbacks: 0, escalated: 1, rejected: 1, last: 300 }],
  })
  const first = await http.json("/api/incident/report?group=model&limit=1")
  const second = await http.json("/api/incident/report?group=model&limit=1&offset=1")
  expect([first.data.groups, second.data.groups]).toEqual([2, 2])
  expect([...first.data.rows, ...second.data.rows]).toEqual(modelRows)
  expect((await http.json("/api/incident/report?group=model&offset=2")).data).toEqual({ groups: 2, rows: [] })
})

test("rejects report and recent queries outside the contract", async () => {
  await using http = await harness()
  for (const path of [
    "/api/incident/report?group=model&limit=201",
    "/api/incident/report?group=model&limit=0",
    "/api/incident/report?group=model&offset=-1",
    "/api/incident/report?group=session",
    "/api/incident/report",
    "/api/incident/recent?provider=p&model=m&limit=51",
    "/api/incident/recent?provider=p",
  ])
    expect((await http.request(path)).status).toBe(400)
  const reversed = await http.request("/api/incident/report?group=model&from=5&to=4")
  expect(reversed.status).toBe(400)
  expect(await reversed.json()).toMatchObject({ _tag: "InvalidRequestError" })
  expect((await http.request("/api/incident/report?group=model&limit=200")).status).toBe(200)
  expect((await http.request("/api/incident/recent?provider=p&model=m&limit=50")).status).toBe(200)
})

test("lists recent incidents newest first, filtered by model and agent, within the page cap", async () => {
  await using http = await harness()
  await http.put({ id: "inc_a", time: 100, kind: "fallback", agent: "build" })
  await http.put({ id: "inc_b", time: 200, kind: "guardrail-rejected", agent: "plan", rules: [rule] })
  await http.put({ id: "inc_c", time: 300, agent: "build" })
  await http.put({ id: "inc_d", time: 400, model: "other" })

  const ids = (body: { data: { items: ReadonlyArray<{ id: string }> } }) => body.data.items.map((item) => item.id)
  const all = await http.json("/api/incident/recent?provider=p&model=m")
  expect(ids(all)).toEqual(["inc_c", "inc_b", "inc_a"])
  expect(all.data.items[1]).toEqual({
    id: "inc_b",
    time: 200,
    kind: "guardrail-rejected",
    category: "ordinary",
    ruleIDs: [rule],
    agent: "plan",
  })
  expect(ids(await http.json("/api/incident/recent?provider=p&model=m&agent=plan"))).toEqual(["inc_b"])
  expect(ids(await http.json("/api/incident/recent?provider=p&model=m&limit=2"))).toEqual(["inc_c", "inc_b"])
})

test("report and recent read the global record without resolving any Location", async () => {
  await using http = await harness()
  await http.put({ id: "inc_a", time: 100, kind: "fallback" })
  expect((await http.request("/api/incident/report?group=model&location[directory]=/gone")).status).toBe(200)
  expect(
    (await http.request("/api/incident/recent?provider=p&model=m", { headers: { "x-ycoding-directory": "/gone" } }))
      .status,
  ).toBe(200)
  expect(http.resolved).toEqual([])
})

test("guidance reports the stored note with the capability of the requesting Location", async () => {
  await using http = await harness()
  await seedGuidance(http)
  const read = (directory: string) => http.json(`/api/incident/guidance?provider=p&model=m&location[directory]=${directory}`)
  expect(await read("/enabled")).toEqual({ data: { enabled: true, text: guidanceText } })
  for (const directory of ["/denied", "/disabled", "/allow-other"])
    expect(await read(directory)).toEqual({ data: { enabled: false, text: guidanceText } })
  expect(await http.json("/api/incident/guidance?provider=p&model=unknown&location[directory]=/enabled")).toEqual({
    data: { enabled: true },
  })
  expect(http.resolved).toEqual(["/enabled", "/denied", "/disabled", "/allow-other", "/enabled"])
  expect((await http.request("/api/incident/guidance?provider=p")).status).toBe(400)
})

test("clearing guidance moves only that model's watermark, keeps incidents and reports the Location capability", async () => {
  await using http = await harness()
  await seedGuidance(http)
  await seedGuidance(http, "other")
  const reportBefore = await http.json("/api/incident/report?group=model")
  const recentBefore = await http.json("/api/incident/recent?provider=p&model=m")

  const before = Date.now()
  const cleared = await http.request("/api/incident/guidance?provider=p&model=m&location[directory]=/denied", {
    method: "DELETE",
  })
  expect(cleared.status).toBe(200)
  const body = await cleared.json()
  expect(body.data.enabled).toBe(false)
  expect(body.data.text).toBeUndefined()
  expect(body.data.clearedAt).toBeGreaterThanOrEqual(before)
  expect(body.data.clearedAt).toBeLessThanOrEqual(Date.now())

  expect(await http.json("/api/incident/report?group=model")).toEqual(reportBefore)
  expect(await http.json("/api/incident/recent?provider=p&model=m")).toEqual(recentBefore)
  expect(await http.json("/api/incident/guidance?provider=p&model=m&location[directory]=/enabled")).toEqual({
    data: { enabled: true, clearedAt: body.data.clearedAt },
  })
  expect((await http.json("/api/incident/guidance?provider=p&model=other&location[directory]=/enabled")).data).toEqual({
    enabled: true,
    text: guidanceText,
  })

  const again = await http.json("/api/incident/guidance?provider=p&model=m&location[directory]=/enabled", {
    method: "DELETE",
  })
  expect(again.data.enabled).toBe(true)
  expect(again.data.clearedAt).toBeGreaterThanOrEqual(body.data.clearedAt)
  expect((await http.request("/api/incident/guidance?provider=p", { method: "DELETE" })).status).toBe(400)
})
