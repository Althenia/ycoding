import fs from "fs/promises"
import { mkdtempSync } from "fs"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { describe, expect } from "bun:test"
import { Plugin as EffectPlugin } from "@ycoding-ai/plugin/effect"
import { Config as ConfigSchema } from "@ycoding-ai/schema/config"
import { Plugin } from "@ycoding-ai/schema/plugin"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Catalog } from "@ycoding-ai/core/catalog"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-services"
import { PluginV2 } from "@ycoding-ai/core/plugin"
import { SdkPlugins } from "@ycoding-ai/core/plugin/sdk"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Cause, Effect, Logger } from "effect"
import { Database } from "../../src/database/database"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// Isolate global config discovery from the developer's real ~/.config/ycoding so plugin
// auto-discovery (PluginSupervisor.scan) never picks up unrelated real plugin files.
const globalDirectory = mkdtempSync(path.join(os.tmpdir(), "ycoding-plugin-test-global-"))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SdkPlugins.node, LocationServiceMap.node]), [
    [Global.node, Global.layerWith({ config: globalDirectory, home: path.join(globalDirectory, "home") })],
  ]),
)

describe("PluginSupervisor config", () => {
  it.live("applies selectors in order", () =>
    withLocation(
      { plugins: ["-ycoding.provider.*", "ycoding.provider.openai"] },
      Effect.gen(function* () {
        const plugins = yield* PluginV2.Service
        yield* ready()
        expect(
          (yield* plugins.list()).map((plugin) => plugin.id).filter((id) => id.startsWith("ycoding.provider.")),
        ).toEqual([Plugin.ID.make("ycoding.provider.openai")])
      }),
    ),
  )

  it.live("loads configured Promise plugins with options", () =>
    withLocation(
      {
        plugins: [
          "-*",
          {
            package: path.join(import.meta.dir, "../plugin/fixtures/config-promise-plugin.ts"),
            options: { description: "Loaded from config" },
          },
        ],
      },
      Effect.gen(function* () {
        yield* ready()
        const agents = yield* AgentV2.Service
        expect(yield* agents.get(AgentV2.ID.make("configured"))).toMatchObject({
          description: "Loaded from config",
          mode: "subagent",
        })
      }),
    ),
  )

  it.live("disables configured plugins by exported ID", () => {
    const plugin = path.join(import.meta.dir, "../plugin/fixtures/config-promise-plugin.ts")
    return withLocation(
      { plugins: [plugin, "-config-promise-plugin"] },
      Effect.gen(function* () {
        yield* ready()
        const plugins = yield* PluginV2.Service
        const agents = yield* AgentV2.Service
        expect((yield* plugins.list()).map((item) => String(item.id))).not.toContain("config-promise-plugin")
        expect(yield* agents.get(AgentV2.ID.make("configured"))).toBeUndefined()
      }),
    )
  })

  it.live("does not disable configured plugins by package target", () => {
    const plugin = path.join(import.meta.dir, "../plugin/fixtures/config-promise-plugin.ts")
    return withLocation(
      { plugins: [plugin, `-${plugin}`] },
      Effect.gen(function* () {
        yield* ready()
        const plugins = yield* PluginV2.Service
        expect((yield* plugins.list()).map((item) => String(item.id))).toContain("config-promise-plugin")
      }),
    )
  })

  it.live("loads configured Effect plugins with options", () =>
    withLocation(
      {
        plugins: [
          "-*",
          {
            package: path.join(import.meta.dir, "../plugin/fixtures/config-effect-plugin.ts"),
            options: { description: "Effect plugin from config" },
          },
        ],
      },
      Effect.gen(function* () {
        yield* ready()
        const agents = yield* AgentV2.Service
        expect(yield* agents.get(AgentV2.ID.make("effect-configured"))).toMatchObject({
          description: "Effect plugin from config",
          mode: "subagent",
        })
      }),
    ),
  )

  it.live("logs concise invalid plugin diagnostics and continues loading", () => {
    const output: string[] = []
    const diagnostics: string[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (!Array.isArray(entry.message) || entry.message[0] !== "failed to load plugin") return
      const details = entry.message[1]
      if (typeof details !== "object" || details === null || !("target" in details)) return
      if (typeof details.target === "string") output.push(details.target)
      if ("cause" in details) diagnostics.push(Cause.pretty(details.cause as Cause.Cause<unknown>))
    })
    return withLocation(
      {
        plugins: [
          "-*",
          path.join(import.meta.dir, "../plugin/fixtures/missing-plugin.ts"),
          path.join(import.meta.dir, "../plugin/fixtures/invalid-plugin.ts"),
          {
            package: path.join(import.meta.dir, "../plugin/fixtures/config-promise-plugin.ts"),
            options: { description: "Loaded after invalid plugins" },
          },
        ],
      },
      Effect.gen(function* () {
        yield* ready()
        const agents = yield* AgentV2.Service
        expect(yield* agents.get(AgentV2.ID.make("configured"))).toMatchObject({
          description: "Loaded after invalid plugins",
        })
        expect(output).toEqual([
          path.join(import.meta.dir, "../plugin/fixtures/missing-plugin.ts"),
          path.join(import.meta.dir, "../plugin/fixtures/invalid-plugin.ts"),
        ])
        expect(diagnostics.some((message) => message.includes("does not implement the V2 contract"))).toBe(true)
        expect(diagnostics.join("\n")).not.toContain("Expected readonly")
      }),
    ).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.live("loads identical configured plugin targets once", () => {
    const plugin = path.join(import.meta.dir, "../plugin/fixtures/config-promise-plugin.ts")
    let loads = 0
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      const text = JSON.stringify(entry.message)
      if (text.includes("loading plugin") && text.includes(plugin)) loads++
    })
    return withLocation(
      { plugins: ["-*", plugin, plugin] },
      Effect.gen(function* () {
        yield* ready()
        expect(loads).toBe(1)
      }),
    ).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.live("loads auto-discovered plugin files", () =>
    withLocation(
      undefined,
      Effect.gen(function* () {
        yield* ready()
        const agents = yield* AgentV2.Service
        expect(yield* agents.get(AgentV2.ID.make("directory"))).toMatchObject({
          description: "Loaded from plugin directory",
        })
      }),
      true,
    ),
  )

  it.live("reloads an auto-discovered plugin when its file changes", () =>
    withLocation(
      undefined,
      Effect.gen(function* () {
        yield* ready()
        const agents = yield* AgentV2.Service
        const events = yield* EventV2.Service
        const location = yield* Location.Service
        const plugins = yield* PluginV2.Service
        const file = path.join(location.directory, ".ycoding", "plugin", "mutable.ts")
        const first = (yield* plugins.list()).find((plugin) => plugin.id === "mutable-plugin")?.id

        expect(first).toBeDefined()
        expect((yield* agents.get(AgentV2.ID.make("mutable")))?.description).toBe("first")

        yield* Effect.promise(async () => {
          await fs.writeFile(file, mutablePlugin("second"))
          const modified = new Date(Date.now() + 5_000)
          await fs.utimes(file, modified, modified)
        })
        yield* events.publish(ConfigSchema.Event.Updated, {})
        yield* waitUntil(
          Effect.gen(function* () {
            const current = (yield* plugins.list()).find((plugin) => plugin.id === "mutable-plugin")?.id
            return current === first && (yield* agents.get(AgentV2.ID.make("mutable")))?.description === "second"
          }),
        )
      }),
      false,
      async (directory) => {
        const plugin = path.join(directory, ".ycoding", "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await fs.writeFile(path.join(plugin, "mutable.ts"), mutablePlugin("first"))
      },
    ),
  )

  it.live("applies explicit removals after auto-discovery", () =>
    withLocation(
      { plugins: ["-*"] },
      Effect.gen(function* () {
        yield* ready()
        const agents = yield* AgentV2.Service
        expect(yield* agents.get(AgentV2.ID.make("directory"))).toBeUndefined()
      }),
      true,
    ),
  )

  it.live("loads user plugins before internal post plugins", () =>
    Effect.gen(function* () {
      const sdk = yield* SdkPlugins.Service
      yield* sdk.register(EffectPlugin.define({ id: "sdk-order", effect: () => Effect.void }))
      yield* withLocation(
        {
          plugins: [
            path.join(import.meta.dir, "../plugin/fixtures/config-promise-plugin.ts"),
            path.join(import.meta.dir, "../plugin/fixtures/variant-source-plugin.ts"),
          ],
        },
        Effect.gen(function* () {
          yield* ready()
          const registry = yield* PluginV2.Service
          const ids = (yield* registry.list()).map((plugin) => String(plugin.id))
          expect(ids.indexOf("ycoding.agent")).toBeLessThan(ids.indexOf("sdk-order"))
          expect(ids.indexOf("sdk-order")).toBeLessThan(ids.indexOf("config-promise-plugin"))
          expect(ids.indexOf("config-promise-plugin")).toBeLessThan(ids.indexOf("variant-source"))
          expect(ids.indexOf("variant-source")).toBeLessThan(ids.indexOf("ycoding.config.provider"))
          expect(ids.indexOf("ycoding.config.provider")).toBeLessThan(ids.indexOf("ycoding.variant"))

          const catalog = yield* Catalog.Service
          expect(
            (yield* catalog.model.get(ProviderV2.ID.make("configured"), ModelV2.ID.make("glm-5.2")))?.variants,
          ).toEqual([
            expect.objectContaining({ id: "high", headers: { custom: "true" } }),
            expect.objectContaining({ id: "max", settings: { reasoningEffort: "max" } }),
          ])
        }),
      )
    }),
  )

  it.live("allows variant generation to be disabled", () =>
    withLocation(
      {
        plugins: [path.join(import.meta.dir, "../plugin/fixtures/variant-source-plugin.ts"), "-ycoding.variant"],
      },
      Effect.gen(function* () {
        yield* ready()
        const registry = yield* PluginV2.Service
        expect((yield* registry.list()).map((plugin) => String(plugin.id))).not.toContain("ycoding.variant")

        const catalog = yield* Catalog.Service
        expect(
          (yield* catalog.model.get(ProviderV2.ID.make("configured"), ModelV2.ID.make("glm-5.2")))?.variants,
        ).toEqual([expect.objectContaining({ id: "high", headers: { custom: "true" } })])
      }),
    ),
  )
})

const ready = Effect.fnUntraced(function* () {
  const supervisor = yield* PluginSupervisor.Service
  yield* supervisor.flush
})

function withLocation<A, E, R>(
  config: unknown,
  effect: Effect.Effect<A, E, R>,
  fixtures = false,
  prepare?: (directory: string) => Promise<void>,
) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.tap((tmp) =>
      Effect.promise(async () => {
        await prepare?.(tmp.path)
        if (fixtures) {
          const directory = path.join(tmp.path, ".ycoding")
          await fs.mkdir(directory, { recursive: true })
          await Promise.all(
            ["plugin", "plugins"].map((name) =>
              fs.symlink(path.join(import.meta.dir, "fixtures", name), path.join(directory, name), "dir"),
            ),
          )
        }
        if (config !== undefined) {
          const directory = fixtures ? path.join(tmp.path, ".ycoding") : tmp.path
          await fs.mkdir(directory, { recursive: true })
          await fs.writeFile(path.join(directory, "ycoding.json"), JSON.stringify(config))
        }
      }),
    ),
    Effect.flatMap((tmp) =>
      effect.pipe(
        Effect.scoped,
        Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }))),
      ),
    ),
  )
}

function mutablePlugin(description: string) {
  const plugin = pathToFileURL(path.join(import.meta.dir, "../../../plugin/src/promise/index.ts")).href
  return `
import { Plugin } from ${JSON.stringify(plugin)}

export default Plugin.define({
  id: "mutable-plugin",
  setup: async (ctx) => {
    await ctx.agent.transform((agents) => {
      agents.update("mutable", (agent) => {
        agent.description = ${JSON.stringify(description)}
        agent.mode = "subagent"
      })
    })
  },
})
`
}

const waitUntil = Effect.fnUntraced(function* (condition: Effect.Effect<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (yield* condition) return
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die("Timed out waiting for plugin reload")
})
