import { AISDK } from "@ycoding-ai/core/aisdk"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CatalogModel } from "@ycoding-ai/core/model"
import { PluginRegistry } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { GooglePlugin } from "@ycoding-ai/core/plugin/provider/google"
import { Provider } from "@ycoding-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginRegistry.Service
  const host = yield* PluginHost.make(plugin)
  yield* GooglePlugin.effect(host)
})

describe("GooglePlugin", () => {
  it.effect("wraps AI SDK language models for the native runner", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      yield* addPlugin()

      const resolved = yield* aisdk.model(
        CatalogModel.Info.make({
          ...CatalogModel.Info.empty(Provider.ID.make("custom-google"), CatalogModel.ID.make("alias")),
          modelID: CatalogModel.ID.make("gemini-api"),
          package: "aisdk:@ai-sdk/google",
          settings: { apiKey: "test" },
        }),
      )

      expect(String(resolved.id)).toBe("gemini-api")
      expect(String(resolved.provider)).toBe("custom-google")
      expect(resolved.route.id).toBe("ai-sdk:@ai-sdk/google")
    }),
  )
})
