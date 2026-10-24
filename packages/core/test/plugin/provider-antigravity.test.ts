import { describe, expect, test } from "bun:test"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
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

  it.effect("discovers selectable models with limits, capabilities, and thinking variants", () =>
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
              quotaInfo: { remainingFraction: 0.5 },
            },
            "claude-fixture": { displayName: "Claude Fixture", maxTokens: 200_000, supportsImages: false },
            "disabled-fixture": { displayName: "Off", maxTokens: 1000, disabled: true },
            "unlimited-fixture": { displayName: "No limit reported" },
            "gemini-image-fixture": { displayName: "Gemini Image Fixture", maxTokens: 32_000, supportsImages: true },
          },
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
      expect(gemini.capabilities.input).toContain("image")
      expect(gemini.variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high"])
      expect(gemini.variants[2]?.settings).toEqual({ thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } })
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
