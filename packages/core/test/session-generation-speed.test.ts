import { expect, test } from "bun:test"
import { Usage } from "@ycoding-ai/ai"
import { SessionUsage } from "../src/session/usage"
import { SessionCacheDiagnostics } from "../src/session/cache-diagnostics"
import { CatalogModel } from "../src/model"
import { Provider } from "../src/provider"
import { Token } from "../src/util/token"

const model = CatalogModel.Ref.make({ providerID: Provider.ID.make("openai"), id: CatalogModel.ID.make("speed") })

test("accepts only eligible received-output intervals", () => {
  expect(SessionCacheDiagnostics.generationSample({ receivedOutput: { estimatedTokens: 80, durationNs: 2_000_000_000 } }))
    .toEqual({ tokens: 80, durationNs: 2_000_000_000, tokensPerSecond: 40, estimated: true })
  expect(SessionCacheDiagnostics.generationSample({ receivedOutput: { estimatedTokens: 80, durationNs: 999_999_999 } })).toBeUndefined()
  expect(SessionCacheDiagnostics.generationSample({ generatedTokens: 80, observedGenerationDurationNs: 1 })).toBeUndefined()
  expect(SessionCacheDiagnostics.generationSample({ generatedTokens: 80, observedGenerationDurationNs: 2_000_000_000 })).toBeUndefined()
  expect(SessionCacheDiagnostics.generationSample({ estimatedTokens: 80, estimatedGenerationDurationNs: 2_000_000_000 })).toBeUndefined()
})

test("subtracts the entire first received chunk and uses the last arrival", () => {
  const window = SessionUsage.receivedOutput()
  window.observe(10_000_000_000n, 1000)
  window.observe(11_000_000_000n, 1040)
  window.observe(12_000_000_000n, 1080)
  expect(window.sample()).toEqual({ estimatedTokens: 80, durationNs: 2_000_000_000 })
  expect(window.sample()).toEqual({ estimatedTokens: 80, durationNs: 2_000_000_000 })
})

test("requires distinct endpoints spanning one second with a positive token delta", () => {
  const window = SessionUsage.receivedOutput()
  window.observe(0n, 1)
  expect(window.sample()).toBeUndefined()
  window.observe(0n, 2)
  window.observe(999_999_999n, 2)
  expect(window.sample()).toBeUndefined()
  window.observe(1_000_000_000n, 2)
  expect(window.sample()).toBeUndefined()
  window.observe(1_000_000_000n, 4)
  expect(window.sample()).toEqual({ estimatedTokens: 2, durationNs: 1_000_000_000 })
})

test("evicts endpoints outside the trailing window and excludes their baseline", () => {
  const window = SessionUsage.receivedOutput()
  window.observe(0n, 1000)
  window.observe(2_000_000_000n, 1040)
  window.observe(4_000_000_000n, 1080)
  window.observe(7_000_000_000n, 1120)
  expect(window.sample()).toEqual({ estimatedTokens: 80, durationNs: 5_000_000_000 })
})

test("estimates cumulative characters independently of chunk boundaries", () => {
  const whole = SessionUsage.receivedOutput()
  const split = SessionUsage.receivedOutput()
  whole.observe(0n, Token.estimate("xxxx"))
  split.observe(0n, Token.estimate("xxxx"))
  whole.observe(1_000_000_000n, Token.estimate("xxxxxxxxxxxx"))
  for (let index = 1; index <= 8; index++) split.observe(1_000_000_000n, Token.estimate("x".repeat(4 + index)))
  expect(split.sample()).toEqual(whole.sample())
})

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
  const first = { model, timing: { receivedOutput: { estimatedTokens: 40, durationNs: 1_000_000_000 } } }
  const second = { model: { ...model, variant: CatalogModel.VariantID.make("high"), profile: "work" },
    timing: { receivedOutput: { estimatedTokens: 60, durationNs: 2_000_000_000 } } }
  const history = SessionCacheDiagnostics.generationSpeed([first, second], { model })
  expect(history?.latest).toMatchObject({ tokens: 100, durationNs: 3_000_000_000, tokensPerSecond: 100 / 3, estimated: true })
  expect(history?.recent).toHaveLength(2)
  const many = SessionCacheDiagnostics.generationSpeed([...Array.from({ length: 12 }, () => first), second], { model })
  expect(many?.recent).toHaveLength(8)
  expect(many?.latest?.tokens).toBe(340)
})

test("retains earlier model samples across another model and output-free steps", () => {
  const first = { model, timing: { receivedOutput: { estimatedTokens: 40, durationNs: 1_000_000_000 } } }
  const other = { model: { ...model, id: CatalogModel.ID.make("other") }, timing: { receivedOutput: { estimatedTokens: 20, durationNs: 1_000_000_000 } } }
  expect(SessionCacheDiagnostics.generationSpeed([first, ...Array.from({ length: 20 }, () => other)], { model })?.latest?.tokensPerSecond).toBe(40)
  expect(SessionCacheDiagnostics.generationSpeed([first, other], { model: other.model })?.latest?.tokensPerSecond).toBe(20)
  expect(SessionCacheDiagnostics.generationSpeed([first, { model }])?.latest?.tokensPerSecond).toBe(40)
  expect(SessionCacheDiagnostics.generationSpeed([], { model })?.latest).toBeUndefined()
  expect(SessionUsage.generationTiming(undefined, { started: 0n, ended: 1_000_000n, streamedOutput: "" })).toBeUndefined()
})
