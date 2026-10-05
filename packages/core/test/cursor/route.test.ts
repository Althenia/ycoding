import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { LLM, Message } from "@ycoding-ai/ai"
import { LLMClient, RequestExecutor } from "@ycoding-ai/ai/route"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { Credential } from "@ycoding-ai/core/credential"
import { CursorModels } from "@ycoding-ai/core/cursor/models"
import { Integration } from "@ycoding-ai/core/integration"
import { CatalogModel } from "@ycoding-ai/core/model"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(AISDK.locationLayer)

const client = LLMClient.layer.pipe(
  Layer.provide(
    Layer.succeed(
      RequestExecutor.Service,
      RequestExecutor.Service.of({ execute: () => Effect.die("Unexpected HTTP request") }),
    ),
  ),
)

const [opus, opusFast, opusLong] = CursorModels.fromCursor([
  {
    id: "claude-opus-4-8",
    displayName: "Opus 4.8",
    variants: [
      {
        key: "high",
        displayName: "Opus 4.8 High",
        parameterValues: [{ id: "effort", value: "high" }],
        isDefaultNonMax: true,
        isDefaultMax: false,
      },
      {
        key: "high-fast",
        displayName: "Opus 4.8 High Fast",
        parameterValues: [
          { id: "effort", value: "high" },
          { id: "fast", value: "true" },
        ],
        isDefaultNonMax: false,
        isDefaultMax: false,
      },
      {
        key: "1m",
        displayName: "Opus 4.8 1M",
        parameterValues: [{ id: "context", value: "1m" }],
        isDefaultNonMax: false,
        isDefaultMax: true,
      },
    ],
  },
])

const resolve = (
  info: CatalogModel.Info,
  variant: string | undefined,
  credential: Credential.Value,
  observed: { apiKeys: unknown[]; models: string[] },
) =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      if (event.package !== CursorModels.packageName) return
      observed.apiKeys.push(event.options.apiKey)
      event.sdk = {
        languageModel: (id: string) => {
          observed.models.push(id)
          return {
            specificationVersion: "v3",
            provider: "cursor",
            modelId: id,
            supportedUrls: {},
            doGenerate: () => Promise.reject(new Error("Unexpected Cursor generation")),
            doStream: () => Promise.reject(new Error("Unexpected Cursor stream")),
          } satisfies LanguageModelV3
        },
      }
    })
    const selected = yield* SessionRunnerModel.withVariant(
      info,
      variant === undefined ? undefined : CatalogModel.VariantID.make(variant),
    )
    return yield* SessionRunnerModel.fromCatalogModel(selected, credential, { loadAISDK: aisdk.model })
  })

const prepare = (model: Effect.Success<ReturnType<typeof resolve>>) =>
  LLMClient.prepare<LanguageModelV3CallOptions>(
    LLM.request({
      model,
      cache: "none",
      messages: [
        Message.user("Edit the file"),
        Message.assistant([{ type: "tool-call", id: "cursor_session_7", name: "edit", input: { path: "a.ts" } }]),
        Message.tool({ id: "cursor_session_7", name: "edit", result: { type: "text", value: "Edited a.ts" } }),
      ],
      http: { headers: { "X-Session-Id": "session" } },
    }),
  ).pipe(Effect.provide(client))

const oauth = Credential.OAuth.make({
  type: "oauth",
  methodID: Integration.MethodID.make("browser"),
  access: "access-jwt",
  refresh: "refresh-token",
  expires: 0,
})

it.effect("sends the selected Cursor variant tuple and credential to the provider package", () =>
  Effect.gen(function* () {
    const observed = { apiKeys: [] as unknown[], models: [] as string[] }
    const prepared = yield* prepare(yield* resolve(opusFast, "high", oauth, observed))

    expect(observed).toEqual({ apiKeys: ["access-jwt"], models: ["claude-opus-4-8"] })
    expect(prepared.body.providerOptions).toEqual({
      cursor: {
        cursorVariantParameters: [
          { id: "effort", value: "high" },
          { id: "fast", value: "true" },
        ],
      },
    })
    expect(prepared.body.headers).toMatchObject({ "X-Session-Id": "session" })
    expect(prepared.body.prompt.at(-1)).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "cursor_session_7", output: { type: "text", value: "Edited a.ts" } }],
    })
  }),
)

it.effect("leaves the base Cursor model without parameters when no variant is selected", () =>
  Effect.gen(function* () {
    const observed = { apiKeys: [] as unknown[], models: [] as string[] }
    const prepared = yield* prepare(
      yield* resolve(opus, undefined, Credential.Key.make({ type: "key", key: "crsr_key" }), observed),
    )

    expect(observed.apiKeys).toEqual(["crsr_key"])
    expect(prepared.body.providerOptions).toBeUndefined()
  }),
)

it.effect("sends a single non-effort tuple as the base model setting without a variant", () =>
  Effect.gen(function* () {
    const composer = CursorModels.fromCursor([{ id: "composer-2.5", variants: [{
      key: "standard", displayName: "Composer 2.5", parameterValues: [{ id: "fast", value: "false" }],
      isDefaultNonMax: true, isDefaultMax: false,
    }] }])[0]
    const observed = { apiKeys: [] as unknown[], models: [] as string[] }
    const prepared = yield* prepare(yield* resolve(composer, undefined, oauth, observed))

    expect(composer.variants).toEqual([])
    expect(observed.models).toEqual(["composer-2.5"])
    expect(prepared.body.providerOptions).toEqual({ cursor: { cursorVariantParameters: [{ id: "fast", value: "false" }] } })
  }),
)

it.effect("sends the long-context default tuple for the -1m entry under the real Cursor model id", () =>
  Effect.gen(function* () {
    const observed = { apiKeys: [] as unknown[], models: [] as string[] }
    expect(opusLong.id).toBe(CatalogModel.ID.make("claude-opus-4-8-1m"))
    const prepared = yield* prepare(yield* resolve(opusLong, undefined, oauth, observed))

    expect(observed.models).toEqual(["claude-opus-4-8"])
    expect(prepared.body.providerOptions).toEqual({
      cursor: { cursorVariantParameters: [{ id: "context", value: "1m" }] },
    })
    expect(prepared.body.maxOutputTokens).toBe(128_000)
  }),
)

it.effect("sends a 500k Cursor model's selected effort with its complete context tuple", () =>
  Effect.gen(function* () {
    const grok = CursorModels.fromCursor([{ id: "grok-4.7", displayName: "Grok 4.7", maxContext: 256_000,
      variants: [
        { key: "high", displayName: "Grok 4.7 High", parameterValues: [{ id: "effort", value: "high" }, { id: "context", value: "256k" }], isDefaultNonMax: true, isDefaultMax: false },
        { key: "xhigh-500k", displayName: "Grok 4.7 Extra High 500k", parameterValues: [{ id: "effort", value: "xhigh" }, { id: "context", value: "500k" }], isDefaultNonMax: false, isDefaultMax: true },
      ] }]).find((item) => item.id === CatalogModel.ID.make("grok-4.7-500k"))!
    const observed = { apiKeys: [] as unknown[], models: [] as string[] }
    const prepared = yield* prepare(yield* resolve(grok, "xhigh", oauth, observed))
    expect(observed.models).toEqual(["grok-4.7"])
    expect(prepared.body.providerOptions).toEqual({ cursor: { cursorVariantParameters: [
      { id: "effort", value: "xhigh" }, { id: "context", value: "500k" },
    ] } })
    expect(grok.limit.context).toBe(500_000)
  }),
)

it.effect("rejects a Cursor variant that the catalog entry does not advertise", () =>
  Effect.gen(function* () {
    const error = yield* SessionRunnerModel.withVariant(opusLong, CatalogModel.VariantID.make("Opus 4.8 High")).pipe(
      Effect.flip,
    )
    expect(error._tag).toBe("SessionRunnerModel.VariantUnavailableError")
    const formerLabel = yield* SessionRunnerModel.withVariant(opus, CatalogModel.VariantID.make("Opus 4.8 High")).pipe(Effect.flip)
    expect(formerLabel._tag).toBe("SessionRunnerModel.VariantUnavailableError")
  }),
)
