import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, describe, expect } from "bun:test"
import { Deferred, Effect, Logger } from "effect"
import { Catalog } from "../src/catalog"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
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
})
