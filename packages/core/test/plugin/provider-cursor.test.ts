import { AISDK } from "@ycoding-ai/core/aisdk"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Credential } from "@ycoding-ai/core/credential"
import { CursorModels } from "@ycoding-ai/core/cursor/models"
import { Integration } from "@ycoding-ai/core/integration"
import { ModelV2 } from "@ycoding-ai/core/model"
import { PluginV2 } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { CursorPlugin, oauth, oauthCredential, reconcileInterval, syncCatalog } from "@ycoding-ai/core/plugin/provider/cursor"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { beforeEach, describe, expect, mock } from "bun:test"
import { State } from "@ycoding-ai/core/state"
import { Effect, Schedule } from "effect"
import { TestClock } from "effect/testing"
import {
  buildLoginUrl,
  decodeJwtExpiryMs,
  generatePkceChallenge,
  generatePkceParams,
  pollForTokens,
  refreshAccessToken,
} from "../../src/cursor/provider/auth"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const bearerInputs: string[] = []
void mock.module("../../src/cursor/provider/auth", () => ({
  buildLoginUrl,
  decodeJwtExpiryMs,
  generatePkceChallenge,
  generatePkceParams,
  pollForTokens,
  refreshAccessToken,
  resolveBearerToken: async (input: { apiKey: string }) => {
    bearerInputs.push(input.apiKey)
    return "bearer"
  },
}))
const cursorModels = await import("../../src/cursor/provider/models")
const discovery = { failure: undefined as string | undefined }
void mock.module("../../src/cursor/provider/models", () => ({
  ...cursorModels,
  discoverModels: async (token: string) => {
    if (discovery.failure !== undefined) throw new Error(discovery.failure)
    return token === "bearer" ? [{ id: "composer-2.5", displayName: "Composer 2.5", variants: [] }] : []
  },
}))

beforeEach(() => {
  discovery.failure = undefined
})

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* CursorPlugin.effect(host)
})

const jwt = (payload: Record<string, unknown>) =>
  ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".")

/** Drains the dynamic-import promises of a sync together with the catalog's reload debounce. */
const settle = Effect.fn(function* () {
  for (let step = 0; step < 12; step += 1) {
    yield* Effect.yieldNow
    yield* TestClock.adjust("500 millis")
  }
})

const readCursorModelIDs = Effect.fn(function* (catalog: Catalog.Interface) {
  return (yield* catalog.model.all())
    .filter((model) => model.providerID === CursorModels.providerID)
    .map((model) => String(model.id))
})

const cursorModelIDs = Effect.fn(function* (catalog: Catalog.Interface) {
  return yield* Effect.gen(function* () {
    const ids = yield* readCursorModelIDs(catalog)
    if (ids.length === 0) return yield* Effect.fail("no Cursor models yet")
    return ids
  }).pipe(
    Effect.retry({ times: 40, schedule: Schedule.spaced("100 millis") }),
    Effect.catch(() => Effect.succeed([] as string[])),
  )
})

const cursorModel = (id: string) =>
  ModelV2.Info.make({
    ...ModelV2.Info.empty(CursorModels.providerID, ModelV2.ID.make(id)),
    package: ProviderV2.aisdk(CursorModels.packageName),
  })

describe("CursorPlugin", () => {
  it.effect("registers browser OAuth, API key, and CURSOR_API_KEY methods with the Cursor provider", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      yield* addPlugin()
      const integration = yield* integrations.get(Integration.ID.make("cursor"))
      expect(integration?.name).toBe("Cursor")
      expect(integration?.methods).toEqual(
        expect.arrayContaining([
          { id: Integration.MethodID.make("browser"), type: "oauth", label: "Cursor account (browser login)" },
          { type: "key", label: "Cursor API key (crsr_…)" },
          { type: "env", names: ["CURSOR_API_KEY"] },
        ]),
      )
      expect(yield* catalog.provider.get(CursorModels.providerID)).toMatchObject({
        name: "Cursor",
        package: "aisdk:cursor-opencode-provider",
        integrationID: "cursor",
      })
    }),
  )

  it.live("discovers models with CURSOR_API_KEY when the plugin loads inside a state batch", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const previous = process.env.CURSOR_API_KEY
      process.env.CURSOR_API_KEY = "crsr_env"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.CURSOR_API_KEY
          else process.env.CURSOR_API_KEY = previous
        }),
      )
      bearerInputs.length = 0
      yield* State.batch(addPlugin().pipe(Effect.andThen(Effect.sleep("100 millis"))))
      const discovered = Effect.gen(function* () {
        const ids = (yield* catalog.model.all())
          .filter((model) => model.providerID === CursorModels.providerID)
          .map((model) => String(model.id))
        if (ids.length === 0) return yield* Effect.fail("no Cursor models yet")
        return ids
      })
      expect(
        yield* discovered.pipe(
          Effect.retry({ times: 40, schedule: Schedule.spaced("100 millis") }),
          Effect.catch(() => Effect.succeed([])),
        ),
      ).toEqual(["composer-2.5"])
      expect(bearerInputs).toEqual(["crsr_env"])
    }),
  )

  it.live("publishes Cursor models for an active OAuth connection that already exists at load", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      yield* credentials.create({
        integrationID: Integration.ID.make("cursor"),
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("browser"),
          access: "jwt-access",
          refresh: "jwt-refresh",
          expires: Date.now() + 86_400_000,
        }),
      })
      yield* State.batch(addPlugin().pipe(Effect.andThen(Effect.sleep("100 millis"))))
      expect(yield* cursorModelIDs(catalog)).toEqual(["composer-2.5"])
    }),
  )

  it.live("publishes Cursor models when a connection is made after the plugin loaded", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      yield* State.batch(addPlugin().pipe(Effect.andThen(Effect.sleep("100 millis"))))
      expect(yield* readCursorModelIDs(catalog)).toEqual([])
      yield* integrations.connection.key({ integrationID: Integration.ID.make("cursor"), key: "crsr_after_load" })
      expect(yield* cursorModelIDs(catalog)).toEqual(["composer-2.5"])
    }),
  )

  it.effect("publishes Cursor models for a credential stored without a connection event", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      yield* State.batch(addPlugin())
      yield* settle()
      expect(yield* readCursorModelIDs(catalog)).toEqual([])
      yield* credentials.create({
        integrationID: Integration.ID.make("cursor"),
        value: Credential.Key.make({ type: "key", key: "crsr_other_process" }),
      })
      yield* TestClock.adjust(reconcileInterval)
      yield* settle()
      expect(yield* readCursorModelIDs(catalog)).toEqual(["composer-2.5"])
    }),
  )

  it.live("keeps the published Cursor models when a later sync fails", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      yield* credentials.create({
        integrationID: Integration.ID.make("cursor"),
        value: Credential.Key.make({ type: "key", key: "crsr_first" }),
      })
      yield* State.batch(addPlugin().pipe(Effect.andThen(Effect.sleep("100 millis"))))
      expect(yield* cursorModelIDs(catalog)).toEqual(["composer-2.5"])

      discovery.failure = "AvailableModels timed out after 5000ms"
      bearerInputs.length = 0
      yield* integrations.connection.key({ integrationID: Integration.ID.make("cursor"), key: "crsr_second" })
      yield* Effect.gen(function* () {
        yield* Effect.sleep("50 millis")
        if (bearerInputs.includes("crsr_second")) return true
        return yield* Effect.fail("sync not attempted")
      }).pipe(Effect.retry({ times: 60 }))
      yield* Effect.sleep("1 second")
      expect(yield* readCursorModelIDs(catalog)).toEqual(["composer-2.5"])
    }),
  )

  it.effect("replaces Cursor catalog models with the discovered set", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* addPlugin()
      yield* catalog.transform((draft) => {
        draft.model.update(CursorModels.providerID, ModelV2.ID.make("stale"), (model) =>
          Object.assign(model, cursorModel("stale")),
        )
      })
      yield* catalog.transform((draft) =>
        syncCatalog(
          {
            provider: {
              get: (providerID) => draft.provider.get(ProviderV2.ID.make(providerID)),
              update: (providerID, update) => draft.provider.update(ProviderV2.ID.make(providerID), update),
            },
            model: {
              remove: (providerID, modelID) => draft.model.remove(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)),
              update: (providerID, modelID, update) =>
                draft.model.update(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID), update),
            },
          },
          [cursorModel("composer-2.5")],
        ),
      )

      const ids = (yield* catalog.model.all())
        .filter((model) => model.providerID === CursorModels.providerID)
        .map((model) => String(model.id))
      expect(ids).toEqual(["composer-2.5"])
    }),
  )

  it.effect("creates the Cursor SDK only for the Cursor package", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const event = (packageName: string) =>
        aisdk.runSDK({
          model: cursorModel("composer-2.5"),
          package: packageName,
          options: { name: "cursor", apiKey: "crsr_test" },
        })

      expect((yield* event("@ai-sdk/openai-compatible")).sdk).toBeUndefined()
      const language: LanguageModelV3 = (yield* event("cursor-opencode-provider")).sdk.languageModel("composer-2.5")
      expect(language).toMatchObject({ specificationVersion: "v3", provider: "cursor", modelId: "composer-2.5" })
    }),
  )

  it.effect("starts Cursor browser login with a PKCE challenge", () =>
    Effect.gen(function* () {
      const authorization = yield* oauth.authorize()
      const url = new URL(authorization.url)
      expect(authorization.mode).toBe("auto")
      expect(url.origin + url.pathname).toBe("https://cursor.com/loginDeepControl")
      expect(url.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(url.searchParams.get("uuid")).toMatch(/^[0-9a-f-]{36}$/)
      expect(url.searchParams.get("redirectTarget")).toBe("cli")
    }).pipe(Effect.scoped),
  )

  it.effect("stores Cursor OAuth tokens with the access token expiry", () =>
    Effect.sync(() => {
      const access = jwt({ exp: 1_900_000_000 })
      expect(oauthCredential({ accessToken: access, refreshToken: "refresh" })).toEqual({
        type: "oauth",
        methodID: Integration.MethodID.make("browser"),
        access,
        refresh: "refresh",
        expires: 1_900_000_000_000,
      })
      expect(oauthCredential({ accessToken: "opaque", refreshToken: "refresh" }).expires).toBe(0)
    }),
  )
})
