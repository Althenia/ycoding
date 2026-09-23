import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { afterEach, expect, test } from "bun:test"
import { saveCustomEndpoint } from "../src/custom-endpoint-save"

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

test("writes a blank-provider endpoint before registering and connecting its named key profile", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "ycoding-endpoint-flow-"))
  directories.push(configDir)
  const order: string[] = []
  await saveCustomEndpoint(configDir, {
    baseURL: "https://example.test/v1",
    api: "responses",
    apiKey: "secret-must-not-be-written",
    profile: "work",
    models: [{ id: "model" }],
  }, {
    async syncRegistration() {
      const config = parse(await readFile(path.join(configDir, "ycoding.json"), "utf8"))
      expect(config.providers["custom-openai"].package).toBe("aisdk:@ai-sdk/openai-compatible")
      expect(Object.hasOwn(config.providers["custom-openai"], "integrationID")).toBe(false)
      expect(config.providers["custom-openai"].settings.api).toBe("responses")
      expect(JSON.stringify(config)).not.toContain("secret-must-not-be-written")
      order.push("sync")
    },
    registered: (id) => id === "custom-openai",
    async connectKey(input) {
      expect(input).toEqual({ integrationID: "custom-openai", key: "secret-must-not-be-written", label: "work" })
      order.push("connect")
    },
    async activate() { throw new Error("unexpected activation") },
    async refresh() { order.push("refresh") },
  })
  expect(order).toEqual(["sync", "connect", "refresh"])
})

test("refreshes configured provider and model read models before config-only save succeeds", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "ycoding-endpoint-flow-"))
  directories.push(configDir)
  const order: string[] = []
  const result = await saveCustomEndpoint(configDir, {
    baseURL: "https://example.test/v1",
    api: "chat",
    models: [{ id: "unauthed-model" }],
  }, {
    async syncRegistration() { order.push("registration sync") },
    registered: (id) => id === "custom-openai",
    async connectKey() { throw new Error("must not connect") },
    async activate() { throw new Error("must not activate") },
    async refresh() { order.push("read model refresh") },
  })
  expect(result.credentialConnected).toBe(false)
  expect(order).toEqual(["registration sync", "read model refresh"])
})

test("reports a partial save and does not claim success when profile connection fails", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "ycoding-endpoint-flow-"))
  directories.push(configDir)
  await expect(saveCustomEndpoint(configDir, {
    baseURL: "https://example.test/v1",
    api: "chat",
    apiKey: "secret",
    models: [],
  }, {
    async syncRegistration() {},
    registered: () => true,
    async connectKey() { throw new Error("provider returned secret=secret") },
    async activate() {},
    async refresh() {},
  })).rejects.toThrow("Endpoint config saved, but credential profile connection failed")
  expect(await readFile(path.join(configDir, "ycoding.json"), "utf8")).not.toContain("secret")
})

test("bounds registration waiting and skips credential calls when no integration appears", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "ycoding-endpoint-flow-"))
  directories.push(configDir)
  let syncCount = 0
  await expect(saveCustomEndpoint(configDir, {
    baseURL: "https://example.test/v1",
    api: "chat",
    apiKey: "secret",
    models: [],
  }, {
    async syncRegistration() { syncCount += 1 },
    registered: () => false,
    async connectKey() { throw new Error("must not connect") },
    async activate() { throw new Error("must not activate") },
    async refresh() { throw new Error("must not refresh") },
  })).rejects.toThrow("Endpoint config saved, but its integration did not register")
  expect(syncCount).toBe(10)
})
