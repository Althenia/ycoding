import { expect, test } from "bun:test"
import { ConfigDecisions } from "@ycoding-ai/core/config/decisions"
import { Decision } from "@ycoding-ai/core/decision"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"

test.each(["openai", "typesafe"] as const)("%s score uses the modal integer level and its native probability", (provider) => {
  const output: Decision.Output = provider === "openai" ? {
    provider, response: { model: "gpt-6-luna", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      answers: [{ type: "score", name: "decision", score: 2.73, confidence: 0.1,
        probabilities: [0.02, 0.02, 0.05, 0.9, 0.01].map((probability, value) => ({ value, label: String(value), probability })) }],
    },
  } : {
    provider, response: { model: "jev-1.13.0", usage: { input_tokens: 0, output_tokens: 0 },
      answers: { decision: { type: "score", score: 2.73, confidence: 0.1, legend: {},
        probabilities: { "0": 0.02, "1": 0.02, "2": 0.05, "3": 0.9, "4": 0.01 } } },
    },
  }
  const answer = Decision.normalizedScore(output, "decision")
  expect(answer).toEqual({ choice: "3", probability: 0.9, refused: false })
  expect(Decision.assess(new ConfigDecisions.Policy({ provider, min_probability: 0.9 }), answer).status).toBe("confident")
})

test("agent score preserves the level index and uncalibrated confidence", () => {
  expect(Decision.normalizedScore({ provider: "agent", response: {
    model: { providerID: Provider.ID.make("openai"), id: CatalogModel.ID.make("fixture") }, semantics: "model-estimate", version: 1,
    answers: [{ name: "decision", type: "score", score: 3, confidence: 0.84, answer: null, choice: null }],
  } }, "decision")).toEqual({ choice: "3", confidence: 0.84, refused: false })
})

test("tied native score levels and refusals remain uncertain", () => {
  for (const answer of [
    { type: "score" as const, name: "decision", score: 0.5, confidence: 1,
      probabilities: [{ value: 0, label: "none", probability: 0.5 }, { value: 1, label: "minor", probability: 0.5 }] },
    { type: "refusal" as const, name: "decision" },
  ]) {
    expect(Decision.normalizedScore({ provider: "openai", response: { model: "gpt-6-luna",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, answers: [answer],
    } }, "decision")).toEqual({ refused: true })
  }
})
