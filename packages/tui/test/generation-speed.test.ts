import { expect, test } from "bun:test"
import type { ModelRef, SessionCacheDiagnostics } from "@ycoding-ai/client"
import { generationSpeedLabel } from "../src/util/cache-diagnostics"

const model: ModelRef = { providerID: "openai", id: "gpt-5.6-terra", variant: "high" }
const history = (tokensPerSecond: number, estimated?: boolean): NonNullable<SessionCacheDiagnostics["generationSpeed"]> => ({
  model,
  recent: [],
  latest: { model, tokens: 100, durationNs: 1_000_000_000, tokensPerSecond, ...(estimated === undefined ? {} : { estimated }) },
})

test("formats the model rate, marking an estimate and never inventing a missing sample", () => {
  expect(generationSpeedLabel(history(5_000), model)).toBe("5,000 tok/s")
  expect(generationSpeedLabel(history(100, true), model)).toBe("≈ 100 tok/s")
  expect(generationSpeedLabel(history(0.5), model)).toBe("0.50 tok/s")
  expect(generationSpeedLabel(history(100, false), undefined)).toBe("100 tok/s")
  expect(generationSpeedLabel(undefined, model)).toBeUndefined()
  expect(generationSpeedLabel({ model, recent: [] }, model)).toBeUndefined()
  expect(generationSpeedLabel({ model, recent: [], unreportedReason: "No streamed output" }, model)).toBeUndefined()
})

test("matches the selected provider and model only, retaining the rate across variant and profile changes", () => {
  const lowVariant: ModelRef = { ...model, variant: "low" }
  const workProfile: ModelRef = { providerID: model.providerID, id: model.id, profile: "work" }
  expect(generationSpeedLabel(history(100), lowVariant)).toBe("100 tok/s")
  expect(generationSpeedLabel(history(100), workProfile)).toBe("100 tok/s")
  expect(generationSpeedLabel(history(100), { ...model, id: "other" })).toBeUndefined()
  expect(generationSpeedLabel(history(100), { ...model, providerID: "anthropic" })).toBeUndefined()
})
