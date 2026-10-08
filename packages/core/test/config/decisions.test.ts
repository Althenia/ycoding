import { expect, test } from "bun:test"
import { Config } from "@ycoding-ai/core/config"
import { Schema } from "effect"

const decode = Schema.decodeUnknownSync(Config.Info)

test("retains explicit decision providers and opt-in automatic consumers", () => {
  const decisions = {
    providers: { openai: { api_key: "fixture" }, typesafe: { api_key: "fixture", model: "jev-1.13.0" } },
    timeout_ms: 5000,
    guardrails: { provider: "openai", min_probability: 0.95 },
    routing: { provider: "typesafe", min_probability: 0.9, candidates: [
      { id: "implement", agent: "build", model: "openai/gpt-6.1-sol", description: "Implement code" },
      { id: "review", agent: "plan", description: "Read-only analysis" },
    ] },
    goal: { provider: "openai", min_probability: 0.95 },
    questions: { provider: "typesafe", min_probability: 0.7 },
  }
  expect(decode({ decisions })).toMatchObject({ decisions: {
    ...decisions,
    routing: { ...decisions.routing, candidates: [
      { ...decisions.routing.candidates[0], model: { providerID: "openai", model: "gpt-6.1-sol" } },
      decisions.routing.candidates[1],
    ] },
  } })
})

test("rejects unbounded timeouts, invalid thresholds, and ambiguous routes", () => {
  for (const decisions of [
    { timeout_ms: 60001 },
    { guardrails: { provider: "openai", min_probability: 1.1 } },
    { goal: { provider: "typesafe" } },
    { routing: { provider: "openai", min_probability: 0.9, candidates: [] } },
    { routing: { provider: "openai", min_probability: 0.9, candidates: [
      { id: "same", agent: "build", description: "First" }, { id: "same", agent: "plan", description: "Second" },
    ] } },
    { routing: { provider: "typesafe", min_probability: 0.9, candidates: [
      { id: "keep-current", agent: "build", description: "Reserved ID" },
    ] } },
    { routing: { provider: "typesafe", min_probability: 0.9, candidates: Array.from({ length: 255 }, (_, index) => ({
      id: `route-${index}`, agent: "build", description: "Configured route",
    })) } },
  ]) expect(() => decode({ decisions })).toThrow()
})

test("retains model-agent confidence policies independently of native probabilities", () => {
  const policy = { provider: "agent", min_confidence: 0.8 }
  const decisions = { guardrails: policy, goal: policy, questions: policy, routing: { ...policy, candidates: [
    { id: "review", agent: "GSD", description: "Review" },
  ] } }
  expect(decode({ decisions }).decisions).toMatchObject(decisions)
})

test("rejects missing, invalid, or mixed confidence/probability thresholds", () => {
  for (const guardrails of [
    { provider: "agent", min_probability: 0.8 },
    { provider: "agent", min_confidence: 1.1 },
    { provider: "agent", min_confidence: -0.1 },
    { provider: "agent", min_confidence: 0.8, min_probability: 0.9 },
    { provider: "openai", min_probability: 0.8, min_confidence: 0.9 },
  ]) {
    expect(() => decode({ decisions: { guardrails } })).toThrow()
    expect(() => decode({ decisions: { questions: guardrails } })).toThrow()
  }
})
