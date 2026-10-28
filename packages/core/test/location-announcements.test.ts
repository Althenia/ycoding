import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Logger } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Catalog } from "../src/catalog"
import { Command } from "../src/command"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { httpClient } from "../src/effect/app-node-platform"
import { EventRuntime } from "../src/event"
import { LocationAnnouncements } from "../src/location-announcements"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import { MCP } from "../src/mcp/index"
import { CatalogModel } from "../src/model"
import { ModelsDev } from "../src/models-dev"
import { CatalogContributions } from "../src/plugin/catalog-contributions"
import { PluginSupervisor } from "../src/plugin/supervisor"
import { Provider } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { testEffect } from "./lib/effect"

const pricedModels = [
  ModelsDev.node,
  ModelsDev.configured({ file: path.join(import.meta.dir, "plugin/fixtures/models-dev-priced.json"), fetch: false }),
] as const
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, ModelsDev.node, LocationServiceMap.node]), [
    pricedModels,
  ]),
)

const museRow = {
  id: "muse-wonder-1.0",
  object: "model",
  created: 1_788_307_200,
  owned_by: "meta",
  metadata: {
    "muse-code": {
      name: "Muse Wonder",
      is_hidden: false,
      tool_call: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 1_000_000, output: 128_000 },
    },
  },
}
let museArrival: Promise<void> = Promise.resolve()
const accountHttp = HttpClient.make((request) =>
  Effect.promise(async () => {
    if (!new URL(request.url).pathname.endsWith("/muse-code/models"))
      return HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 }))
    await museArrival
    return HttpClientResponse.fromWeb(request, Response.json({ data: [museRow] }))
  }),
)
const withAccounts = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, ModelsDev.node, LocationServiceMap.node]), [
    pricedModels,
    [httpClient, Layer.succeed(HttpClient.HttpClient, accountHttp)],
  ]),
)
const museModel = (catalog: Catalog.Interface) =>
  catalog.model.get(Provider.ID.make("muse"), CatalogModel.ID.make(museRow.id))
const awaitMuseModel = (catalog: Catalog.Interface) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (yield* museModel(catalog)) return
      yield* Effect.sleep("100 millis")
    }
    yield* Effect.die(new Error("Muse account models never arrived"))
  })
const withMuseKey = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      process.env.META_API_KEY = "synthetic-meta-key"
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        delete process.env.META_API_KEY
        museArrival = Promise.resolve()
      }),
  )

const promptServer = (gate: string) => ({
  mcp: {
    servers: {
      prompter: {
        type: "local",
        command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-prompts.ts")],
        environment: { MCP_PROMPTS_GATE: gate },
      },
    },
  },
})
const awaitPrompts = (mcp: MCP.Interface) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((yield* mcp.prompts()).length > 0) return
      yield* Effect.sleep("50 millis")
    }
    yield* Effect.die(new Error("MCP prompts never arrived"))
  })

const created: string[] = []
afterAll(() => created.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })))
const fresh = (config?: unknown) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ycoding-announce-")))
  created.push(directory)
  if (config !== undefined) fs.writeFileSync(path.join(directory, "ycoding.json"), JSON.stringify(config))
  return directory
}
const refOf = (directory: string) => Location.Ref.make({ directory: AbsolutePath.make(directory) })
const announcement = (type: string) => type.endsWith(".updated") || type.startsWith("plugin.")
const settle = Effect.sleep("1500 millis")

const announcements = (directory: string) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const seen: string[] = []
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        if (event.location?.directory === directory && announcement(event.type)) seen.push(event.type)
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return seen
  })

const discoveryServer = (status: number) => {
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      if (status !== 200) return new Response("unavailable", { status })
      return Response.json({ object: "list", data: [{ id: "discovered" }] })
    },
  })
  return { requests, server }
}
const discoveryConfig = (port: number) => ({
  providers: {
    "shared-discovery": {
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "synthetic-key" },
      catalog: { source: "openai-models" },
    },
  },
})

describe("Location announcements", () => {
  it.live("publishes no update events while the catalog slice is first built", () =>
    Effect.gen(function* () {
      const directory = fresh()
      const seen = yield* announcements(directory)
      const locations = yield* LocationServiceMap.Service
      yield* Effect.scoped(locations.contextEffect(refOf(directory), CatalogContributions.nodes))
      yield* settle
      expect(seen).toEqual([])
      yield* locations.invalidate(refOf(directory))
    }),
  )

  it.live("publishes no update events while the full graph is first built or released", () =>
    Effect.gen(function* () {
      const directory = fresh()
      const seen = yield* announcements(directory)
      const locations = yield* LocationServiceMap.Service
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* locations.contextEffect(refOf(directory), [LocationServiceMap.full])
          const supervisor = yield* PluginSupervisor.Service.pipe(Effect.provide(context))
          yield* supervisor.flush
        }),
      )
      yield* settle
      expect(seen).toEqual([])
      yield* locations.invalidate(refOf(directory))
      yield* settle
      expect(seen).toEqual([])
      expect((yield* locations.loaded()).some((entry) => entry.ref.directory === directory)).toBe(false)
    }),
  )

  it.live("publishes configuration and catalog updates for a change after the first build", () =>
    Effect.gen(function* () {
      const directory = fresh({ providers: { first: { models: { one: {} } } } })
      const seen = yield* announcements(directory)
      const events = yield* EventRuntime.Service
      const updated = yield* Deferred.make<void>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === Catalog.Event.Updated.type && event.location?.directory === directory
          ? Deferred.succeed(updated, undefined).pipe(Effect.asVoid)
          : Effect.void,
      )
      const locations = yield* LocationServiceMap.Service
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* locations.contextEffect(refOf(directory), [Config.node, ...CatalogContributions.nodes])
          expect(seen).toEqual([])
          fs.writeFileSync(
            path.join(directory, "ycoding.json"),
            JSON.stringify({ providers: { first: { models: { one: {} } }, second: { models: { two: {} } } } }),
          )
          const config = yield* Config.Service.pipe(Effect.provide(context))
          yield* config.reload()
          yield* Deferred.await(updated).pipe(Effect.timeout("10 seconds"))
          const catalog = yield* Catalog.Service.pipe(Effect.provide(context))
          expect(yield* catalog.model.get(Provider.ID.make("second"), CatalogModel.ID.make("two"))).toBeDefined()
        }),
      )
      yield* unsubscribe
      expect(seen).toContain("config.updated")
      expect(seen).toContain(Catalog.Event.Updated.type)
      yield* locations.invalidate(refOf(directory))
    }),
  )

  it.live("discovers models once for Locations that share one provider configuration", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => discoveryServer(200)),
      ({ requests, server }) =>
        Effect.gen(function* () {
          const locations = yield* LocationServiceMap.Service
          const directories = Array.from({ length: 3 }, () => fresh(discoveryConfig(server.port!)))
          for (const directory of directories) {
            const catalog = yield* Effect.scoped(
              locations
                .contextEffect(refOf(directory), CatalogContributions.nodes)
                .pipe(Effect.flatMap((context) => Catalog.Service.pipe(Effect.provide(context)))),
            )
            expect(
              yield* catalog.model.get(Provider.ID.make("shared-discovery"), CatalogModel.ID.make("discovered")),
            ).toBeDefined()
          }
          expect(requests).toEqual(["/v1/models"])
          yield* Effect.forEach(directories, (directory) => locations.invalidate(refOf(directory)), { discard: true })
        }),
      ({ server }) => Effect.sync(() => server.stop(true)),
    ),
  )

  it.live("logs a failed shared discovery once for every Location that shares it", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => discoveryServer(503)),
      ({ requests, server }) => {
        const warnings: unknown[] = []
        const logger = Logger.layer(
          [
            Logger.make((options) => {
              const message = options.message
              const text = Array.isArray(message) ? message[0] : message
              if (text === "OpenAI model discovery failed") warnings.push(text)
            }),
          ],
          { mergeWithExisting: false },
        )
        return Effect.gen(function* () {
          const locations = yield* LocationServiceMap.Service
          const directories = Array.from({ length: 3 }, () => fresh(discoveryConfig(server.port!)))
          for (const directory of directories) {
            const catalog = yield* Effect.scoped(
              locations
                .contextEffect(refOf(directory), CatalogContributions.nodes)
                .pipe(Effect.flatMap((context) => Catalog.Service.pipe(Effect.provide(context)))),
            )
            expect(
              yield* catalog.model.get(Provider.ID.make("shared-discovery"), CatalogModel.ID.make("discovered")),
            ).toBeUndefined()
          }
          expect(requests).toEqual(["/v1/models"])
          expect(warnings).toHaveLength(1)
          yield* Effect.forEach(directories, (directory) => locations.invalidate(refOf(directory)), { discard: true })
        }).pipe(Effect.provide(logger))
      },
      ({ server }) => Effect.sync(() => server.stop(true)),
    ),
  )

  withAccounts.live("publishes nothing when account models arrive after the first build of an unread Location", () =>
    withMuseKey(
      Effect.gen(function* () {
        const directory = fresh()
        const seen = yield* announcements(directory)
        const locations = yield* LocationServiceMap.Service
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* locations.contextEffect(refOf(directory), CatalogContributions.nodes)
            const catalog = yield* Catalog.Service.pipe(Effect.provide(context))
            yield* awaitMuseModel(catalog)
          }),
        )
        yield* settle
        expect(seen).toEqual([])
        yield* locations.invalidate(refOf(directory))
      }),
    ),
  )

  withAccounts.live("publishes one catalog update when account models arrive after a client read the catalog", () =>
    withMuseKey(
      Effect.gen(function* () {
        let arrive!: () => void
        museArrival = new Promise((resolve) => (arrive = resolve))
        const directory = fresh()
        const seen = yield* announcements(directory)
        const locations = yield* LocationServiceMap.Service
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* locations.contextEffect(refOf(directory), CatalogContributions.nodes)
            const catalog = yield* Catalog.Service.pipe(Effect.provide(context))
            yield* LocationAnnouncements.read("catalog").pipe(Effect.provide(context))
            expect(yield* museModel(catalog)).toBeUndefined()
            arrive()
            yield* awaitMuseModel(catalog)
          }),
        )
        yield* settle
        expect(seen).toEqual([Catalog.Event.Updated.type])
        yield* locations.invalidate(refOf(directory))
      }),
    ),
  )

  it.live("publishes nothing when MCP prompts arrive after the first build of an unread Location", () =>
    Effect.gen(function* () {
      const gate = path.join(fresh(), "open")
      fs.writeFileSync(gate, "")
      const directory = fresh(promptServer(gate))
      yield* settle
      const seen = yield* announcements(directory)
      const locations = yield* LocationServiceMap.Service
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* locations.contextEffect(refOf(directory), [MCP.node, Command.node])
          yield* awaitPrompts(yield* MCP.Service.pipe(Effect.provide(context)))
        }),
      )
      yield* settle
      expect(seen).toEqual([])
      yield* locations.invalidate(refOf(directory))
    }),
  )

  it.live("publishes one command update when MCP prompts arrive after a client read the commands", () =>
    Effect.gen(function* () {
      const gate = path.join(fresh(), "open")
      const directory = fresh(promptServer(gate))
      yield* settle
      const seen = yield* announcements(directory)
      const locations = yield* LocationServiceMap.Service
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* locations.contextEffect(refOf(directory), [MCP.node, Command.node])
          const mcp = yield* MCP.Service.pipe(Effect.provide(context))
          yield* LocationAnnouncements.read("command").pipe(Effect.provide(context))
          expect(yield* mcp.prompts()).toEqual([])
          fs.writeFileSync(gate, "")
          yield* awaitPrompts(mcp)
        }),
      )
      yield* settle
      expect(seen).toEqual([Command.Event.Updated.type])
      yield* locations.invalidate(refOf(directory))
    }),
  )
})
