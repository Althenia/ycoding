import { describe, expect, test } from "bun:test"
import { model } from "@ycoding-ai/ai/providers/openai"

describe("provider package entrypoints", () => {
  test("semantic API aliases expose the same contract", async () => {
    const modules = await Promise.all([
      import("@ycoding-ai/ai/providers/openai"),
      import("@ycoding-ai/ai/providers/openai/responses"),
      import("@ycoding-ai/ai/providers/anthropic"),
      import("@ycoding-ai/ai/providers/anthropic-compatible"),
      import("@ycoding-ai/ai/providers/openai-compatible"),
      import("@ycoding-ai/ai/providers/openai-compatible/responses"),
      import("@ycoding-ai/ai/providers/amazon-bedrock"),
      import("@ycoding-ai/ai/providers/azure"),
      import("@ycoding-ai/ai/providers/azure/responses"),
      import("@ycoding-ai/ai/providers/azure/chat"),
      import("@ycoding-ai/ai/providers/google"),
      import("@ycoding-ai/ai/providers/google-vertex"),
      import("@ycoding-ai/ai/providers/google-vertex/gemini"),
      import("@ycoding-ai/ai/providers/google-vertex/chat"),
      import("@ycoding-ai/ai/providers/google-vertex/responses"),
      import("@ycoding-ai/ai/providers/google-vertex/messages"),
    ])

    for (const module of modules) expect(module.model).toBeFunction()
    expect(modules[0].model).toBe(modules[1].model)
    expect(modules[7].model).toBe(modules[8].model)
    expect(modules[11].model).toBe(modules[12].model)
  })

  test("direct OpenAI exposes only Responses model selectors", async () => {
    const OpenAI = await import("@ycoding-ai/ai/providers/openai")
    const OpenAIChat = await import("@ycoding-ai/ai/providers/openai/chat")

    expect(OpenAI.routes.map((route) => route.id)).toEqual(["openai-responses", "openai-responses-websocket"])
    expect(Object.hasOwn(OpenAI.configure({ apiKey: "fixture" }), "chat")).toBeFalse()
    expect(Object.hasOwn(OpenAIChat, "model")).toBeFalse()
  })

  test("maps package settings onto the executable model", () => {
    const selected = model("gpt-5", {
      apiKey: "fixture",
      baseURL: "https://api.openai.test/v1",
      headers: { "x-application": "ycoding" },
      body: { service_tier: "priority" },
      limits: { context: 200_000, output: 64_000 },
      unrelatedInheritedSetting: true,
    })

    expect(selected.route.id).toBe("openai-responses")
    expect(selected.route.defaults.headers).toEqual({ "x-application": "ycoding" })
    expect(selected.route.defaults.http?.body).toEqual({ service_tier: "priority" })
    expect(selected.route.defaults.limits).toEqual({ context: 200_000, output: 64_000 })
  })

  test("selects transport without changing the semantic API", () => {
    expect(model("gpt-5", { apiKey: "fixture" }).route.id).toBe("openai-responses")
    expect(model("gpt-5", { apiKey: "fixture", transport: "websocket" }).route.id).toBe("openai-responses-websocket")
  })

  test("gives GitHub Copilot dedicated Chat and Responses route IDs", async () => {
    const GitHubCopilot = await import("@ycoding-ai/ai/providers/github-copilot")
    const provider = GitHubCopilot.configure({ baseURL: "https://copilot.example.test", apiKey: "fixture" })

    expect(GitHubCopilot.routes.map((route) => route.id)).toEqual([
      "github-copilot-responses",
      "github-copilot-chat",
    ])
    expect(provider.responses("gpt-5.6").route.id).toBe("github-copilot-responses")
    expect(provider.chat("gpt-4.1").route.id).toBe("github-copilot-chat")
    expect(provider.model("gpt-5.6").route.id).toBe("github-copilot-responses")
    expect(provider.model("gpt-4.1").route.id).toBe("github-copilot-chat")
  })

  test("maps OpenAI-compatible Responses settings onto the executable model", async () => {
    const OpenAICompatibleResponses = await import("@ycoding-ai/ai/providers/openai-compatible/responses")
    const selected = OpenAICompatibleResponses.model("custom-model", {
      apiKey: "fixture",
      baseURL: "https://responses.example.test/v1",
      provider: "example",
      headers: { "x-application": "ycoding" },
      body: { service_tier: "priority" },
      limits: { context: 200_000, output: 64_000 },
      providerOptions: { openai: { reasoningEffort: "low", store: true } },
    })

    expect(String(selected.provider)).toBe("example")
    expect(selected.route.id).toBe("openai-compatible-responses")
    expect(selected.route.endpoint).toMatchObject({
      baseURL: "https://responses.example.test/v1",
      path: "/responses",
    })
    expect(selected.route.defaults.headers).toEqual({ "x-application": "ycoding" })
    expect(selected.route.defaults.http?.body).toEqual({ service_tier: "priority" })
    expect(selected.route.defaults.limits).toEqual({ context: 200_000, output: 64_000 })
    expect(selected.route.defaults.providerOptions).toEqual({
      openai: { reasoningEffort: "low", store: true },
    })
  })

  test("maps Anthropic-compatible settings onto the executable model", async () => {
    const AnthropicCompatible = await import("@ycoding-ai/ai/providers/anthropic-compatible")
    const selected = AnthropicCompatible.model("compatible-model", {
      apiKey: "fixture",
      baseURL: "https://messages.example.test/v1",
      provider: "example",
      headers: { "x-application": "ycoding" },
      body: { metadata: { user_id: "user_1" } },
      limits: { context: 200_000, output: 64_000 },
    })

    expect(String(selected.provider)).toBe("example")
    expect(selected.route.id).toBe("anthropic-messages")
    expect(selected.route.endpoint).toMatchObject({
      baseURL: "https://messages.example.test/v1",
      path: "/messages",
    })
    expect(selected.route.defaults.headers).toEqual({ "x-application": "ycoding" })
    expect(selected.route.defaults.http?.body).toEqual({ metadata: { user_id: "user_1" } })
    expect(selected.route.defaults.limits).toEqual({ context: 200_000, output: 64_000 })
  })

  test("requires an Anthropic-compatible base URL at runtime", async () => {
    const AnthropicCompatible = await import("@ycoding-ai/ai/providers/anthropic-compatible")
    expect(() =>
      Reflect.apply(AnthropicCompatible.model, undefined, ["compatible-model", { apiKey: "fixture" }]),
    ).toThrow("Anthropic-compatible providers require a baseURL")
  })

  test("rejects conflicting Anthropic-compatible auth settings at runtime", async () => {
    const Anthropic = await import("@ycoding-ai/ai/providers/anthropic")
    const AnthropicCompatible = await import("@ycoding-ai/ai/providers/anthropic-compatible")
    expect(() =>
      Reflect.apply(AnthropicCompatible.model, undefined, [
        "compatible-model",
        {
          apiKey: "fixture",
          authToken: "token",
          baseURL: "https://messages.example.test/v1",
        },
      ]),
    ).toThrow("Anthropic-compatible apiKey cannot be combined with authToken")
    expect(() =>
      Reflect.apply(Anthropic.model, undefined, ["claude-sonnet-4-6", { apiKey: "fixture", authToken: "token" }]),
    ).toThrow("Anthropic apiKey cannot be combined with authToken")
  })

  test("maps legacy OpenAI organization and project settings to headers", () => {
    const selected = model("gpt-5", {
      apiKey: "fixture",
      organization: "org_123",
      project: "proj_123",
    })

    expect(selected.route.defaults.headers).toMatchObject({
      "OpenAI-Organization": "org_123",
      "OpenAI-Project": "proj_123",
    })
  })

  test("selects Azure API entrypoints with the same model contract", async () => {
    const Azure = await import("@ycoding-ai/ai/providers/azure")
    const AzureChat = await import("@ycoding-ai/ai/providers/azure/chat")
    const AzureResponses = await import("@ycoding-ai/ai/providers/azure/responses")
    const settings = {
      apiKey: "fixture",
      resourceName: "ycoding-test",
      headers: { "x-application": "ycoding" },
      body: { service_tier: "priority" },
      limits: { context: 200_000, output: 64_000 },
    }

    const responses = AzureResponses.model("deployment", settings)
    const chat = AzureChat.model("deployment", settings)

    expect(Azure.model("deployment", settings).route.id).toBe("azure-openai-responses")
    expect(responses.route.id).toBe("azure-openai-responses")
    expect(responses.route.endpoint.baseURL).toBe("https://ycoding-test.openai.azure.com/openai/v1")
    expect(responses.route.defaults.headers).toEqual({ "x-application": "ycoding" })
    expect(responses.route.defaults.http?.body).toEqual({ service_tier: "priority" })
    expect(responses.route.defaults.limits).toEqual({ context: 200_000, output: 64_000 })
    expect(chat.route.id).toBe("azure-openai-chat")
  })

  test("maps Google package settings onto the Gemini model", async () => {
    const Google = await import("@ycoding-ai/ai/providers/google")
    const selected = Google.model("gemini-2.5-flash", {
      apiKey: "fixture",
      baseURL: "https://generativelanguage.test/v1beta",
      headers: { "x-application": "ycoding" },
      body: { safetySettings: [] },
      limits: { context: 1_000_000, output: 65_536 },
      providerOptions: { gemini: { thinkingConfig: { thinkingBudget: 1_024 } } },
    })

    expect(selected.route.id).toBe("gemini")
    expect(selected.route.endpoint.baseURL).toBe("https://generativelanguage.test/v1beta")
    expect(selected.route.defaults.headers).toEqual({ "x-application": "ycoding" })
    expect(selected.route.defaults.http?.body).toEqual({ safetySettings: [] })
    expect(selected.route.defaults.limits).toEqual({ context: 1_000_000, output: 65_536 })
    expect(selected.route.defaults.providerOptions).toEqual({
      gemini: { thinkingConfig: { thinkingBudget: 1_024 } },
    })
  })

  test("selects Vertex entrypoints with the same model contract", async () => {
    const GoogleVertex = await import("@ycoding-ai/ai/providers/google-vertex")
    const GoogleVertexGemini = await import("@ycoding-ai/ai/providers/google-vertex/gemini")
    const GoogleVertexChat = await import("@ycoding-ai/ai/providers/google-vertex/chat")
    const GoogleVertexResponses = await import("@ycoding-ai/ai/providers/google-vertex/responses")
    const GoogleVertexMessages = await import("@ycoding-ai/ai/providers/google-vertex/messages")
    const gemini = GoogleVertex.model("gemini-3.5-flash", {
      apiKey: "fixture",
      headers: { "x-application": "ycoding" },
      body: { safetySettings: [] },
      limits: { context: 1_000_000, output: 65_536 },
    })
    const messages = GoogleVertexMessages.model("claude-sonnet-4-6", {
      accessToken: "fixture",
      location: "global",
      project: "vertex-project",
    })
    const chat = GoogleVertexChat.model("deepseek-ai/deepseek-v3.2-maas", {
      accessToken: "fixture",
      location: "global",
      project: "vertex-project",
    })
    const responses = GoogleVertexResponses.model("xai/grok-4.20-reasoning", {
      accessToken: "fixture",
      location: "global",
      project: "vertex-project",
    })

    expect(GoogleVertexGemini.model).toBe(GoogleVertex.model)
    expect(gemini.route.id).toBe("google-vertex-gemini")
    expect(gemini.route.protocol).toBe("gemini")
    expect(gemini.route.endpoint.baseURL).toBe("https://aiplatform.googleapis.com/v1/publishers/google")
    expect(gemini.route.defaults.headers).toEqual({ "x-application": "ycoding" })
    expect(gemini.route.defaults.http?.body).toEqual({ safetySettings: [] })
    expect(gemini.route.defaults.limits).toEqual({ context: 1_000_000, output: 65_536 })
    expect(
      GoogleVertex.model("gemini-3.5-flash", {
        accessToken: "fixture",
        location: "eu",
        project: "vertex-project",
      }).route.endpoint.baseURL,
    ).toBe("https://aiplatform.eu.rep.googleapis.com/v1beta1/projects/vertex-project/locations/eu/publishers/google")
    expect(messages.route.id).toBe("google-vertex-messages")
    expect(messages.route.protocol).toBe("anthropic-messages")
    expect(messages.route.endpoint.baseURL).toBe(
      "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/publishers/anthropic/models",
    )
    expect(chat.route.id).toBe("google-vertex-chat")
    expect(chat.route.protocol).toBe("openai-chat")
    expect(chat.route.endpoint).toMatchObject({
      baseURL: "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi",
      path: "/chat/completions",
    })
    expect(responses.route.id).toBe("google-vertex-responses")
    expect(responses.route.protocol).toBe("openai-responses")
    expect(responses.route.endpoint).toMatchObject({
      baseURL: "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi",
      path: "/responses",
    })
    expect(responses.route.defaults.providerOptions).toEqual({ openai: { store: false } })
  })

  test("rejects conflicting Vertex auth settings at runtime", async () => {
    const GoogleVertex = await import("@ycoding-ai/ai/providers/google-vertex")
    const GoogleVertexChat = await import("@ycoding-ai/ai/providers/google-vertex/chat")
    const GoogleVertexMessages = await import("@ycoding-ai/ai/providers/google-vertex/messages")
    const GoogleVertexResponses = await import("@ycoding-ai/ai/providers/google-vertex/responses")
    const Providers = await import("@ycoding-ai/ai/providers")
    expect(() =>
      Reflect.apply(GoogleVertex.model, undefined, [
        "gemini-3.5-flash",
        { accessToken: "token", apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow("Google Vertex apiKey cannot be combined with accessToken or auth")
    const configured = Reflect.apply(GoogleVertex.configure, undefined, [
      { accessToken: "token", auth: {}, project: "vertex-project" },
    ])
    expect(() => configured.model("gemini-3.5-flash")).toThrow("Google Vertex accessToken cannot be combined with auth")
    expect(() =>
      Reflect.apply(GoogleVertexMessages.model, undefined, [
        "claude-sonnet-4-6",
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow("Google Vertex Messages does not support API keys")
    expect(() =>
      Reflect.apply(Providers.GoogleVertexMessages.configure, undefined, [
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow("Google Vertex Messages does not support API keys")
    expect(() =>
      Reflect.apply(GoogleVertexChat.model, undefined, [
        "deepseek-ai/deepseek-v3.2-maas",
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow("Google Vertex Chat does not support API keys")
    expect(() =>
      Reflect.apply(Providers.GoogleVertexChat.configure, undefined, [
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow("Google Vertex Chat does not support API keys")
    expect(() =>
      Reflect.apply(GoogleVertexResponses.model, undefined, [
        "xai/grok-4.20-reasoning",
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow("Google Vertex Responses does not support API keys")
    expect(() =>
      Reflect.apply(Providers.GoogleVertexResponses.configure, undefined, [
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow("Google Vertex Responses does not support API keys")
  })
})
