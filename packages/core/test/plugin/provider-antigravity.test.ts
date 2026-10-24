import { describe, expect, test } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { LLM, ToolDefinition } from "@ycoding-ai/ai"
import { LLMClient } from "@ycoding-ai/ai/route"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { CatalogModel } from "@ycoding-ai/core/model"
import { ProviderPlugins } from "@ycoding-ai/core/plugin/provider"
import {
  AntigravityPlugin,
  antigravityOAuth,
  antigravityUserAgent,
  createAntigravityFetch,
  discoverAntigravityModels,
  discoverAntigravityProject,
  exchangeAntigravityCode,
} from "@ycoding-ai/core/plugin/provider/antigravity"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const http = (respond: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  HttpClient.make((request) => Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request))))
const body = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected encoded body")
  return new TextDecoder().decode(request.body.body)
}
const account = (metadata?: Record<string, unknown>) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("google"),
    access: "google-access",
    refresh: "google-refresh",
    expires: 0,
    ...(metadata ? { metadata } : {}),
  })

describe("AntigravityPlugin", () => {
  test("is registered as a built-in provider plugin with the installed client identity", () => {
    expect(ProviderPlugins.some((plugin) => plugin.id === "ycoding.provider.antigravity")).toBe(true)
    expect(AntigravityPlugin.id).toBe("ycoding.provider.antigravity")
    expect(antigravityUserAgent()).toStartWith("antigravity/hub/2.26.0 (aidev_client; os_type=")
  })

  it.effect("exchanges an authorization code for Google OAuth tokens", () =>
    Effect.gen(function* () {
      let seen: HttpClientRequest.HttpClientRequest | undefined
      const client = http((request) => {
        seen = request
        return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 })
      })
      const credential = yield* exchangeAntigravityCode(client, "code-1", "verifier-1")
      expect(seen?.url).toBe("https://oauth2.googleapis.com/token")
      const form = new URLSearchParams(body(seen!))
      expect(form.get("grant_type")).toBe("authorization_code")
      expect(form.get("code")).toBe("code-1")
      expect(form.get("code_verifier")).toBe("verifier-1")
      expect(form.get("redirect_uri")).toBe("http://localhost:51121/oauth-callback")
      expect(form.get("client_id")).toEndWith(".apps.googleusercontent.com")
      expect(credential.access).toBe("access-1")
      expect(credential.refresh).toBe("refresh-1")
      expect(credential.expires).toBeGreaterThan(0)
    }),
  )

  it.effect("refresh preserves the stored project and refresh token when Google omits rotation", () =>
    Effect.gen(function* () {
      let seen: HttpClientRequest.HttpClientRequest | undefined
      const client = http((request) => {
        seen = request
        return Response.json({ access_token: "access-2", expires_in: 3600 })
      })
      const refreshed = yield* antigravityOAuth(client).refresh!(account({ projectID: "project-1" }))
      const form = new URLSearchParams(body(seen!))
      expect(form.get("grant_type")).toBe("refresh_token")
      expect(form.get("refresh_token")).toBe("google-refresh")
      expect(refreshed.access).toBe("access-2")
      expect(refreshed.refresh).toBe("google-refresh")
      expect(refreshed.metadata).toEqual({ projectID: "project-1" })
    }),
  )

  it.effect("discovers the managed project from loadCodeAssist", () =>
    Effect.gen(function* () {
      let seen: HttpClientRequest.HttpClientRequest | undefined
      const client = http((request) => {
        seen = request
        return Response.json({ cloudaicompanionProject: "project-9", currentTier: { id: "free-tier" } })
      })
      const project = yield* discoverAntigravityProject(client, "google-access")
      expect(project).toBe("project-9")
      expect(seen?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
      expect(seen?.headers.authorization).toBe("Bearer google-access")
      expect(seen?.headers["user-agent"]).toStartWith("antigravity/hub/2.26.0")
      expect(JSON.parse(body(seen!))).toEqual({ metadata: { ideType: "ANTIGRAVITY" } })
    }),
  )

  it.effect("onboards the default tier when loadCodeAssist has no project", () =>
    Effect.gen(function* () {
      const seen: HttpClientRequest.HttpClientRequest[] = []
      const client = http((request) => {
        seen.push(request)
        if (request.url.endsWith(":loadCodeAssist"))
          return Response.json({ allowedTiers: [{ id: "standard-tier", isDefault: true }] })
        return Response.json({ done: true, response: { cloudaicompanionProject: { id: "project-7" } } })
      })
      const project = yield* discoverAntigravityProject(client, "google-access")
      expect(project).toBe("project-7")
      expect(seen[1]?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser")
      expect(JSON.parse(body(seen[1]!))).toEqual({
        tier_id: "standard-tier",
        metadata: { ide_type: "ANTIGRAVITY", ide_version: "2.26.0", ide_name: "antigravity" },
      })
    }),
  )

  it.effect("discovers selectable models with limits, capabilities, and reported thinking defaults", () =>
    Effect.gen(function* () {
      let seen: HttpClientRequest.HttpClientRequest | undefined
      const client = http((request) => {
        seen = request
        return Response.json({
          models: {
            "gemini-fixture": {
              displayName: "Gemini Fixture",
              maxTokens: 1_000_000,
              maxOutputTokens: 65_536,
              supportsImages: true,
              supportsThinking: true,
              supportsVideo: true,
              supportsPdf: true,
              quotaInfo: { remainingFraction: 0.5 },
            },
            "claude-fixture": { displayName: "Claude Fixture", maxTokens: 200_000, supportsImages: false },
            "disabled-fixture": { displayName: "Off", maxTokens: 1000, disabled: true },
            "internal-fixture": { displayName: "Internal", maxTokens: 1000, isInternal: true },
            "old-fixture": { displayName: "Old", maxTokens: 1000 },
            "unlimited-fixture": { displayName: "No limit reported" },
            "gemini-image-fixture": { displayName: "Gemini Image Fixture", maxTokens: 32_000, supportsImages: true },
          },
          deprecatedModelIds: { "old-fixture": { newModelId: "gemini-fixture" } },
        })
      })
      const models = yield* discoverAntigravityModels(client, "google-access", "project-1")
      expect(seen?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels")
      expect(JSON.parse(body(seen!))).toEqual({ project: "project-1" })
      expect(models.map((model) => String(model.id))).toEqual([
        "claude-fixture",
        "gemini-fixture",
        "gemini-image-fixture",
        "unlimited-fixture",
      ])
      const gemini = models.find((model) => model.id === "gemini-fixture")!
      expect(gemini.name).toBe("Gemini Fixture")
      expect(gemini.package).toBe(Provider.aisdk("@ai-sdk/google"))
      expect(gemini.limit).toEqual({ context: 1_000_000, output: 65_536 })
      expect(gemini.capabilities.input).toEqual(["text", "image", "video", "pdf"])
      expect(gemini.variants).toEqual([])
      expect(gemini.settings).toEqual({ thinkingConfig: { includeThoughts: true } })
      const claude = models.find((model) => model.id === "claude-fixture")!
      expect(claude.limit).toEqual({ context: 200_000, output: 8_192 })
      expect(claude.capabilities.input).not.toContain("image")
      expect(claude.variants).toEqual([])
      const image = models.find((model) => model.id === "gemini-image-fixture")!
      expect(image.capabilities.output).toContain("image")
      expect(image.capabilities.tools).toBe(false)
      const unlimited = models.find((model) => model.id === "unlimited-fixture")!
      expect(unlimited.limit.context).toBe(0)
    }),
  )

  it.effect("pivots advertised effort models into one catalog model with effort variants", () =>
    Effect.gen(function* () {
      const entries = {
        "gemini-4-argon-low": { displayName: "Gemini 4 Argon (Low)", thinkingLevel: 1 },
        "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)", thinkingLevel: 2, thinkingBudget: -1 },
        "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", thinkingLevel: 3 },
        "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", thinkingBudget: 1000 },
        "gemini-3.8-flash-medium": { displayName: "Gemini 3.8 Flash (Medium)", thinkingBudget: 4000 },
        "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", thinkingBudget: -1 },
        "claude-sonnet-5-5-low": { displayName: "Claude Sonnet 5.5 (Low)", thinkingLevel: 1 },
        "claude-sonnet-5-5-max": { displayName: "Claude Sonnet 5.5 (Max)", thinkingLevel: 3 },
        "gemini-3.1-pro-high": { displayName: "Gemini 3.1 Pro (High)", thinkingLevel: 3 },
        "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro", thinkingBudget: 1024 },
      }
      const models = yield* discoverAntigravityModels(
        http(() =>
          Response.json({
            models: Object.fromEntries(
              Object.entries(entries).map(([id, entry]) => [id, { ...entry, supportsThinking: true }]),
            ),
          }),
        ),
        "google-access",
        "project-1",
      )
      expect(models.map((model) => String(model.id))).toEqual([
        "claude-sonnet-5-5",
        "gemini-2.5-pro",
        "gemini-3.1-pro-high",
        "gemini-3.8-flash",
        "gemini-4-argon",
      ])
      const argon = models.find((model) => model.id === "gemini-4-argon")!
      expect(argon.name).toBe("Gemini 4 Argon")
      expect(String(argon.modelID)).toBe("gemini-4-argon-medium")
      expect(argon.settings).toEqual({ thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } })
      expect(argon.variants?.map((variant) => String(variant.id))).toEqual(["low", "medium", "high"])
      expect(argon.variants?.find((variant) => variant.id === "high")?.settings).toEqual({
        thinkingConfig: { includeThoughts: true, thinkingLevel: "high" },
        antigravityModelID: "gemini-4-argon-high",
      })
      expect(argon.variants?.find((variant) => variant.id === "low")?.settings).toEqual({
        thinkingConfig: { includeThoughts: true, thinkingLevel: "low" },
        antigravityModelID: "gemini-4-argon-low",
      })
      const flash = models.find((model) => model.id === "gemini-3.8-flash")!
      expect(flash.name).toBe("Gemini 3.8 Flash")
      expect(String(flash.modelID)).toBe("gemini-3.8-flash-medium")
      expect(flash.settings).toEqual({ thinkingConfig: { includeThoughts: true, thinkingBudget: 4000 } })
      for (const [variant, budget, gateway] of [
        ["low", 1000, "gemini-3.8-flash-low"],
        ["medium", 4000, "gemini-3.8-flash-medium"],
        ["high", -1, "gemini-3.8-flash-high"],
      ] as const)
        expect(flash.variants?.find((item) => item.id === variant)?.settings).toEqual({
          thinkingConfig: { includeThoughts: true, thinkingBudget: budget },
          antigravityModelID: gateway,
        })
      const sonnet = models.find((model) => model.id === "claude-sonnet-5-5")!
      expect(sonnet.name).toBe("Claude Sonnet 5.5")
      expect(String(sonnet.modelID)).toBe("claude-sonnet-5-5-low")
      expect(sonnet.variants?.map((variant) => String(variant.id))).toEqual(["low", "max"])
      expect(sonnet.variants?.find((variant) => variant.id === "max")?.settings).toEqual({
        thinkingConfig: { includeThoughts: true, thinkingLevel: "high" },
        antigravityModelID: "claude-sonnet-5-5-max",
      })
      const single = models.find((model) => model.id === "gemini-3.1-pro-high")!
      expect(single.name).toBe("Gemini 3.1 Pro (High)")
      expect(single.variants).toEqual([])
      expect(single.settings).toEqual({ thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } })
      const pro = models.find((model) => model.id === "gemini-2.5-pro")!
      expect(pro.variants).toEqual([])
      expect(pro.settings).toEqual({ thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 } })
    }),
  )

  test("catalog thinking settings reach the SDK wire while text, tools, signatures, and cached usage survive unwrapping", async () => {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
    const models = await Effect.runPromise(
      discoverAntigravityModels(
        http(() =>
          Response.json({
            models: {
              "gemini-3.8-flash-low": {
                displayName: "Gemini 3.8 Flash (Low)",
                supportsThinking: true,
                thinkingBudget: 1000,
              },
              "gemini-3.8-flash-medium": {
                displayName: "Gemini 3.8 Flash (Medium)",
                supportsThinking: true,
                thinkingBudget: 4000,
              },
              "gemini-3.8-flash-high": {
                displayName: "Gemini 3.8 Flash (High)",
                supportsThinking: true,
                thinkingBudget: -1,
              },
            },
          }),
        ),
        "google-access",
        "project-1",
      ),
    )
    const sent: Record<string, unknown>[] = []
    const sdk = createGoogleGenerativeAI({
      apiKey: "placeholder",
      fetch: Object.assign(
        createAntigravityFetch(
          async (_input, init) => {
            if (typeof init?.body !== "string") throw new Error("Expected JSON request body")
            sent.push(JSON.parse(init.body))
            const chunks = [
              { candidates: [{ content: { role: "model", parts: [{ text: "Checking", thought: true }] } }] },
              {
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [
                        { text: "Ready" },
                        {
                          functionCall: { name: "lookup", args: { query: "fixture" } },
                          thoughtSignature: "synthetic-signature",
                        },
                      ],
                    },
                    finishReason: "STOP",
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 120,
                  cachedContentTokenCount: 100,
                  candidatesTokenCount: 5,
                  thoughtsTokenCount: 2,
                },
              },
            ]
            return new Response(chunks.map((response) => `data: ${JSON.stringify({ response })}\n\n`).join(""), {
              headers: { "content-type": "text/event-stream" },
            })
          },
          { access: "google-access", project: "project-1" },
        ),
        { preconnect: fetch.preconnect },
      ),
    })
    const prepared = await Effect.runPromise(
      Effect.gen(function* () {
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          event.sdk = sdk
        })
        const model = yield* SessionRunnerModel.fromCatalogModel(models[0], undefined, { loadAISDK: aisdk.model })
        return yield* LLMClient.prepare<LanguageModelV3CallOptions>(
          LLM.request({
            model,
            prompt: "Look up fixture",
            tools: [
              ToolDefinition.make({
                name: "lookup",
                description: "Look up a fixture",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              }),
            ],
          }),
        )
      }).pipe(Effect.scoped, Effect.provide(AISDK.locationLayer)),
    )
    const result = await sdk.languageModel(models[0].modelID ?? models[0].id).doStream(prepared.body)
    const events = await Array.fromAsync(result.stream)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.model).toBe("gemini-3.8-flash-medium")
    expect(sent[0]?.request).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "Look up fixture" }] }],
      generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 4000 } },
    })
    expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "Ready" }))
    expect(events).toContainEqual(expect.objectContaining({ type: "reasoning-delta", delta: "Checking" }))
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        toolName: "lookup",
        input: '{"query":"fixture"}',
        providerMetadata: { google: { thoughtSignature: "synthetic-signature" } },
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "finish",
        usage: {
          inputTokens: { total: 120, noCache: 20, cacheRead: 100, cacheWrite: undefined },
          outputTokens: { total: 7, text: 5, reasoning: 2 },
          raw: { promptTokenCount: 120, cachedContentTokenCount: 100, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
        },
      }),
    )
  })

  test("variant settings reach the SDK wire and the fetch wrap routes the variant gateway model", async () => {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
    const models = await Effect.runPromise(
      discoverAntigravityModels(
        http(() =>
          Response.json({
            models: {
              "gemini-3.8-flash-low": {
                displayName: "Gemini 3.8 Flash (Low)",
                supportsThinking: true,
                thinkingBudget: 1000,
              },
              "gemini-3.8-flash-medium": {
                displayName: "Gemini 3.8 Flash (Medium)",
                supportsThinking: true,
                thinkingBudget: 4000,
              },
              "gemini-3.8-flash-high": {
                displayName: "Gemini 3.8 Flash (High)",
                supportsThinking: true,
                thinkingBudget: -1,
              },
            },
          }),
        ),
        "google-access",
        "project-1",
      ),
    )
    const selected = await Effect.runPromise(
      SessionRunnerModel.withVariant(models[0], CatalogModel.VariantID.make("low")),
    )
    const gatewayModel = selected.settings?.antigravityModelID
    expect(gatewayModel).toBe("gemini-3.8-flash-low")
    const sent: Record<string, unknown>[] = []
    const sdk = createGoogleGenerativeAI({
      apiKey: "placeholder",
      fetch: Object.assign(
        createAntigravityFetch(
          async (_input, init) => {
            if (typeof init?.body !== "string") throw new Error("Expected JSON request body")
            sent.push(JSON.parse(init.body))
            return new Response(
              `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "Ready" }] }, finishReason: "STOP" }] } })}\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            )
          },
          { access: "google-access", project: "project-1", model: String(gatewayModel) },
        ),
        { preconnect: fetch.preconnect },
      ),
    })
    const prepared = await Effect.runPromise(
      Effect.gen(function* () {
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          event.sdk = sdk
        })
        const model = yield* SessionRunnerModel.fromCatalogModel(selected, undefined, { loadAISDK: aisdk.model })
        return yield* LLMClient.prepare<LanguageModelV3CallOptions>(LLM.request({ model, prompt: "Hello" }))
      }).pipe(Effect.scoped, Effect.provide(AISDK.locationLayer)),
    )
    const result = await sdk.languageModel(selected.modelID ?? selected.id).doStream(prepared.body)
    const events = await Array.fromAsync(result.stream)
    expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "Ready" }))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.model).toBe("gemini-3.8-flash-low")
    expect(sent[0]?.request).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 } },
    })
    expect(JSON.stringify(sent[0]?.request)).not.toContain("antigravityModelID")
  })

  test("fetch wrap strips trailing model contents before the gateway envelope", async () => {
    let sent: Record<string, unknown> | undefined
    const wrapped = createAntigravityFetch(
      async (_input, init) => {
        sent = JSON.parse(String(init?.body))
        return Response.json({ response: { candidates: [] } })
      },
      { access: "google-access", project: "project-1" },
    )
    await wrapped("https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture:generateContent", {
      method: "POST",
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: "Hello" }] },
          { role: "model", parts: [{ text: "Draft" }] },
        ],
      }),
    })
    expect(sent?.request).toEqual({ contents: [{ role: "user", parts: [{ text: "Hello" }] }] })
  })

  test("fetch wrap rewrites the Gemini request into the Antigravity envelope and unwraps SSE", async () => {
    let seen: { url: string; init?: RequestInit } | undefined
    const send = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen = { url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init }
      return new Response(
        `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "Hi" }] } }] }, traceId: "t1" })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    const wrapped = createAntigravityFetch(send, { access: "google-access", project: "project-1" })
    const response = await wrapped(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: { "x-goog-api-key": "placeholder", "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Hello" }] }] }),
      },
    )
    expect(seen?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse")
    const headers = new Headers(seen?.init?.headers)
    expect(headers.get("authorization")).toBe("Bearer google-access")
    expect(headers.get("x-goog-api-key")).toBeNull()
    expect(headers.get("user-agent")).toStartWith("antigravity/hub/2.26.0")
    const sent = JSON.parse(String(seen?.init?.body))
    expect(sent.project).toBe("project-1")
    expect(sent.model).toBe("gemini-fixture")
    expect(sent.userAgent).toBe("antigravity")
    expect(sent.requestType).toBe("agent")
    expect(sent.requestId).toStartWith("agent-")
    expect(sent.request).toEqual({ contents: [{ role: "user", parts: [{ text: "Hello" }] }] })
    expect(await response.text()).toBe(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] })}\n\n`,
    )
  })

  test("fetch wrap unwraps non-streaming JSON and passes error responses through", async () => {
    const ok = createAntigravityFetch(
      async () => Response.json({ response: { candidates: [] }, traceId: "t2" }),
      { access: "google-access", project: "project-1" },
    )
    const response = await ok(
      "https://generativelanguage.googleapis.com/v1beta/models/claude-fixture:generateContent",
      { method: "POST", body: JSON.stringify({ contents: [] }) },
    )
    expect(await response.json()).toEqual({ candidates: [] })

    const failing = createAntigravityFetch(
      async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 }),
      { access: "google-access", project: "project-1" },
    )
    const error = await failing(
      "https://generativelanguage.googleapis.com/v1beta/models/claude-fixture:generateContent",
      { method: "POST", body: JSON.stringify({ contents: [] }) },
    )
    expect(error.status).toBe(429)
    expect(await error.json()).toEqual({ error: { message: "quota" } })
  })
})
