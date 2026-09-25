import { expect, test } from "bun:test"
import { CopilotModels } from "@ycoding-ai/core/github-copilot/models"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"

test("defensively syncs advertised Copilot models", async () => {
  const requests: Headers[] = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requests.push(request.headers)
      return Response.json({
        data: [
          {
            model_picker_enabled: true,
            id: "gpt-5",
            name: "GPT-5 remote",
            version: "gpt-5-2026-06-01",
            supported_endpoints: ["/responses"],
            billing: {
              token_prices: {
                batch_size: 0,
                default: { input_price: 10, output_price: 20, cache_price: 5 },
              },
            },
            capabilities: {
              family: "gpt-5",
              limits: {
                max_context_window_tokens: 200000,
                max_output_tokens: 16384,
                max_prompt_tokens: 180000,
              },
              supports: { tool_calls: true, reasoning_effort: ["low", "high"] },
            },
          },
          {
            model_picker_enabled: true,
            id: "gpt-5.2-2026-02-01",
            name: "GPT-5.2 dated",
            version: "gpt-5.2-2026-02-01",
            supported_endpoints: ["/responses"],
            capabilities: {
              family: "gpt-5.2",
              limits: { max_output_tokens: 1000, max_prompt_tokens: 180000 },
              supports: { tool_calls: true },
            },
          },
          {
            model_picker_enabled: false,
            id: "utility",
            name: "Utility",
            version: "utility-2026-06-01",
            capabilities: {
              family: "utility",
              limits: { max_output_tokens: 1000, max_prompt_tokens: 8000 },
              supports: { tool_calls: false },
            },
          },
          {
            model_picker_enabled: true,
            id: "gpt-5.4",
            name: "GPT-5.4 remote",
            version: "gpt-5.4",
            supported_endpoints: ["/responses"],
            capabilities: {
              family: "gpt",
              limits: { max_output_tokens: 1000, max_prompt_tokens: 180000 },
              supports: { tool_calls: true },
            },
          },
          {
            model_picker_enabled: true,
            id: "gpt-5.3",
            name: "GPT-5.3 remote",
            version: "gpt-5.3",
            supported_endpoints: ["/responses"],
            capabilities: {
              family: "gpt",
              limits: { max_output_tokens: 1000, max_prompt_tokens: 0 },
              supports: { tool_calls: true },
            },
          },
          {
            model_picker_enabled: true,
            id: "claude-chat",
            name: "Claude Chat",
            version: "claude-chat",
            supported_endpoints: ["/chat/completions"],
            capabilities: {
              family: "claude",
              limits: { max_output_tokens: 1000, max_prompt_tokens: 1000 },
              supports: { tool_calls: true },
            },
          },
          {
            model_picker_enabled: true,
            id: "gpt-4.1",
            name: "GPT-4.1",
            version: "gpt-4.1-2026-06-01",
            supported_endpoints: ["/chat/completions"],
            capabilities: {
              family: "gpt",
              limits: { max_output_tokens: 16000, max_prompt_tokens: 128000 },
              supports: { tool_calls: true },
            },
          },
          {
            model_picker_enabled: true,
            id: "claude-sonnet-4.6",
            name: "Claude Sonnet 4.6",
            version: "claude-sonnet-4.6-2026-06-01",
            supported_endpoints: ["/v1/messages", "/chat/completions"],
            capabilities: {
              family: "claude",
              limits: { max_output_tokens: 32000, max_prompt_tokens: 180000 },
              supports: { tool_calls: true },
            },
          },
          { model_picker_enabled: true, id: "incomplete" },
        ],
      })
    },
  })

  try {
    const existing = ModelV2.Info.make({
      ...ModelV2.Info.empty(ProviderV2.ID.githubCopilot, ModelV2.ID.make("gpt-5")),
      modelID: ModelV2.ID.make("gpt-5"),
      name: "GPT-5 local",
    })
    const stale = ModelV2.Info.make({
      ...ModelV2.Info.empty(ProviderV2.ID.githubCopilot, ModelV2.ID.make("stale")),
      modelID: ModelV2.ID.make("stale"),
    })
    const models = await CopilotModels.get(server.url.origin, {}, [existing, stale])
    const model = models.get(ModelV2.ID.make("gpt-5"))

    expect(requests[0]?.get("Copilot-Integration-Id")).toBe("vscode-chat")
    expect(model?.name).toBe("GPT-5 local")
    expect(model?.settings).toMatchObject({ baseURL: server.url.origin, endpoint: "responses", store: false })
    expect(model?.settings?.contextManagement).toBeUndefined()
    // The official client excludes by model family, so a dated gpt-5.2 id is excluded too.
    expect(models.get(ModelV2.ID.make("gpt-5.2-2026-02-01"))?.settings?.contextManagement).toBeUndefined()
    expect(models.get(ModelV2.ID.make("gpt-5.4"))?.settings?.contextManagement).toEqual([
      { type: "compaction", compactThreshold: 162000 },
    ])
    expect(models.get(ModelV2.ID.make("gpt-5.3"))?.settings?.contextManagement).toEqual([
      { type: "compaction", compactThreshold: 50000 },
    ])
    expect(model?.settings?.include).toEqual(["reasoning.encrypted_content"])
    expect(model?.cost[0]).toMatchObject({ input: 0, output: 0, cache: { read: 0, write: 0 } })
    expect(model?.variants.map((variant) => variant.id)).toEqual([
      ModelV2.VariantID.make("low"),
      ModelV2.VariantID.make("high"),
    ])
    expect(model?.variants).toMatchObject([
      {
        settings: {
          reasoningEffort: "low",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      },
      {
        settings: {
          reasoningEffort: "high",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      },
    ])
    expect(models.get(ModelV2.ID.make("claude-sonnet-4.6"))).toMatchObject({
      package: "aisdk:@ai-sdk/anthropic",
      settings: {
        baseURL: `${server.url.origin}/v1`,
        endpoint: "messages",
        toolStreaming: false,
      },
    })
    expect(models.get(ModelV2.ID.make("gpt-4.1"))?.settings).toEqual({
      baseURL: server.url.origin,
      endpoint: "chat",
    })
    expect(models.get(ModelV2.ID.make("claude-chat"))?.settings).toEqual({
      baseURL: server.url.origin,
      endpoint: "chat",
    })
    expect(models.get(ModelV2.ID.make("utility"))?.enabled).toBe(false)
    expect(models.has(ModelV2.ID.make("stale"))).toBe(false)
    expect(models.has(ModelV2.ID.make("incomplete"))).toBe(false)
  } finally {
    await server.stop(true)
  }
})
