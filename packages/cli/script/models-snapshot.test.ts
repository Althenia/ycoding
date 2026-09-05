import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fetchModelsSnapshot, readModelsSnapshot } from "./models-snapshot"

test("reads and validates a models.dev object snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-models-snapshot-"))
  const file = path.join(root, "api.json")
  const text = '{"openrouter":{"name":"OpenRouter","models":{}}}\n'
  try {
    await writeFile(file, text)
    expect(await readModelsSnapshot(file)).toBe(text)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects invalid and non-object snapshots with a clear source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-models-snapshot-"))
  const invalid = path.join(root, "invalid.json")
  const array = path.join(root, "array.json")
  try {
    await writeFile(invalid, "not json")
    await writeFile(array, "[]")
    await expect(readModelsSnapshot(invalid)).rejects.toThrow(`Invalid models.dev snapshot: ${invalid}`)
    await expect(readModelsSnapshot(array)).rejects.toThrow(`Models.dev snapshot must be a JSON object: ${array}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("fetches a bounded validated refresh and rejects non-success responses", async () => {
  const valid = await fetchModelsSnapshot("https://models.test/api.json", async (_input, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    return new Response('{"provider":{"models":{}}}')
  })
  expect(valid).toBe('{"provider":{"models":{}}}')

  await expect(
    fetchModelsSnapshot("https://models.test/api.json", async () => new Response("unavailable", { status: 503 })),
  ).rejects.toThrow("Models.dev refresh failed with status 503")
})

test("committed snapshot contains current OpenAI and Anthropic catalog pricing", async () => {
  const snapshot = JSON.parse(
    await Bun.file(path.join(import.meta.dir, "models-dev.snapshot.json")).text(),
  ) as {
    openai?: {
      models?: Record<
        string,
        {
          limit?: { context?: number; output?: number }
          cost?: {
            input?: number
            output?: number
            cache_read?: number
            cache_write?: number
            tiers?: Array<{
              input?: number
              output?: number
              cache_read?: number
              cache_write?: number
              tier?: { type?: string; size?: number }
            }>
          }
        }
      >
    }
    anthropic?: {
      models?: Record<
        string,
        {
          id?: string
          reasoning_options?: Array<{ type?: string; values?: Array<string | null> }>
          temperature?: boolean
          limit?: { context?: number; output?: number }
          cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
        }
      >
    }
  }
  const sol = snapshot.openai?.models?.["gpt-5.6-sol"]
  const astra = snapshot.openai?.models?.["gpt-6-astra"]
  const opus = snapshot.anthropic?.models?.["claude-opus-5"]
  const fable = snapshot.anthropic?.models?.["claude-fable-5"]

  expect(sol?.cost).toMatchObject({
    input: 5,
    output: 30,
    cache_read: 0.5,
    cache_write: 6.25,
    tiers: [
      {
        input: 10,
        output: 45,
        cache_read: 1,
        cache_write: 12.5,
        tier: { type: "context", size: 272_000 },
      },
    ],
  })
  expect(opus).toMatchObject({
    id: "claude-opus-5",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    temperature: false,
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  })
  expect(fable).toMatchObject({
    id: "claude-fable-5",
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    temperature: false,
    limit: { context: 1_000_000, output: 128_000 },
  })
  expect(astra).toMatchObject({
    limit: { context: 1_050_000, output: 128_000 },
    cost: {
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
      tiers: [
        {
          input: 20,
          output: 75,
          cache_read: 2,
          cache_write: 25,
          tier: { type: "context", size: 272_000 },
        },
      ],
    },
  })
})

test("normal build generation reads the committed snapshot without fetching", async () => {
  const source = await Bun.file(path.join(import.meta.dir, "generate.ts")).text()
  expect(source).toContain("models-dev.snapshot.json")
  expect(source).not.toContain("fetch(")
})
