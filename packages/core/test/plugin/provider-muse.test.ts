import { describe, expect, test } from "bun:test"
import { LLM } from "@ycoding-ai/ai"
import { LLMClient, RequestExecutor } from "@ycoding-ai/ai/route"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { CatalogModel } from "@ycoding-ai/core/model"
import { PluginRegistry } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { ProviderPlugins } from "@ycoding-ai/core/plugin/provider"
import { OpenAIPlugin } from "@ycoding-ai/core/plugin/provider/openai"
import {
  discoverMuseModels,
  mintMuseKey,
  museOAuth,
  MusePlugin,
  observeMuseUsage,
} from "@ycoding-ai/core/plugin/provider/muse"
import { Provider } from "@ycoding-ai/core/provider"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"
import { State } from "@ycoding-ai/core/state"
import { Deferred, Effect, Fiber, Layer, Logger, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientResponse, HttpClientRequest } from "effect/unstable/http"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const providerID = Provider.ID.make("muse")
const integrationID = Integration.ID.make("muse")
const decodeRequestBody = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
const device = {
  device_code: "device-fixture",
  user_code: "CODE",
  verification_uri: "https://auth.meta.com/device",
  verification_uri_complete: "https://auth.meta.com/device?code=CODE",
  expires_in: 600,
  interval: 2,
}
const account = (expires = 0) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("device"),
    access: "meta-access",
    refresh: "",
    expires,
  })
const metadata = {
  name: "Muse Wonder",
  family: "muse-wonder",
  release_date: "2026-09-02",
  is_hidden: false,
  attachment: true,
  reasoning: true,
  temperature: true,
  tool_call: true,
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 1_007_997, output: 128_000 },
  options: {
    reasoningEffort: "high",
    forceReasoning: true,
    include: ["reasoning.encrypted_content"],
    temperature: 0.9,
    top_p: 0.9,
  },
  description: null,
  variants: {
    minimal: { reasoningEffort: "minimal" },
    low: { reasoningEffort: "low" },
    medium: { reasoningEffort: "medium" },
    high: { reasoningEffort: "high" },
    xhigh: { reasoningEffort: "xhigh", selector: { description: "Extra high" } },
    max: { reasoningEffort: "max" },
    ultra: { reasoningEffort: "ultra" },
  },
}
const row = {
  id: "muse-wonder-1.0",
  object: "model",
  created: 1_788_307_200,
  owned_by: "meta",
  metadata: { "muse-code": metadata },
}
const http = (respond: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  HttpClient.make((request) => Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request))))
const body = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected encoded body")
  return new TextDecoder().decode(request.body.body)
}
const addPlugin = Effect.fn(function* (
  client: HttpClient.HttpClient,
  send?: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
  usage?: ProviderUsageRuntime.Interface,
) {
  const aisdk = yield* AISDK.Service
  if (send)
    yield* aisdk.hook.sdk((event) => {
      if (event.model.providerID === providerID) event.options.fetch = send
    })
  const registry = yield* PluginRegistry.Service
  const host = yield* PluginHost.make(registry)
  const configured = MusePlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, client))
  yield* usage ? configured.pipe(Effect.provideService(ProviderUsageRuntime.Service, usage)) : configured
})
const snapshot = Effect.fn(function* (value: Credential.Value, label = "Muse account") {
  const credentials = yield* Credential.Service
  const integrations = yield* Integration.Service
  const saved = yield* credentials.create({ integrationID, value, label })
  return yield* integrations.connection.snapshot({ type: "credential", id: saved.id, label: saved.label, active: true })
})
const modelInfo = (settings = {}) =>
  CatalogModel.Info.make({
    ...CatalogModel.Info.empty(providerID, CatalogModel.ID.make(row.id)),
    package: Provider.aisdk("@ai-sdk/openai"),
    settings,
    limit: metadata.limit,
  })
const streamResponse = () =>
  new Response(
    [
      { type: "response.created", response: { id: "resp_fixture", created_at: 1, model: row.id } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "reason_fixture", encrypted_content: "encrypted-fixture", summary: [] },
      },
      { type: "response.reasoning_summary_text.delta", item_id: "reason_fixture", summary_index: 0, delta: "Thought" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "reason_fixture",
          encrypted_content: "encrypted-fixture",
          summary: [{ type: "summary_text", text: "Thought" }],
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_fixture", role: "assistant", content: [] },
      },
      { type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "Hello" },
      {
        type: "response.completed",
        response: {
          id: "resp_fixture",
          status: "completed",
          incomplete_details: null,
          usage: { input_tokens: 5, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  )
const inference = Effect.fn(function* (
  aisdk: AISDK.Interface,
  model: CatalogModel.Info,
  saved: Integration.Snapshot,
  sessionID = "session-fixture",
) {
  const resolved = yield* SessionRunnerModel.fromCatalogModel(
    model,
    saved.value,
    { loadAISDK: aisdk.model },
    saved.connection,
    saved,
  )
  expect(resolved.route.id).toBe("ai-sdk:@ai-sdk/openai")
  const cache = SessionRunnerCache.providerOptions({
    sessionID,
    projectID: "project-fixture",
    directory: "/fixture",
    providerID,
    modelID: model.id,
    apiModelID: model.id,
    routeID: resolved.route.id,
    policyRevision: "fixture",
    permissions: [],
    system: [],
    tools: [],
  })
  const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
    LLM.request({
      model: resolved,
      prompt: "Hello",
      providerOptions: cache.providerOptions,
    }),
  )
  const language = yield* aisdk.language(model, saved)
  const result = yield* Effect.tryPromise({ try: () => language.doStream(prepared.body), catch: (cause) => cause })
  const parts = yield* Effect.promise(async () => {
    const parts = []
    for await (const part of result.stream) parts.push(part)
    return parts
  })
  expect(parts.some((part) => part.type === "text-delta" && part.delta === "Hello")).toBe(true)
  expect(parts.some((part) => part.type === "finish")).toBe(true)
  return cache.wirePromptCacheKey
})

test("registers Muse as a builtin subscription provider", () => {
  expect(ProviderPlugins.some((plugin) => plugin.id === "ycoding.provider.muse")).toBe(true)
})

describe("Muse device login", () => {
  it.effect("requires a valid embedded client without consulting the environment", () =>
    Effect.gen(function* () {
      let calls = 0
      const client = http(() => {
        calls++
        return Response.json(device)
      })
      const previous = process.env.YCODING_MUSE_CLIENT_ID
      process.env.YCODING_MUSE_CLIENT_ID = "environment-fixture"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.YCODING_MUSE_CLIENT_ID
          if (previous !== undefined) process.env.YCODING_MUSE_CLIENT_ID = previous
        }),
      )
      for (const embedded of [undefined, {}, { clientID: "" }, { clientID: "fixture", clientSecret: 123 }]) {
        const result = yield* museOAuth(client, embedded).authorize({}).pipe(Effect.flip)
        expect(String(result)).toContain("Muse OAuth requires YCODING_MUSE_CLIENT_ID at build time.")
      }
      expect(calls).toBe(0)
    }),
  )

  for (const secret of [undefined, "", "fixture-secret"])
    it.effect(`sends the appropriate OAuth client secret (${secret ?? "absent"})`, () =>
      Effect.gen(function* () {
        const requests: HttpClientRequest.HttpClientRequest[] = []
        const client = http((request) => {
          requests.push(request)
          return Response.json(request.url.endsWith("authorization/") ? device : { access_token: "fixture" })
        })
        const started = yield* museOAuth(client, { clientID: "fixture-client", clientSecret: secret }).authorize({})
        yield* started.callback
        for (const request of requests) {
          expect(request.headers["user-agent"]).toBe("muse-code/launcher-3")
          expect(new URLSearchParams(body(request)).get("client_secret")).toBe(secret || null)
        }
      }),
    )

  for (const redirect of ["authorization", "token"])
    it.effect(`rejects ${redirect} redirects`, () =>
      Effect.gen(function* () {
        const client = http((request) =>
          request.url.includes(redirect + "/") ? new Response(null, { status: 302 }) : Response.json(device),
        )
        const registration = museOAuth(client, { clientID: "fixture-client" })
        if (redirect === "authorization") {
          expect(String(yield* registration.authorize({}).pipe(Effect.flip))).toContain("unexpected redirect")
          return
        }
        const started = yield* registration.authorize({})
        expect(String(yield* started.callback.pipe(Effect.flip))).toContain("unexpected redirect")
      }),
    )

  it.effect("uses form device authorization and immediate polling, preserving optional tokens and expiry", () =>
    Effect.gen(function* () {
      const requests: HttpClientRequest.HttpClientRequest[] = []
      const registration = museOAuth(
        http((request) => {
          requests.push(request)
          return Response.json(
            request.url.endsWith("authorization/")
              ? device
              : { access_token: "account-token", refresh_token: "optional-refresh", expires_in: 60 },
          )
        }),
        { clientID: "fixture-muse-client-id" },
      )
      expect("refresh" in registration).toBe(false)
      const started = yield* registration.authorize({})
      expect(started.url).toBe(device.verification_uri_complete)
      expect(started.instructions).toContain(device.user_code)
      expect(yield* started.callback).toMatchObject({
        access: "account-token",
        refresh: "optional-refresh",
        expires: 60_000,
      })
      expect(requests.map((request) => [request.method, request.url])).toEqual([
        ["POST", "https://auth.meta.com/oidc/device/authorization/"],
        ["POST", "https://auth.meta.com/oidc/device/token/"],
      ])
      for (const request of requests) {
        expect(request.headers["user-agent"]).toBe("muse-code/launcher-3")
        expect(request.headers.accept).toBe("application/json")
        expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded")
      }
      expect(new URLSearchParams(body(requests[0]))).toEqual(
        new URLSearchParams({ client_id: "fixture-muse-client-id" }),
      )
      expect(Object.fromEntries(new URLSearchParams(body(requests[1])))).toEqual({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: "fixture-muse-client-id",
      })
    }),
  )

  it.effect("paces pending and slow_down with the default interval and stores unknown expiry as zero", () =>
    Effect.gen(function* () {
      const polled = [yield* Deferred.make<void>(), yield* Deferred.make<void>(), yield* Deferred.make<void>()]
      const requests: number[] = []
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.url.endsWith("authorization/"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ ...device, interval: 0, verification_uri_complete: undefined }),
            )
          const index = requests.length
          requests.push(index)
          yield* Deferred.succeed(polled[index], undefined)
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              index === 0
                ? { error: "authorization_pending" }
                : index === 1
                  ? { error: "slow_down" }
                  : { access_token: "account-token" },
              { status: index < 2 ? 400 : 200 },
            ),
          )
        }),
      )
      const started = yield* museOAuth(client, { clientID: "fixture-muse-client-id" }).authorize({})
      expect(started.url).toBe(device.verification_uri)
      const fiber = yield* started.callback.pipe(Effect.forkChild)
      yield* Deferred.await(polled[0])
      yield* TestClock.adjust("4999 millis")
      expect(requests).toHaveLength(1)
      yield* TestClock.adjust("1 millis")
      yield* Deferred.await(polled[1])
      yield* TestClock.adjust("9999 millis")
      expect(requests).toHaveLength(2)
      yield* TestClock.adjust("1 millis")
      expect(yield* Fiber.join(fiber)).toMatchObject({ access: "account-token", refresh: "", expires: 0 })
      expect(requests).toHaveLength(3)
    }),
  )

  for (const error of ["access_denied", "expired_token", "invalid_grant", undefined])
    it.effect(`fails login without an access token (${error ?? "missing token"})`, () =>
      Effect.gen(function* () {
        const started = yield* museOAuth(
          http((request) =>
            Response.json(request.url.endsWith("authorization/") ? device : { error }, {
              status: request.url.endsWith("authorization/") ? 200 : 400,
            }),
          ),
          { clientID: "fixture-muse-client-id" },
        ).authorize({})
        const result = yield* started.callback.pipe(Effect.flip)
        expect(String(result)).toContain("Device authorization failed")
        if (error) expect(String(result)).toContain(error)
      }),
    )

  it.effect("stops polling at device expiry", () =>
    Effect.gen(function* () {
      const started = yield* museOAuth(
        http((request) =>
          Response.json(
            request.url.endsWith("authorization/") ? { ...device, expires_in: 1 } : { error: "authorization_pending" },
          ),
        ),
        { clientID: "fixture-muse-client-id" },
      ).authorize({})
      const fiber = yield* started.callback.pipe(Effect.flip, Effect.forkChild)
      yield* TestClock.adjust("2 seconds")
      expect(String(yield* Fiber.join(fiber))).toContain("expired_token")
    }),
  )
})

describe("Muse key mint and discovery", () => {
  for (const [raw, expected] of [
    ["https://api.meta.ai/v1/responses///", "https://api.meta.ai/v1"],
    ["https://api.meta.ai/v1///", "https://api.meta.ai/v1"],
    ["not a URL", "https://api.meta.ai/v1"],
    ["https://user:pass@example.invalid/v1", "https://api.meta.ai/v1"],
  ])
    it.effect(`normalizes minted base URL ${raw}`, () =>
      Effect.gen(function* () {
        const result = yield* mintMuseKey(
          http(() => Response.json({ api_key: "key", base_url: raw })),
          account(),
        )
        expect(result.base_url).toBe(expected)
      }),
    )

  for (const [status, payload, expected] of [
    [403, { detail: " upgrade required " }, "Muse key mint failed: upgrade required"],
    [422, { title: " bad request " }, "Muse key mint failed (422): bad request"],
  ] as const)
    it.effect(`reports problem details for ${status}`, () =>
      Effect.gen(function* () {
        const result = yield* mintMuseKey(
          http(() => Response.json(payload, { status })),
          account(),
        ).pipe(Effect.flip)
        expect(String(result)).toContain(expected)
      }),
    )

  it.effect("returns subscription usage and display tier without personal fields", () =>
    Effect.gen(function* () {
      const result = yield* mintMuseKey(
        http(() =>
          Response.json({
            api_key: "key",
            base_url: "https://api.meta.ai/v1",
            subs_tier_name: " Plus ",
            subs_usage: { tier: "opaque-tier", window: { used_percent: 125.5 } },
            user_email: "fixture@example.invalid",
          }),
        ),
        account(),
      )
      expect(result).toMatchObject({
        subs_tier_name: "Plus",
        subs_usage: { label: "Muse (Meta) · Plus", windows: [{ used: 125.5 }] },
      })
      expect(JSON.stringify(result)).not.toContain("opaque-tier")
      expect(JSON.stringify(result)).not.toContain("fixture@example.invalid")
    }),
  )

  it.effect("does not expose account personal fields in malformed mint errors", () =>
    Effect.gen(function* () {
      const failure = yield* mintMuseKey(
        http(() =>
          Response.json({
            api_key: 123,
            base_url: "https://api.meta.ai/v1",
            action_url: null,
            user_full_name: "Synthetic account",
            user_email: "fixture@example.invalid",
          }),
        ),
        account(),
      ).pipe(Effect.flip)
      expect(JSON.stringify(failure)).not.toContain("Synthetic account")
      expect(JSON.stringify(failure)).not.toContain("fixture@example.invalid")
      expect(String(failure)).toContain("Muse key mint returned an invalid response")
    }),
  )

  it.effect("mints with the account token and decodes catalog limits without inventing missing ones", () =>
    Effect.gen(function* () {
      const requests: HttpClientRequest.HttpClientRequest[] = []
      const client = http((request) => {
        requests.push(request)
        return Response.json(
          request.url.endsWith("/key")
            ? {
                api_key: "minted-key",
                base_url: "https://api.meta.ai/v1",
                require_payment: false,
                is_subs_active: true,
                action_url: null,
                user_full_name: "Synthetic account",
                user_email: "fixture@example.invalid",
              }
            : {
                data: [
                  row,
                  { ...row, id: "unbounded", metadata: { "muse-code": { ...metadata, limit: undefined } } },
                  {
                    ...row,
                    id: "fraction",
                    metadata: { "muse-code": { ...metadata, limit: { context: 1.5, output: 128_000 } } },
                  },
                  {
                    ...row,
                    id: "string-limit",
                    metadata: { "muse-code": { ...metadata, limit: { context: 1_007_997, output: "128000" } } },
                  },
                  { ...row, id: "hidden", metadata: { "muse-code": { ...metadata, is_hidden: true } } },
                  { ...row, id: "non-tool", metadata: { "muse-code": { ...metadata, tool_call: false } } },
                  {
                    ...row,
                    id: "muse-image-1.0",
                    metadata: { "muse-code": { ...metadata, modalities: { input: ["text"], output: ["image"] } } },
                  },
                  {
                    ...row,
                    id: "fallback",
                    metadata: {
                      "muse-code": { ...metadata, name: undefined, variants: undefined, options: undefined },
                    },
                  },
                ],
              },
        )
      })
      const minted = yield* mintMuseKey(client, account())
      expect(minted).toEqual({ api_key: "minted-key", base_url: "https://api.meta.ai/v1" })
      const warnings: unknown[] = []
      const models = yield* discoverMuseModels(client, minted).pipe(
        Effect.provide(
          Logger.layer([Logger.make((options) => warnings.push(options.message))], { mergeWithExisting: false }),
        ),
      )
      expect(warnings).toHaveLength(6)
      expect(warnings.every((message) => String(message).includes("skipped Muse model row"))).toBe(true)
      expect(models.map((model) => String(model.id))).toEqual([row.id, "fallback"])
      expect(models[0]).toMatchObject({
        name: "Muse Wonder",
        family: "muse-wonder",
        time: { released: Date.parse("2026-09-02") },
        limit: { context: 1_007_997, output: 128_000 },
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost: [],
        settings: {
          store: false,
          reasoningEffort: "high",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      })
      expect(models[1]?.name).toBe("fallback")
      expect(models[1]?.variants).toEqual([])
      expect(models[1]?.settings?.reasoningEffort).toBeUndefined()
      expect(models[1]?.settings).toMatchObject({ store: false, include: ["reasoning.encrypted_content"] })
      expect(models[0]?.settings?.temperature).toBeUndefined()
      expect(models[0]?.settings?.top_p).toBeUndefined()
      expect(models[0]?.variants.map((variant) => String(variant.id))).toEqual([
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ])
      expect(models[0]?.variants.map((variant) => variant.settings?.reasoningEffort)).toEqual([
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ])
      expect(requests[0]).toMatchObject({
        method: "POST",
        url: "https://api.meta.ai/muse-code/key",
        headers: { authorization: "Bearer meta-access", "x-api-version": "1.0.0", "content-type": "application/json" },
      })
      expect(JSON.parse(body(requests[0]))).toEqual({ onboard: false })
      expect(requests[1]).toMatchObject({
        method: "GET",
        url: "https://api.meta.ai/muse-code/models",
        headers: { authorization: "Bearer minted-key", "x-client-id": "tbh:exec" },
      })
    }),
  )

  for (const response of [{ require_payment: true }, { is_subs_active: false }])
    it.effect(`requires subscription/payment setup for ${Object.keys(response)[0]}`, () =>
      Effect.gen(function* () {
        const result = yield* mintMuseKey(
          http(() =>
            Response.json({
              api_key: "key",
              base_url: "https://api.meta.ai/v1",
              action_url: "https://meta.ai/subscribe",
              ...response,
            }),
          ),
          account(),
        ).pipe(Effect.flip)
        expect(String(result)).toContain("Muse subscription/payment setup is required")
        expect(String(result)).toContain("https://meta.ai/subscribe")
      }),
    )

  for (const response of [{}, { api_key: "key" }, { base_url: "https://api.meta.ai/v1" }])
    it.effect(`rejects mint with missing fields (${Object.keys(response).join(",")})`, () =>
      Effect.gen(function* () {
        expect(
          String(
            yield* mintMuseKey(
              http(() => Response.json(response)),
              account(),
            ).pipe(Effect.flip),
          ),
        ).toContain("mint response missing api_key or base_url")
      }),
    )

  it.effect("tells rejected and expired accounts to log in again without using a refresh grant", () =>
    Effect.gen(function* () {
      const requests: string[] = []
      const client = http((request) => {
        requests.push(request.url)
        return Response.json({}, { status: 401 })
      })
      for (const value of [account(), account(1)]) {
        yield* TestClock.adjust("2 millis")
        const result = yield* mintMuseKey(client, value).pipe(Effect.flip)
        expect(String(result)).toContain("log in again")
        expect(String(result)).toContain("/connect")
      }
      expect(requests).toEqual(["https://api.meta.ai/muse-code/key"])
    }),
  )
})

describe("MusePlugin", () => {
  it.effect("maps session and client headers and normalizes contributor mode and tool choice", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const sent: { headers: Headers; body: unknown }[] = []
      yield* addPlugin(
        http(() => Response.json({ data: [] })),
        async (_input, init) => {
          sent.push({
            headers: new Headers(init?.headers),
            body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
          })
          return Response.json({})
        },
      )
      let wrapped: typeof fetch | undefined
      yield* aisdk.hook.sdk((event) => {
        if (event.model.providerID === providerID) wrapped = event.options.fetch
      })
      const saved = yield* snapshot(Credential.Key.make({ type: "key", key: "fixture" }))
      yield* aisdk.language(modelInfo(), saved)
      if (!wrapped) throw new Error("missing wrapped fetch")
      const send = wrapped
      const headers = {
        "x-ycoding-session": "child",
        "x-parent-session-id": "parent",
        "x-ycoding-client": "tui",
        "x-ycoding-project": "fixture",
        "x-session-affinity": "fixture",
        "x-session-id": "fixture",
        "x-opencode-session": "fixture",
      }
      yield* Effect.promise(() =>
        send("https://example.invalid", {
          headers,
          body: JSON.stringify({
            model: "fixture-contributor",
            tool_choice: "required",
            tools: [{ type: "function" }],
          }),
        }),
      )
      yield* Effect.promise(() =>
        send("https://example.invalid", {
          headers: { ...headers, "x-ycoding-client": "web" },
          body: JSON.stringify({ model: "fixture-internal", tool_choice: "none", tools: [{ type: "function" }] }),
        }),
      )
      yield* Effect.promise(() =>
        send("https://example.invalid", {
          body: JSON.stringify({ model: "fixture", tool_choice: "required", tools: [] }),
        }),
      )
      expect(sent[0].headers.get("x-client-id")).toBe("tbh:tui")
      expect(sent[1].headers.get("x-client-id")).toBe("tbh:serve")
      expect(sent[2].headers.get("x-client-id")).toBe("tbh:exec")
      expect(sent.map((entry) => entry.headers.get("x-tbh-contributor-mode"))).toEqual(["1", null, "0"])
      expect(sent[0].body).toMatchObject({ tool_choice: "auto", tools: [{ type: "function" }] })
      expect(sent[1].body).toEqual({ model: "fixture-internal" })
      expect(sent[2].body).toEqual({ model: "fixture" })
      const session = sent[0].headers.get("x-tbh-session-id")
      const parent = sent[0].headers.get("x-tbh-parent-thread-id")
      expect(session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(parent).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(parent).not.toBe(session)
      expect(sent[0].headers.get("x-meta-ai-gateway-session-id")).toBe(session)
      expect(sent[0].headers.get("x-tbh-thread-id")).toBe(session)
      expect(sent[0].headers.get("x-tbh-root-session-id")).toBe(parent)
      expect(sent[1].headers.get("x-tbh-session-id")).toBe(session)
      for (const name of Object.keys(headers)) expect(sent[0].headers.get(name)).toBeNull()
    }),
  )

  it.effect("remints once after discovery rejects the first minted key and observes mint quota", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const catalog = yield* Catalog.Service
      const usage = ProviderUsageRuntime.make({
        credentials,
        providers: catalog.provider,
        adapters: { muse: ProviderUsageRuntime.muse },
      })
      const saved = yield* snapshot(account())
      const discovered = yield* Deferred.make<void>()
      let mints = 0
      let requests = 0
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.url.endsWith("/key")) {
            mints++
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                api_key: `key-${mints}`,
                base_url: "https://api.meta.ai/v1",
                subs_tier_name: "Plus",
                subs_usage: { window: { used_percent: 12 } },
              }),
            )
          }
          requests++
          if (requests === 2) yield* Deferred.succeed(discovered, undefined)
          return HttpClientResponse.fromWeb(
            request,
            requests === 1 ? Response.json({}, { status: 401 }) : Response.json({ data: [row] }),
          )
        }),
      )
      yield* addPlugin(client, undefined, usage)
      yield* TestClock.adjust("500 millis")
      yield* Deferred.await(discovered)
      yield* TestClock.adjust("500 millis")
      expect(mints).toBe(2)
      expect(yield* usage.get({ providerID, credentialID: saved.credential!.id })).toMatchObject({
        label: "Muse (Meta) · Plus",
        windows: [{ used: 12 }],
      })
      expect(yield* catalog.model.get(providerID, CatalogModel.ID.make(row.id))).toBeDefined()
    }),
  )

  it.effect("observes SSE bytes unchanged and ignores malformed quota without recording it", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const catalog = yield* Catalog.Service
      const usage = ProviderUsageRuntime.make({
        credentials,
        providers: catalog.provider,
        adapters: { muse: ProviderUsageRuntime.muse },
      })
      const content =
        'data: {"type":"response.output_text.delta","delta":"こんにちは"}\r\n\r\ndata: {"type":"response.subscription_usage","subscription":{"window":{"used_percent":"private invalid value"}}}\r\n\r\n'
      const bytes = new TextEncoder().encode(content)
      const response = observeMuseUsage(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
              controller.close()
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
        usage,
      )
      expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(bytes)
      expect(yield* usage.get({ providerID })).toMatchObject({ status: "unsupported", windows: [] })
    }),
  )

  for (const mode of ["profile", "env"] as const)
    it.effect(`observes trailing subscription quota without changing inference output (${mode})`, () =>
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const catalog = yield* Catalog.Service
        const aisdk = yield* AISDK.Service
        const usage = ProviderUsageRuntime.make({
          credentials,
          providers: catalog.provider,
          adapters: { muse: ProviderUsageRuntime.muse },
        })
        const responseText = yield* Effect.promise(
          async () =>
            `${await streamResponse().text()}data: ${JSON.stringify({ subscription: { tier: "27681527378179523", weekly: { resets_at: 1792368000, used_percent: 0 }, window: { resets_at: 1791876076, used_percent: 0, window_duration_mins: 300 } }, type: "response.subscription_usage" })}\n\n`,
        )
        let requests = 0
        yield* addPlugin(
          http(() => Response.json({ data: [] })),
          async () => {
            requests++
            const encoded = new TextEncoder().encode(responseText)
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  for (let offset = 0; offset < encoded.length; offset += 13)
                    controller.enqueue(encoded.slice(offset, offset + 13))
                  controller.close()
                },
              }),
              { headers: { "Content-Type": "text/event-stream" } },
            )
          },
          usage,
        )
        const saved: Integration.Snapshot =
          mode === "profile"
            ? yield* snapshot(Credential.Key.make({ type: "key", key: "fixture" }), "Personal")
            : {
                connection: { type: "env", name: "META_API_KEY" },
                value: Credential.Key.make({ type: "key", key: "fixture" }),
              }
        const other =
          mode === "profile" ? yield* snapshot(Credential.Key.make({ type: "key", key: "other" }), "Work") : undefined
        yield* inference(aisdk, modelInfo({ store: false, reasoningEffort: "high" }), saved)
        const result = yield* usage.get({
          providerID,
          ...(saved.credential ? { credentialID: saved.credential.id } : {}),
        })
        expect(result).toMatchObject({
          status: "available",
          source: "response_stream",
          stability: "observed",
          windows: [
            { id: "window", used: 0, resetAt: 1791876076000, periodSeconds: 18000 },
            { id: "weekly", used: 0, resetAt: 1792368000000, periodSeconds: 604800 },
          ],
        })
        if (other?.credential) {
          expect(result.profile).toBe("Personal")
          expect(yield* usage.get({ providerID, credentialID: other.credential.id })).toMatchObject({
            status: "unsupported",
            windows: [],
          })
          yield* credentials.update(saved.credential!.id, {
            value: Credential.Key.make({ type: "key", key: "replacement" }),
          })
          expect(yield* usage.get({ providerID, credentialID: saved.credential!.id })).toMatchObject({
            status: "unsupported",
            windows: [],
          })
        }
        expect(requests).toBe(1)
      }),
    )

  it.effect(
    "streams live Responses reasoning, commentary, tools, usage and trailing subscription data without errors",
    () =>
      Effect.gen(function* () {
        const aisdk = yield* AISDK.Service
        const sent: Record<string, unknown>[] = []
        const response = { id: "resp_live", created_at: 1_788_307_200, model: row.id }
        const reasoning = {
          type: "reasoning",
          id: "rs_fixture:rs_nested",
          encrypted_content: "encrypted-fixture",
          summary: [],
        }
        const text = { type: "output_text", text: "Working now", annotations: [] }
        const message = { type: "message", id: "msg_live", role: "assistant", phase: "commentary", content: [text] }
        const call = {
          type: "function_call",
          id: "fc_live",
          call_id: "call_live",
          name: "read_file",
          status: "completed",
          arguments: '{"path":"file.txt"}',
        }
        const events = [
          { type: "response.created", response },
          { type: "response.in_progress", response },
          { type: "response.output_item.added", output_index: 0, item: reasoning },
          { type: "response.output_item.done", output_index: 0, item: reasoning },
          { type: "response.output_item.added", output_index: 1, item: { ...message, content: [] } },
          {
            type: "response.content_part.added",
            item_id: message.id,
            output_index: 1,
            content_index: 0,
            part: { ...text, text: "" },
          },
          {
            type: "response.output_text.delta",
            item_id: message.id,
            output_index: 1,
            content_index: 0,
            delta: "Working ",
          },
          { type: "response.output_text.delta", item_id: message.id, output_index: 1, content_index: 0, delta: "now" },
          {
            type: "response.output_text.done",
            item_id: message.id,
            output_index: 1,
            content_index: 0,
            text: text.text,
          },
          { type: "response.content_part.done", item_id: message.id, output_index: 1, content_index: 0, part: text },
          { type: "response.output_item.done", output_index: 1, item: message },
          { type: "response.output_item.added", output_index: 2, item: { ...call, arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: call.id, output_index: 2, delta: '{"path":' },
          { type: "response.function_call_arguments.delta", item_id: call.id, output_index: 2, delta: '"file.txt"}' },
          {
            type: "response.function_call_arguments.done",
            item_id: call.id,
            output_index: 2,
            arguments: call.arguments,
          },
          { type: "response.output_item.done", output_index: 2, item: call },
          {
            type: "response.completed",
            response: {
              ...response,
              status: "completed",
              incomplete_details: null,
              output: [reasoning, message, call],
              usage: {
                input_tokens: 100,
                input_tokens_details: { cached_tokens: 60 },
                output_tokens: 20,
                output_tokens_details: { reasoning_tokens: 12 },
                total_tokens: 120,
              },
            },
          },
          {
            type: "response.subscription_usage",
            subscription: {
              tier: "27681527378179523",
              weekly: { resets_at: 1792368000, used_percent: 0 },
              window: { resets_at: 1791876076, used_percent: 0, window_duration_mins: 300 },
            },
          },
        ]
        yield* addPlugin(
          http(() => Response.json({ data: [] })),
          async (_input, init) => {
            sent.push(decodeRequestBody(await new Response(init?.body).json()))
            return new Response(
              events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
              { headers: { "Content-Type": "text/event-stream" } },
            )
          },
        )
        const saved = yield* snapshot(Credential.Key.make({ type: "key", key: "direct-key" }))
        const language = yield* aisdk.language(modelInfo({ store: false, reasoningEffort: "high" }), saved)
        const streamed = yield* Effect.tryPromise({
          try: () =>
            language.doStream({
              prompt: [{ role: "user", content: [{ type: "text", text: "Read file" }] }],
              tools: [
                {
                  type: "function",
                  name: "read_file",
                  description: "Read a file",
                  inputSchema: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: ["path"],
                    additionalProperties: false,
                  },
                  strict: false,
                },
              ],
              providerOptions: { openai: { store: false, forceReasoning: true, reasoningEffort: "high" } },
            }),
          catch: (cause) => cause,
        })
        const parts = yield* Effect.promise(async () => {
          const parts = []
          for await (const part of streamed.stream) parts.push(part)
          return parts
        })
        expect(parts.filter((part) => part.type === "error")).toEqual([])
        expect(
          parts
            .filter((part) => part.type === "text-delta")
            .map((part) => part.delta)
            .join(""),
        ).toBe("Working now")
        expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
          toolCallId: "call_live",
          toolName: "read_file",
          input: '{"path":"file.txt"}',
        })
        expect(parts.find((part) => part.type === "text-start")).toMatchObject({
          providerMetadata: { openai: { itemId: "msg_live", phase: "commentary" } },
        })
        expect(parts.find((part) => part.type === "reasoning-end")).toMatchObject({
          providerMetadata: {
            openai: { itemId: "rs_fixture:rs_nested", reasoningEncryptedContent: "encrypted-fixture" },
          },
        })
        expect(parts.find((part) => part.type === "finish")).toMatchObject({
          finishReason: { unified: "tool-calls" },
          usage: {
            inputTokens: { total: 100, noCache: 40, cacheRead: 60 },
            outputTokens: { total: 20, text: 8, reasoning: 12 },
          },
        })
        expect(sent[0]?.tools).toEqual([
          {
            type: "function",
            name: "read_file",
            description: "Read a file",
            strict: false,
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            },
          },
        ])
        expect(sent[0]?.temperature).toBeUndefined()
        expect(sent[0]?.top_p).toBeUndefined()
      }),
  )

  it.effect("retains Meta thoughts as reasoning and replays encrypted reasoning through the runtime adapter", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const requests: { headers: Headers; body: Record<string, unknown> }[] = []
      const client = http(() => Response.json({ data: [row] }))
      yield* addPlugin(client, async (_input, init) => {
        requests.push({
          headers: new Headers(init?.headers),
          body: decodeRequestBody(await new Response(init?.body).json()),
        })
        return streamResponse()
      })
      const registry = yield* PluginRegistry.Service
      const host = yield* PluginHost.make(registry)
      yield* OpenAIPlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, client))
      const saved = yield* snapshot(Credential.Key.make({ type: "key", key: "direct-key" }))
      const models = yield* discoverMuseModels(client, { api_key: "direct-key", base_url: "https://api.meta.ai/v1" })
      const model = yield* SessionRunnerModel.fromCatalogModel(
        models[0],
        saved.value,
        { loadAISDK: aisdk.model },
        saved.connection,
        saved,
      )
      const runtime = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer))
      const first = yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" })).pipe(Effect.provide(runtime))
      expect(first.text).toBe("Hello")
      expect(first.reasoning).toBe("Thought")
      expect(first.message.content).toContainEqual(
        expect.objectContaining({
          type: "reasoning",
          text: "Thought",
          providerMetadata: { openai: { itemId: "reason_fixture", reasoningEncryptedContent: "encrypted-fixture" } },
        }),
      )
      yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [{ role: "user", content: "Hello" }, first.message, { role: "user", content: "Continue" }],
        }),
      ).pipe(Effect.provide(runtime))
      expect(requests).toHaveLength(2)
      expect(requests[0]?.body).toMatchObject({
        store: false,
        reasoning: { effort: "high", summary: "auto" },
        include: ["reasoning.encrypted_content"],
      })
      expect(requests[1]?.body.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: [{ type: "input_text", text: "Hello" }] }),
          expect.objectContaining({ type: "reasoning", encrypted_content: "encrypted-fixture" }),
          expect.objectContaining({ role: "user", content: [{ type: "input_text", text: "Continue" }] }),
        ]),
      )
      expect(requests[1]?.body.previous_response_id).toBeUndefined()
      expect(requests.every((request) => request.headers.get("authorization") === "Bearer direct-key")).toBe(true)
    }),
  )

  it.effect("registers account, key and environment methods without models before a connection", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      yield* addPlugin(
        http(() => {
          throw new Error("No network without a connection")
        }),
      )
      expect(yield* integrations.get(integrationID)).toMatchObject({
        name: "Muse (Meta)",
        methods: [
          { id: "device", type: "oauth", label: "Meta Muse Code account", remote: true },
          { type: "key", label: "Meta Model API key" },
          { type: "env", names: ["META_API_KEY"] },
        ],
      })
      expect(yield* catalog.provider.get(providerID)).toMatchObject({
        name: "Muse (Meta)",
        integrationID,
        package: "aisdk:@ai-sdk/openai",
      })
      expect((yield* catalog.model.all()).filter((model) => model.providerID === providerID)).toEqual([])
    }),
  )

  it.effect("discovers META_API_KEY models on startup inside a state batch without mint", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const discovered = yield* Deferred.make<void>()
      const previous = process.env.META_API_KEY
      process.env.META_API_KEY = "environment-key"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.META_API_KEY
          else process.env.META_API_KEY = previous
        }),
      )
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          expect(request.url).toBe("https://api.meta.ai/muse-code/models")
          expect(request.headers.authorization).toBe("Bearer environment-key")
          yield* Deferred.succeed(discovered, undefined)
          return HttpClientResponse.fromWeb(request, Response.json({ data: [row] }))
        }),
      )
      const sent: string[] = []
      yield* State.batch(
        addPlugin(client, async (_input, init) => {
          sent.push(new Headers(init?.headers).get("authorization")!)
          return streamResponse()
        }),
      )
      yield* TestClock.adjust("500 millis")
      yield* Deferred.await(discovered)
      yield* TestClock.adjust("500 millis")
      expect(yield* catalog.model.get(providerID, CatalogModel.ID.make(row.id))).toMatchObject({
        name: metadata.name,
      })
      const aisdk = yield* AISDK.Service
      const saved: Integration.Snapshot = {
        connection: { type: "env", name: "META_API_KEY" },
        value: Credential.Key.make({ type: "key", key: "environment-key" }),
      }
      yield* inference(aisdk, modelInfo({ apiKey: "environment-key" }), saved)
      expect(sent).toEqual(["Bearer environment-key"])
    }),
  )

  it.effect("syncs per-profile inventories on connection changes and reconciliation without cross-account keys", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const discovered = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
      const requests: string[] = []
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request.headers.authorization)
          yield* Deferred.succeed(discovered[Math.min(requests.length - 1, 1)], undefined)
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: [{ ...row, id: request.headers.authorization === "Bearer first" ? "first-model" : "second-model" }],
            }),
          )
        }),
      )
      yield* State.batch(addPlugin(client))
      yield* integrations.connection.key({ integrationID, key: "first", label: "First" })
      yield* Deferred.await(discovered[0])
      yield* TestClock.adjust("500 millis")
      const first = (yield* credentials.list(integrationID))[0]
      const second = yield* credentials.create({
        integrationID,
        label: "Second",
        value: Credential.Key.make({ type: "key", key: "second" }),
      })
      yield* TestClock.adjust("60 seconds")
      yield* Deferred.await(discovered[1])
      yield* TestClock.adjust("500 millis")
      const firstSnapshot = yield* integrations.connection.snapshot({
        type: "credential",
        id: first.id,
        label: first.label,
        active: false,
      })
      const secondSnapshot = yield* integrations.connection.snapshot({
        type: "credential",
        id: second.id,
        label: second.label,
        active: true,
      })
      expect(yield* catalog.model.forConnection(modelInfo(), firstSnapshot)).toBeUndefined()
      expect(
        yield* catalog.model.forConnection(
          CatalogModel.Info.empty(providerID, CatalogModel.ID.make("first-model")),
          firstSnapshot,
        ),
      ).toMatchObject({ id: "first-model" })
      expect(
        yield* catalog.model.forConnection(
          CatalogModel.Info.empty(providerID, CatalogModel.ID.make("first-model")),
          secondSnapshot,
        ),
      ).toBeUndefined()
      expect(
        yield* catalog.model.forConnection(
          CatalogModel.Info.empty(providerID, CatalogModel.ID.make("second-model")),
          secondSnapshot,
        ),
      ).toMatchObject({ id: "second-model" })
    }),
  )

  for (const failure of ["once", "always", "never"] as const)
    it.effect(`uses real Responses SDK with full replay, shared options, and bounded 401 remint (${failure})`, () =>
      Effect.gen(function* () {
        const aisdk = yield* AISDK.Service
        let mints = 0
        const client = http((request) =>
          request.url.endsWith("/key")
            ? Response.json({ api_key: `minted-${++mints}`, base_url: "https://api.meta.ai/v1" })
            : Response.json({ data: [row] }),
        )
        const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
        const send = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          requests.push({
            url: input instanceof URL ? input.href : typeof input === "string" ? input : input.url,
            headers: new Headers(init?.headers),
            body: decodeRequestBody(await new Response(init?.body).json()),
          })
          return failure === "always" || (failure === "once" && requests.length === 1)
            ? Response.json({ error: { message: "rejected" } }, { status: 401 })
            : streamResponse()
        }
        yield* addPlugin(client, send)
        const saved = yield* snapshot(account())
        const models = yield* discoverMuseModels(client, { api_key: "fixture", base_url: "https://api.meta.ai/v1" })
        const model = CatalogModel.Info.make({
          ...models[0],
          settings: { ...models[0].settings, reasoningEffort: "low" },
        })
        if (failure === "always") {
          const result = yield* inference(aisdk, model, saved).pipe(Effect.flip)
          expect(String(result)).toContain("log in again")
          expect(requests).toHaveLength(2)
        }
        if (failure !== "always") {
          const key = yield* inference(aisdk, model, saved)
          yield* inference(aisdk, model, saved)
          expect(requests).toHaveLength(failure === "once" ? 3 : 2)
          expect(requests[0]?.body.prompt_cache_key).toBe(key)
        }
        expect(mints).toBe(failure === "never" ? 1 : 2)
        expect(requests[0]?.headers.get("authorization")).toBe("Bearer minted-1")
        expect(requests.at(-1)?.headers.get("authorization")).toBe(`Bearer minted-${mints}`)
        for (const request of requests) {
          expect(request.url).toBe("https://api.meta.ai/v1/responses")
          expect(request.headers.get("x-client-id")).toBe("tbh:exec")
          expect(request.headers.get("x-tbh-session-id")).toMatch(/^[0-9a-f-]{36}$/)
          expect(request.headers.get("x-meta-ai-gateway-session-id")).toBe(request.headers.get("x-tbh-session-id"))
          expect(request.body).toMatchObject({
            store: false,
            include: ["reasoning.encrypted_content"],
            reasoning: { effort: "low", summary: "auto" },
            input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
          })
          expect(request.body.previous_response_id).toBeUndefined()
        }
        expect(new Set(requests.map((request) => request.headers.get("x-tbh-session-id"))).size).toBe(1)
      }),
    )

  it.effect("shares one lazy mint across concurrent models and invalidates it on credential generation", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const credentials = yield* Credential.Service
      let mints = 0
      yield* addPlugin(
        http((request) =>
          request.url.endsWith("/key")
            ? Response.json({ api_key: `key-${++mints}`, base_url: "https://api.meta.ai/v1" })
            : Response.json({ data: [] }),
        ),
        async () => streamResponse(),
      )
      const saved = yield* snapshot(account())
      const model = modelInfo({ store: false, reasoningEffort: "high" })
      yield* Effect.all(
        [
          inference(aisdk, model, saved),
          inference(aisdk, CatalogModel.Info.make({ ...model, id: CatalogModel.ID.make("alias") }), saved),
        ],
        { concurrency: "unbounded" },
      )
      expect(mints).toBe(1)
      yield* credentials.update(saved.credential!.id, {
        value: Credential.OAuth.make({ ...account(), access: "replacement-access" }),
      })
      const integrations = yield* Integration.Service
      const updated = yield* integrations.connection.snapshot(saved.connection)
      yield* inference(aisdk, model, updated)
      expect(mints).toBe(2)
    }),
  )
})
