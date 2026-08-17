import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@ycoding-ai/core/config"
import { ConfigImageAnalyzer } from "@ycoding-ai/core/config/image-analyzer"
import {
  ImageAnalyzer,
  STANDARD_IMAGE_ANALYSIS_PROMPT,
  IMAGE_ANALYSIS_TOON_EXAMPLE,
  stripToonFences,
  isValidToon,
} from "@ycoding-ai/core/session/runner/image-analyzer"
import { toLLMMessages, isProviderImage } from "@ycoding-ai/core/session/runner/to-llm-message"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { FileAttachment } from "@ycoding-ai/schema/prompt"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { DateTime } from "effect"
import { decode, encode } from "@toon-format/toon"

const created = DateTime.makeUnsafe(0)
const id = (v: string) => SessionMessage.ID.make(`msg_${v}`)
const model = ModelV2.Ref.make({ id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") })

const managed = (mime: string, name: string, digest = "a".repeat(64), bytes = 4, description?: string) =>
  FileAttachment.make({
    content: { type: "managed", digest, bytes, path: `attachments/sha256/${digest.slice(0, 2)}/${digest}` },
    mime,
    name,
    ...(description ? { description } : {}),
  })

describe("ConfigImageAnalyzer", () => {
  test("resolves selector string and separate provider/model fields", () => {
    const decodeCfg = Schema.decodeUnknownSync(Config.Info)
    const withSelector = decodeCfg({ image_analyzer: { model: "anthropic/claude-sonnet-4", enabled: true } })
    expect(ConfigImageAnalyzer.resolveSelection(withSelector.image_analyzer!) as unknown as { providerID: string; model: string }).toEqual({
      providerID: "anthropic",
      model: "claude-sonnet-4",
    })
    expect(ConfigImageAnalyzer.isEnabled(withSelector.image_analyzer!)).toBe(true)

    const withSeparate = decodeCfg({
      image_analyzer: { provider: "anthropic", model: "claude-sonnet-4", variant: "high", enabled: true },
    })
    expect(ConfigImageAnalyzer.resolveSelection(withSeparate.image_analyzer!) as unknown as { providerID: string; model: string; variant: string }).toEqual({
      providerID: "anthropic",
      model: "claude-sonnet-4",
      variant: "high",
    })

    const withSelectorVariant = decodeCfg({ image_analyzer: { model: "anthropic/claude-sonnet-4#high" } })
    expect(ConfigImageAnalyzer.resolveSelection(withSelectorVariant.image_analyzer!) as unknown as { providerID: string; model: string; variant: string }).toEqual({
      providerID: "anthropic",
      model: "claude-sonnet-4",
      variant: "high",
    })
  })

  test("disabled or missing model disables analyzer", () => {
    const decodeCfg = Schema.decodeUnknownSync(Config.Info)
    expect(ConfigImageAnalyzer.isEnabled(decodeCfg({ image_analyzer: { enabled: false, model: "anthropic/claude" } }).image_analyzer!)).toBe(false)
    expect(ConfigImageAnalyzer.isEnabled(decodeCfg({ image_analyzer: { model: "anthropic/claude" } }).image_analyzer!)).toBe(true)
    expect(ConfigImageAnalyzer.isEnabled(decodeCfg({}).image_analyzer)).toBe(false)
    expect(ConfigImageAnalyzer.isEnabled(decodeCfg({ image_analyzer: { provider: "anthropic" } }).image_analyzer!)).toBe(false)
  })

  test("effective prompt prefers prompt over template and defaults to standard", () => {
    const decodeCfg = Schema.decodeUnknownSync(Config.Info)
    expect(ConfigImageAnalyzer.effectivePrompt(decodeCfg({ image_analyzer: { prompt: "custom" } }).image_analyzer!)).toBe("custom")
    expect(ConfigImageAnalyzer.effectivePrompt(decodeCfg({ image_analyzer: { template: "tmpl" } }).image_analyzer!)).toBe("tmpl")
    expect(ConfigImageAnalyzer.effectivePrompt(decodeCfg({ image_analyzer: { prompt: "a", template: "b" } }).image_analyzer!)).toBe("a")
    expect(ConfigImageAnalyzer.effectivePrompt(undefined)).toBeUndefined()
  })
})

describe("ImageAnalyzer multimodal detection", () => {
  test("detects image capabilities", () => {
    expect(ImageAnalyzer.isMultimodal({ input: ["text"] })).toBe(false)
    expect(ImageAnalyzer.isMultimodal({ input: ["text", "image"] })).toBe(true)
    expect(ImageAnalyzer.isMultimodal({ input: ["text", "image/png"] })).toBe(true)
    expect(ImageAnalyzer.isMultimodal({ input: ["vision"] })).toBe(true)
    expect(ImageAnalyzer.isMultimodal({ input: [] })).toBe(false)
    expect(ImageAnalyzer.isMultimodal(undefined)).toBe(false)
    expect(ImageAnalyzer.isMultimodal({ input: ["text", "image/jpeg"] })).toBe(true)
  })

  test("standard prompt contains TOON header template and is deterministic", () => {
    // Must embed TOON schema instruction and header template per R2
    expect(STANDARD_IMAGE_ANALYSIS_PROMPT).toContain("Output ONLY valid TOON")
    expect(STANDARD_IMAGE_ANALYSIS_PROMPT).toContain("2-space indent")
    expect(STANDARD_IMAGE_ANALYSIS_PROMPT).toContain("explicit [N] and {fields}")
    expect(STANDARD_IMAGE_ANALYSIS_PROMPT).toContain("```toon")
    expect(STANDARD_IMAGE_ANALYSIS_PROMPT).toContain("objects[2]{type,count,description}:")
    expect(STANDARD_IMAGE_ANALYSIS_PROMPT).toContain("palette[3]:")
    expect(STANDARD_IMAGE_ANALYSIS_PROMPT).toContain(IMAGE_ANALYSIS_TOON_EXAMPLE.slice(0, 30))
    // Prompt embeds the example TOON verbatim
    expect(STANDARD_IMAGE_ANALYSIS_PROMPT).toContain(IMAGE_ANALYSIS_TOON_EXAMPLE)
    // Still preserves 7 sections semantics as structured fields
    for (const field of ["scene:", "objects[", "text_ocr[", "layout:", "colors:", "details[", "confidence:"]) {
      expect(STANDARD_IMAGE_ANALYSIS_PROMPT).toContain(field)
    }
    // deterministic across reads
    expect(STANDARD_IMAGE_ANALYSIS_PROMPT).toBe(STANDARD_IMAGE_ANALYSIS_PROMPT)
    // prompt length not excessive (~300 tokens ~1200 chars); keep < 4000 chars per check
    expect(STANDARD_IMAGE_ANALYSIS_PROMPT.length).toBeLessThan(4000)
  })

  test("IMAGE_ANALYSIS_TOON_EXAMPLE is valid TOON round-trippable via @toon-format/toon", () => {
    const decoded = decode(IMAGE_ANALYSIS_TOON_EXAMPLE) as Record<string, unknown>
    expect(decoded["version"]).toBe("1")
    expect(decoded["scene"]).toBeDefined()
    expect(decoded["objects"]).toBeDefined()
    expect(decoded["text_ocr"]).toBeDefined()
    expect(decoded["layout"]).toBeDefined()
    expect(decoded["colors"]).toBeDefined()
    expect(decoded["details"]).toBeDefined()
    expect(decoded["confidence"]).toBeDefined()
    // 2-space indent and explicit [N]{fields} present
    expect(IMAGE_ANALYSIS_TOON_EXAMPLE).toContain("objects[2]{type,count,description}:")
    expect(IMAGE_ANALYSIS_TOON_EXAMPLE).toContain("  cat,1,")
    expect(IMAGE_ANALYSIS_TOON_EXAMPLE).toContain("palette[3]:")
    // encode->decode round-trip preserves structure
    const reEncoded = encode(decoded)
    const reDecoded = decode(reEncoded) as Record<string, unknown>
    expect(JSON.stringify(reDecoded)).toBe(JSON.stringify(decoded))
  })

  test("formatFallbackBlock preserves TOON block verbatim and is parseable", () => {
    const file = managed("image/png", "photo.png", "b".repeat(64), 123, "a nice photo")
    const toon = IMAGE_ANALYSIS_TOON_EXAMPLE
    const block = ImageAnalyzer.formatFallbackBlock({ file, analysis: toon, modelLabel: "anthropic/claude" })
    expect(block).toContain("[Image Analysis: photo.png (image/png) via anthropic/claude]")
    // header then blank line then ```toon
    expect(block).toMatch(/\[Image Analysis: photo\.png \(image\/png\) via anthropic\/claude\]\n\n```toon/)
    expect(block).toContain("```toon\n")
    expect(block).toContain(toon.trim().split("\n")[0]!)
    expect(block).toContain("SHA-256: " + "b".repeat(64))
    expect(block).toContain("Bytes: 123")
    expect(block).toContain("Original description: a nice photo")
    // metadata outside block, TOON extractable
    const extracted = stripToonFences(block.slice(block.indexOf("```toon")))
    // After stripping fences the first line should be the TOON version line
    expect(extracted.startsWith('version:')).toBe(true)
    expect(isValidToon(extracted)).toBe(true)
    const decoded = decode(extracted) as Record<string, unknown>
    expect((decoded["scene"] as Record<string, unknown>)["overview"]).toBeDefined()
    // failureBlock unchanged
    const fail = ImageAnalyzer.failureBlock(file, "vision model not configured")
    expect(fail).toContain("[Image Analysis: photo.png (image/png) — FAILED]")
    expect(fail).toContain("vision model not configured")
    expect(fail).toContain("SHA-256:")
    expect(fail).not.toContain("```toon")
  })

  test("stripToonFences handles fences and plain TOON", () => {
    const plain = IMAGE_ANALYSIS_TOON_EXAMPLE
    expect(stripToonFences(plain)).toBe(plain.trim())
    const fenced = "```toon\n" + plain + "\n```"
    expect(stripToonFences(fenced)).toBe(plain.trim())
    const fencedGeneric = "```\n" + plain + "\n```"
    expect(stripToonFences(fencedGeneric)).toBe(plain.trim())
    expect(isValidToon(plain)).toBe(true)
    expect(isValidToon("not toon at all")).toBe(false)
    expect(isValidToon(fenced)).toBe(true)
  })
})

describe("toLLMMessages fallback", () => {
  test("text-only model with fallbackDescriptions produces TOON block instead of media", () => {
    const file = managed("image/png", "cat.png", "c".repeat(64), 10)
    const analysis = ImageAnalyzer.formatFallbackBlock({ file, analysis: IMAGE_ANALYSIS_TOON_EXAMPLE })
    const msgs = toLLMMessages(
      [SessionMessage.User.make({ id: id("u1"), type: "user", text: "look", files: [file], time: { created } })],
      model,
      model.providerID,
      new Map(),
      {
        images: new Map([[file.content.digest, Uint8Array.from([1, 2, 3])]]),
        absolutePath: () => "/tmp/cat.png",
        fallbackDescriptions: new Map([[file.content.digest, analysis]]),
      },
    )
    expect(msgs).toHaveLength(1)
    const content = msgs[0]!.content
    expect(content.some((p) => p.type === "media")).toBe(false)
    const text = content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n")
    expect(text).toContain("[Image Analysis: cat.png (image/png)")
    expect(text).toContain("```toon")
    expect(text).toContain('version: "1"')
    expect(text).toContain("objects[2]{type,count,description}:")
    expect(text).toContain("confidence:")
    // extract and validate TOON inside fallback
    const start = text.indexOf("```toon")
    const extracted = stripToonFences(text.slice(start))
    expect(isValidToon(extracted)).toBe(true)
  })

  test("multimodal model without fallback still sends media", () => {
    const file = managed("image/png", "cat.png", "c".repeat(64), 10)
    const msgs = toLLMMessages(
      [SessionMessage.User.make({ id: id("u2"), type: "user", text: "look", files: [file], time: { created } })],
      model,
      model.providerID,
      new Map(),
      {
        images: new Map([[file.content.digest, Uint8Array.from([1, 2, 3])]]),
        absolutePath: () => "/tmp/cat.png",
      },
    )
    expect(msgs[0]!.content.some((p) => p.type === "media")).toBe(true)
  })

  test("fallback failure still produces text with failure prefix, not media", () => {
    const file = managed("image/jpeg", "dog.jpg", "d".repeat(64), 20)
    const fail = ImageAnalyzer.failureBlock(file, "image analyzer not configured")
    const msgs = toLLMMessages(
      [SessionMessage.User.make({ id: id("u3"), type: "user", text: "", files: [file], time: { created } })],
      model,
      model.providerID,
      new Map(),
      {
        images: new Map([[file.content.digest, Uint8Array.from([9])]]),
        absolutePath: () => "/tmp/dog.jpg",
        fallbackDescriptions: new Map([[file.content.digest, fail]]),
      },
    )
    expect(msgs[0]!.content.some((p) => p.type === "media")).toBe(false)
    const text = msgs[0]!.content.find((p) => p.type === "text") as { text: string } | undefined
    expect(text?.text).toContain("FAILED")
    expect(text?.text).toContain("SHA-256:")
  })

  test("isProviderImage correctly identifies image mimes", () => {
    expect(isProviderImage(managed("image/png", "a.png"))).toBe(true)
    expect(isProviderImage(managed("image/jpeg", "a.jpg"))).toBe(true)
    expect(isProviderImage(managed("image/gif", "a.gif"))).toBe(true)
    expect(isProviderImage(managed("image/webp", "a.webp"))).toBe(true)
    expect(isProviderImage(managed("application/pdf", "a.pdf"))).toBe(false)
    expect(isProviderImage(managed("image/svg+xml", "a.svg"))).toBe(false)
  })
})
