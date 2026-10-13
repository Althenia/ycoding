import { expect, test } from "bun:test"
import { customEndpointConfiguration } from "../src/custom-endpoint-config"

test("M3 forwards a global backend configuration and never credentials", () => {
  expect(
    customEndpointConfiguration(
      {
        provider: " custom ",
        baseURL: "https://example.test/v1",
        api: "responses",
        apiKey: "synthetic-secret",
        credentialID: "credential",
        profile: "work",
        catalog: "openai-models",
        models: [{ id: "model", tools: true }],
      },
      { directory: "/backend/project" },
    ),
  ).toEqual({
    providerID: "custom",
    scope: "global",
    location: { directory: "/backend/project" },
    endpoint: { baseURL: "https://example.test/v1", api: "responses" },
    catalog: "openai-models",
    models: [{ id: "model", tools: true }],
  })
})

test("M3 selects the endpoint protocol and provider default for each supported worker", () => {
  expect(customEndpointConfiguration({ baseURL: "https://example.test", api: "chat", models: [] })).toMatchObject({
    providerID: "custom-openai",
    endpoint: { baseURL: "https://example.test", api: "chat" },
  })
  for (const worker of ["ollama", "vllm"] as const) {
    const input = customEndpointConfiguration({
      baseURL: "https://api.runpod.ai/v2/endpoint",
      api: "chat",
      worker,
      models: [{ id: "model", modelID: "org/model", tools: true }],
    })
    expect(input.providerID).toBe("runpod")
    expect(input.endpoint).toEqual({ baseURL: "https://api.runpod.ai/v2/endpoint", worker })
    expect(input.models).toEqual([{ id: "model", modelID: "org/model", tools: true }])
  }
})
