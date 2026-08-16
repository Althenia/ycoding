import { describe, expect, test } from "bun:test"
import { cacheProfile, normalizeCacheModelID } from "../src/cache-profile"

describe("normalizeCacheModelID", () => {
  test("strips provider qualifiers, platform suffixes, and dotted versions", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["claude-opus-5", "claude-opus-5"],
      ["Claude-Opus-5", "claude-opus-5"],
      // OpenRouter qualifies by vendor and writes versions with a dot.
      ["anthropic/claude-sonnet-4.6", "claude-sonnet-4-6"],
      // Bedrock prefixes the vendor, and cross-region inference adds a geo prefix.
      ["anthropic.claude-opus-4-8", "claude-opus-4-8"],
      ["us.anthropic.claude-opus-4-8", "claude-opus-4-8"],
      // Bedrock's dated snapshots carry a model-version suffix.
      ["anthropic.claude-3-5-sonnet-20241022-v2:0", "claude-3-5-sonnet"],
      // GitHub Copilot and SAP AI Core expose this verified vendor-qualified alias.
      ["anthropic--claude-4-sonnet", "claude-sonnet-4"],
      ["claude-4-sonnet", "claude-sonnet-4"],
      // Vertex separates the snapshot date with `@`.
      ["claude-opus-4-5@20251101", "claude-opus-4-5"],
      ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
      ["claude-sonnet-4-5-latest", "claude-sonnet-4-5"],
    ]
    for (const [input, expected] of cases) expect([input, normalizeCacheModelID(input)]).toEqual([input, expected])
  })
})

describe("cacheProfile", () => {
  test("resolves the documented Anthropic minimum cacheable prefix per model", () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["claude-opus-5", 512],
      ["claude-fable-5", 512],
      ["claude-mythos-5", 512],
      ["claude-opus-4-8", 1024],
      ["claude-sonnet-5", 1024],
      ["claude-sonnet-4-6", 1024],
      ["claude-sonnet-4-5", 1024],
      ["claude-opus-4-1", 1024],
      ["claude-sonnet-4", 1024],
      ["claude-3-5-sonnet", 1024],
      ["claude-opus-4-7", 2048],
      ["claude-mythos-preview", 2048],
      ["claude-3-5-haiku", 2048],
      ["claude-opus-4-6", 4096],
      ["claude-opus-4-5", 4096],
      ["claude-haiku-4-5", 4096],
    ]
    for (const [id, minimumTokens] of cases)
      expect([id, cacheProfile(id)?.minimumTokens]).toEqual([id, minimumTokens])
  })

  test("prefers the longest matching family so sibling versions do not collide", () => {
    // `claude-opus-4-8` must not fall back to the shorter `claude-opus-4` entry.
    expect(cacheProfile("claude-opus-4-8")?.minimumTokens).toBe(1024)
    expect(cacheProfile("claude-opus-4-7")?.minimumTokens).toBe(2048)
    expect(cacheProfile("claude-opus-4-6")?.minimumTokens).toBe(4096)
    expect(cacheProfile("claude-opus-4")?.minimumTokens).toBe(1024)
  })

  test("resolves through platform-qualified ids", () => {
    expect(cacheProfile("us.anthropic.claude-opus-4-8")?.minimumTokens).toBe(1024)
    expect(cacheProfile("anthropic/claude-sonnet-4.6")?.minimumTokens).toBe(1024)
    expect(cacheProfile("anthropic.claude-3-5-sonnet-20241022-v2:0")?.minimumTokens).toBe(1024)
    expect(cacheProfile("anthropic--claude-4-sonnet")?.minimumTokens).toBe(1024)
    expect(cacheProfile("claude-opus-4-5@20251101")?.minimumTokens).toBe(4096)
  })

  test("marks Anthropic models as supporting the 1h bucket and others as not", () => {
    expect(cacheProfile("claude-opus-5")?.extendedTtl).toBe(true)
    expect(cacheProfile("anthropic/claude-sonnet-4.6")?.extendedTtl).toBe(true)
    expect(cacheProfile("gpt-5")?.extendedTtl).toBe(false)
    expect(cacheProfile("gemini-2.5-pro")?.extendedTtl).toBe(false)
  })

  test("covers the implicit-cache families so diagnostics can explain a short prefix", () => {
    expect(cacheProfile("gpt-5")?.minimumTokens).toBe(1024)
    expect(cacheProfile("gemini-2.5-flash")?.minimumTokens).toBe(1024)
    expect(cacheProfile("gemini-2.5-pro")?.minimumTokens).toBe(4096)
  })

  test("returns undefined for models with no published profile", () => {
    // An unknown model must not be assumed to support the 1h bucket.
    expect(cacheProfile("some-self-hosted-llama")).toBeUndefined()
  })
})
