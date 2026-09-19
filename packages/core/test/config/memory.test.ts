import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@ycoding-ai/core/config"

test("R5-E recognizes memory and resolves defaults with ordered field-wise overrides", async () => {
  const decoded = Schema.decodeUnknownSync(Config.Info)({ memory: { enabled: false } })
  expect(decoded).toHaveProperty("memory", { enabled: false })
  const { ConfigMemory } = await import("@ycoding-ai/core/config/memory")
  expect(ConfigMemory.resolve([])).toEqual({
    enabled: true, max_concept_bytes: 65536, max_bundle_bytes: 8388608, max_concepts: 1000,
  })
  expect(ConfigMemory.resolve([
    new ConfigMemory.Info({ enabled: false, path: "./knowledge", max_concepts: 5 }),
    new ConfigMemory.Info({ enabled: true }),
  ])).toMatchObject({ enabled: true, path: "./knowledge", max_concepts: 5 })
})

test("R5-E rejects invalid known memory settings rather than ignoring them", () => {
  for (const memory of [{ enabled: "yes" }, { path: " " }, { max_concepts: 0 }, { max_concept_bytes: 1.5 }, { max_bundle_bytes: -1 }]) {
    expect(() => Schema.decodeUnknownSync(Config.Info)({ memory })).toThrow()
  }
})
