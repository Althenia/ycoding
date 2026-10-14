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

test("M3 preserves localhost and remote endpoints for both supported APIs", () => {
  for (const api of ["chat", "responses"] as const)
    for (const baseURL of ["http://localhost:1234/v1", "https://example.test/v1"]) {
      const input = customEndpointConfiguration({
        baseURL,
        api,
        models: [{ id: "model", modelID: "org/model", tools: true }],
      })
      expect(input.providerID).toBe("custom-openai")
      expect(input.endpoint).toEqual({ baseURL, api })
      expect(input.models).toEqual([{ id: "model", modelID: "org/model", tools: true }])
    }
})
