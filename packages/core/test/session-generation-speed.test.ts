import { expect, test } from "bun:test"
import { Usage } from "@ycoding-ai/ai"
import { SessionUsage } from "../src/session/usage"
import { SessionCacheDiagnostics } from "../src/session/cache-diagnostics"
import { CatalogModel } from "../src/model"
import { Provider } from "../src/provider"

const model = CatalogModel.Ref.make({ providerID: Provider.ID.make("openai"), id: CatalogModel.ID.make("speed") })

test("keeps short output windows and counts reasoning with provider output", () => {
  expect(SessionUsage.generationTiming(new Usage({ outputTokens: 12, reasoningTokens: 4 }), {
    reasoning: 1_000_000_000n, text: 1_050_000_000n, ended: 1_100_000_000n,
  })).toEqual({ generatedTokens: 12, observedGenerationDurationNs: 100_000_000 })
})

test("estimates every nonempty tool-only stream, including one character", () => {
  for (const [streamedOutput, estimatedTokens] of [["x", 1], ['{"name":"hello"}', 4]] as const)
    expect(SessionUsage.generationTiming(undefined, {
      toolInput: 1_000_000_000n, ended: 1_010_000_000n, streamedOutput,
    })).toEqual({ estimatedTokens, estimatedGenerationDurationNs: 10_000_000 })
})

test("uses the request window without first-output timestamps and ignores provider duration", () => {
  expect(SessionUsage.generationTiming(new Usage({ outputTokens: 12, generationDurationNs: 9_000_000_000 }), {
    started: 1_000_000_000n, ended: 1_500_000_000n,
  })).toEqual({ generatedTokens: 12, observedGenerationDurationNs: 500_000_000 })
  expect(SessionUsage.generationTiming(undefined, {
    started: 1_000_000_000n, ended: 1_500_000_000n, streamedOutput: "hello world",
  })).toEqual({ estimatedTokens: 3, estimatedGenerationDurationNs: 500_000_000 })
})

test("weights eight recent output samples by duration across effort and profile changes", () => {
  const first = { model, timing: { generatedTokens: 40, observedGenerationDurationNs: 100_000_000 } }
  const second = { model: { ...model, variant: CatalogModel.VariantID.make("high"), profile: "work" },
    timing: { estimatedTokens: 60, estimatedGenerationDurationNs: 900_000_000 } }
  const history = SessionCacheDiagnostics.generationSpeed([first, second], { model })
  expect(history?.latest).toMatchObject({ tokens: 100, durationNs: 1_000_000_000, tokensPerSecond: 100, estimated: true })
  expect(history?.recent).toHaveLength(2)
  const many = SessionCacheDiagnostics.generationSpeed([...Array.from({ length: 12 }, () => first), second], { model })
  expect(many?.recent).toHaveLength(8)
  expect(many?.latest?.tokens).toBe(340)
})

test("retains earlier model samples across another model and output-free steps", () => {
  const first = { model, timing: { generatedTokens: 40, observedGenerationDurationNs: 100_000_000 } }
  const other = { model: { ...model, id: CatalogModel.ID.make("other") }, timing: { generatedTokens: 20, observedGenerationDurationNs: 100_000_000 } }
  expect(SessionCacheDiagnostics.generationSpeed([first, ...Array.from({ length: 20 }, () => other)], { model })?.latest?.tokensPerSecond).toBe(400)
  expect(SessionCacheDiagnostics.generationSpeed([first, other], { model: other.model })?.latest?.tokensPerSecond).toBe(200)
  expect(SessionCacheDiagnostics.generationSpeed([first, { model }])?.latest?.tokensPerSecond).toBe(400)
  expect(SessionCacheDiagnostics.generationSpeed([], { model })?.latest).toBeUndefined()
  expect(SessionUsage.generationTiming(undefined, { started: 0n, ended: 1_000_000n, streamedOutput: "" })).toBeUndefined()
})
