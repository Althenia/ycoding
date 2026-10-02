import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@ycoding-ai/core/catalog"
import { PluginV2 } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { VercelPlugin } from "@ycoding-ai/core/plugin/provider/vercel"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* VercelPlugin.effect(host)
})

describe("VercelPlugin", () => {
  it.effect("applies legacy lower-case referer headers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.make("vercel"), (provider) => {
          provider.package = ProviderV2.aisdk("@ai-sdk/vercel")
          provider.headers = { ...provider.headers, Existing: "1" }
        })
      })
      yield* addPlugin()
      expect((yield* catalog.provider.get(ProviderV2.ID.make("vercel")))?.headers).toEqual({
        Existing: "1",
        "x-title": "YCoding",
      })
    }),
  )

  it.effect("does not add legacy upper-case referer headers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) =>
        catalog.provider.update(ProviderV2.ID.make("vercel"), (provider) => {
          provider.package = ProviderV2.aisdk("@ai-sdk/vercel")
        }),
      )
      yield* addPlugin()
      expect((yield* catalog.provider.get(ProviderV2.ID.make("vercel")))?.headers).not.toHaveProperty("HTTP-Referer")
      expect((yield* catalog.provider.get(ProviderV2.ID.make("vercel")))?.headers).not.toHaveProperty("X-Title")
    }),
  )

  it.effect("ignores non-Vercel providers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => catalog.provider.update(ProviderV2.ID.make("gateway"), () => {}))
      yield* addPlugin()
      expect((yield* catalog.provider.get(ProviderV2.ID.make("gateway")))?.headers).toBeUndefined()
    }),
  )
})
