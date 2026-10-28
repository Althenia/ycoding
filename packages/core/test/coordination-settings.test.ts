import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import { ModelsDev } from "../src/models-dev"
import { CatalogContributions } from "../src/plugin/catalog-contributions"
import { CoordinationSettings } from "../src/coordination-settings"
import { AbsolutePath } from "../src/schema"

test("user policy ignores project overrides and rereads central revocation and malformed configuration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-coordination-policy-"))
  const global = path.join(directory, "global")
  const project = path.join(directory, "project")
  await Promise.all([mkdir(global), mkdir(project)])
  await writeFile(path.join(project, "ycoding.json"), JSON.stringify({ coordination: { delegated_decisions: { enabled: false } } }))
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const settings = yield* CoordinationSettings.Service
      expect((yield* settings.read()).enabled).toBe(true)
      yield* Effect.promise(() => writeFile(path.join(global, "ycoding.json"), JSON.stringify({ coordination: { delegated_decisions: { enabled: false } } })))
      expect((yield* settings.read()).enabled).toBe(false)
      yield* Effect.promise(() => writeFile(path.join(global, "ycoding.jsonc"), JSON.stringify({ coordination: { delegated_decisions: { categories: ["question"] } } })))
      expect(yield* settings.read()).toMatchObject({ enabled: false, categories: ["question"] })
      yield* Effect.promise(() => writeFile(path.join(project, "ycoding.json"), JSON.stringify({ coordination: { delegated_decisions: { enabled: true } } })))
      expect((yield* settings.read()).enabled).toBe(false)
      yield* Effect.promise(() => writeFile(path.join(global, "ycoding.json"), JSON.stringify({ coordination: { delegated_decisions: { enabled: "yes" } } })))
      expect((yield* settings.read()).enabled).toBe(false)
      yield* Effect.promise(() => writeFile(path.join(global, "ycoding.json"), "{"))
      expect((yield* settings.read()).enabled).toBe(false)
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([CoordinationSettings.node]), [
      [Global.node, Global.layerWith({ home: directory, config: global, data: path.join(directory, "data") })],
      [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))],
    ])), Effect.scoped))
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30_000)

test("reading settings publishes no configuration update and leaves shared model discovery alone", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-coordination-announce-"))
  const global = path.join(directory, "global")
  await mkdir(global)
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      return new Response("unavailable", { status: 503 })
    },
  })
  const providers = {
    local: {
      package: "@ycoding-ai/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "synthetic-key" },
      catalog: { source: "openai-models" },
    },
  }
  await writeFile(path.join(global, "ycoding.json"), JSON.stringify({ providers }))
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const settings = yield* CoordinationSettings.Service
      const events = yield* EventRuntime.Service
      const locations = yield* LocationServiceMap.Service
      yield* locations.contextEffect(Location.Ref.make({ directory: AbsolutePath.make(global) }), CatalogContributions.nodes)
      yield* settings.read()
      yield* Effect.sleep("1500 millis")
      expect(requests).toEqual(["/v1/models"])
      const updates: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === "config.updated") updates.push(event.location?.directory ?? "")
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      for (let index = 0; index < 3; index++) expect((yield* settings.read()).enabled).toBe(true)
      yield* Effect.sleep("1500 millis")
      expect(updates).toEqual([])
      expect(requests).toEqual(["/v1/models"])
      yield* Effect.promise(() =>
        writeFile(path.join(global, "ycoding.json"), JSON.stringify({ providers, coordination: { delegated_decisions: { enabled: false } } })),
      )
      expect((yield* settings.read()).enabled).toBe(false)
      expect(updates).toContain(global)
    }).pipe(Effect.provide(AppNodeBuilder.build(
      LayerNode.group([CoordinationSettings.node, Database.node, EventRuntime.node, ModelsDev.node, LocationServiceMap.node]),
      [
        [Global.node, Global.layerWith({ home: directory, config: global, data: path.join(directory, "data") })],
        [ModelsDev.node, ModelsDev.configured({ file: path.join(import.meta.dir, "plugin/fixtures/models-dev-priced.json"), fetch: false })],
      ],
    )), Effect.scoped))
  } finally {
    await server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
