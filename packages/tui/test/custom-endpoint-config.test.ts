import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { afterEach, expect, test } from "bun:test"
import { writeCustomEndpoint } from "../src/custom-endpoint-config"

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

async function directory() {
  const result = await mkdtemp(path.join(os.tmpdir(), "ycoding-endpoint-"))
  directories.push(result)
  return result
}

test("updates the existing JSONC config and preserves settings, models, and comments", async () => {
  const dir = await directory()
  const text = '{\n  // retained\n  "providers": { "custom": {\n    // provider comment\n    "name": "Existing", "settings": { "other": true, "apiKey": "existing-secret" }, "models": { "old": { "name": "Old" } } } },\n  "theme": "dark"\n}\n'
  await writeFile(path.join(dir, "ycoding.jsonc"), text)
  await writeCustomEndpoint(dir, { baseURL: "https://example.test/v1", api: "chat", provider: "custom", catalog: "openai-models", models: [{ id: "new-model" }] })
  const result = await readFile(path.join(dir, "ycoding.jsonc"), "utf8")
  expect(result).toContain("// retained")
  expect(result).toContain("// provider comment")
  expect(parse(result).providers.custom).toEqual({ name: "Existing", package: "aisdk:@ai-sdk/openai-compatible", settings: { other: true, apiKey: "existing-secret", baseURL: "https://example.test/v1", api: "chat" }, models: { old: { name: "Old" }, "new-model": {} }, catalog: { source: "openai-models" } })
  expect(result).toContain('"theme": "dark"')
})

test("updates ycoding.json when it exists and creates it when neither config exists", async () => {
  const dir = await directory()
  await writeFile(path.join(dir, "ycoding.jsonc"), '{"untouched": true}')
  await writeFile(path.join(dir, "ycoding.json"), '{"existing": true}')
  await writeCustomEndpoint(dir, { baseURL: "https://example.test", api: "responses" })
  const written = JSON.parse(await readFile(path.join(dir, "ycoding.json"), "utf8")).providers["custom-openai"]
  expect(written.settings.baseURL).toBe("https://example.test")
  expect(written.settings.api).toBe("responses")
  expect(written.package).toBe("aisdk:@ai-sdk/openai-compatible")
  expect(Object.hasOwn(written, "integrationID")).toBe(false)
  expect(Object.hasOwn(written.settings, "apiKey")).toBe(false)
  expect(await readFile(path.join(dir, "ycoding.jsonc"), "utf8")).toBe('{"untouched": true}')
  const fresh = await directory()
  await writeCustomEndpoint(fresh, { baseURL: "https://example.test", api: "chat" })
  expect(JSON.parse(await readFile(path.join(fresh, "ycoding.json"), "utf8")).providers["custom-openai"].settings.baseURL).toBe("https://example.test")
})

test("rejects malformed existing config without silently replacing it", async () => {
  const dir = await directory()
  const original = "{ invalid"
  await writeFile(path.join(dir, "ycoding.jsonc"), original)
  await expect(writeCustomEndpoint(dir, { baseURL: "https://example.test", api: "chat" })).rejects.toThrow("Unable to parse YCoding config")
  expect(await readFile(path.join(dir, "ycoding.jsonc"), "utf8")).toBe(original)
})

test("rejects malformed provider merge paths without changing config bytes", async () => {
  const cases = [
    { providers: [] },
    { providers: { custom: "invalid" } },
    { providers: { custom: { settings: [] } } },
    { providers: { custom: { models: [] } } },
  ]
  for (const value of cases) {
    const dir = await directory()
    const original = JSON.stringify(value)
    await writeFile(path.join(dir, "ycoding.json"), original)
    await expect(writeCustomEndpoint(dir, { baseURL: "https://example.test", api: "chat", provider: "custom" }))
      .rejects.toThrow("Invalid custom endpoint config structure")
    expect(await readFile(path.join(dir, "ycoding.json"), "utf8")).toBe(original)
  }
})

test("keeps an existing model, catalog, and API key when writing nonsecret endpoint config", async () => {
  const dir = await directory()
  await writeFile(path.join(dir, "ycoding.json"), JSON.stringify({
    providers: {
      custom: {
        settings: { prior: "kept", apiKey: "legacy" },
        catalog: { source: "openai-models" },
        models: { model: { name: "Existing name", family: "Existing family" } },
      },
    },
  }))
  await writeCustomEndpoint(dir, { baseURL: "https://example.test", api: "chat", provider: "custom", models: [{ id: "model" }] })
  const provider = JSON.parse(await readFile(path.join(dir, "ycoding.json"), "utf8")).providers.custom
  expect(provider.models.model).toEqual({ name: "Existing name", family: "Existing family" })
  expect(provider.catalog.source).toBe("openai-models")
  expect(provider.settings.prior).toBe("kept")
  expect(Object.hasOwn(provider.settings, "apiKey")).toBe(true)
  expect(provider.package).toBe("aisdk:@ai-sdk/openai-compatible")
  expect(Object.hasOwn(provider, "integrationID")).toBe(false)
})

test("merges only explicitly set model fields into an existing model", async () => {
  const dir = await directory()
  await writeFile(path.join(dir, "ycoding.json"), JSON.stringify({
    providers: {
      custom: {
        models: {
          model: { name: "Old name", family: "Old family", api: "responses", disabled: true, package: "kept" },
        },
      },
    },
  }))
  await writeCustomEndpoint(dir, {
    baseURL: "https://example.test",
    api: "chat",
    provider: "custom",
    models: [{ id: "model", name: "New name" }, { id: "new-model", family: "reasoning", api: "responses", disabled: false }],
  })
  const result = JSON.parse(await readFile(path.join(dir, "ycoding.json"), "utf8"))
  expect(result.providers.custom.models.model).toEqual({ name: "New name", family: "Old family", api: "responses", disabled: true, package: "kept" })
  expect(result.providers.custom.models["new-model"]).toEqual({ family: "reasoning", api: "responses", disabled: false })
})

test("writes separate Runpod Jobs endpoints and their served model IDs", async () => {
  const dir = await directory()
  await writeCustomEndpoint(dir, { baseURL: "https://api.runpod.ai/v2/ollama123", api: "chat", worker: "ollama", provider: "runpod-ollama", models: [{ id: "ollama-model" }] })
  await writeCustomEndpoint(dir, { baseURL: "https://api.runpod.ai/v2/vllm456", api: "chat", worker: "vllm", provider: "runpod-vllm", models: [{ id: "my-vllm", modelID: "org/served-model", tools: true }] })
  const providers = parse(await readFile(path.join(dir, "ycoding.json"), "utf8")).providers
  expect(providers["runpod-ollama"]).toMatchObject({ package: "@ycoding-ai/ai/providers/runpod", settings: { worker: "ollama", baseURL: "https://api.runpod.ai/v2/ollama123" }, models: { "ollama-model": {} } })
  expect(providers["runpod-vllm"]).toMatchObject({ package: "@ycoding-ai/ai/providers/runpod", settings: { worker: "vllm", baseURL: "https://api.runpod.ai/v2/vllm456" }, models: { "my-vllm": { modelID: "org/served-model", capabilities: { tools: true } } } })
})

test("rejects a Runpod URL outside the Jobs endpoint root before writing credentials or config", async () => {
  const dir = await directory()
  await expect(writeCustomEndpoint(dir, { baseURL: "https://other.example/v2/endpoint", api: "chat", worker: "vllm" }))
    .rejects.toThrow("Runpod Jobs endpoint")
  await expect(access(path.join(dir, "ycoding.json"))).rejects.toMatchObject({ code: "ENOENT" })
})

test("does not replace an unrelated provider with a Runpod endpoint", async () => {
  const dir = await directory()
  const original = JSON.stringify({ providers: { shared: { package: "aisdk:@ai-sdk/openai-compatible" } } })
  await writeFile(path.join(dir, "ycoding.json"), original)
  await expect(writeCustomEndpoint(dir, { baseURL: "https://api.runpod.ai/v2/endpoint", api: "chat", worker: "vllm", provider: "shared" }))
    .rejects.toThrow("different provider package")
  expect(await readFile(path.join(dir, "ycoding.json"), "utf8")).toBe(original)
})
