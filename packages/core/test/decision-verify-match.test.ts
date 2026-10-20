import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Decision } from "@ycoding-ai/core/decision"
import { DecisionChoice } from "@ycoding-ai/core/decision-choice"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_verify_match")

const respond = (answer: Record<string, unknown>): Decision.Interface => ({
  evaluate: () =>
    Effect.succeed(
      Schema.decodeUnknownSync(Decision.Output)({
        provider: "agent",
        response: {
          model: { providerID: "test", id: "judge" },
          semantics: "model-estimate",
          version: 1,
          answers: [{ name: "guardrail_match", answer: null, choice: null, score: null, ...answer }],
        },
      }),
    ),
})

const verify = (decision: Decision.Interface) =>
  DecisionChoice.verifyMatch(decision, { sessionID, state: { matchedRule: { id: "standard.review.x", reason: "x" } } })

describe("verifyMatch", () => {
  test("asks one strict choice among allow, deny and escalate with the invocation purpose and authority", async () => {
    const seen: Array<{ request: Decision.Input["request"]; context: Decision.Invocation }> = []
    await Effect.runPromise(DecisionChoice.verifyMatch({
      evaluate: (input, context) => {
        seen.push({ request: input.request, context })
        return Effect.fail(new Decision.Error({ reason: "refused" }))
      },
    }, { sessionID, purpose: "guardrail", authority: "baseline", invocationKey: "guardrail-match:abc", state: {} }))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.request.questions).toHaveLength(1)
    const question = seen[0]?.request.questions[0]
    expect(question).toMatchObject({ type: "choice", name: "guardrail_match" })
    expect(question?.type === "choice" && question.grade).not.toBe(true)
    expect(question?.type === "choice" && question.choices.map((choice) => choice.value)).toEqual(["allow", "deny", "escalate"])
    expect(seen[0]?.context).toEqual({ sessionID, purpose: "guardrail", authority: "baseline", invocationKey: "guardrail-match:abc" })
  })

  test("a confident allow is a non-match and a confident deny is a real match", async () => {
    expect(await Effect.runPromise(verify(respond({ type: "choice", choice: "allow", confidence: 0.9 })))).toEqual({ answer: false, confidence: 0.9 })
    expect(await Effect.runPromise(verify(respond({ type: "choice", choice: "deny", confidence: 0.97 })))).toEqual({ answer: true, confidence: 0.97 })
  })

  test("escalation, low confidence, refusal, a predicate answer, and an unknown choice settle nothing", async () => {
    for (const answer of [
      { type: "choice", choice: "escalate", confidence: 0.99 },
      { type: "choice", choice: "allow", confidence: 0.89 },
      { type: "choice", choice: "deny", confidence: 0.5 },
      { type: "refusal", confidence: 0 },
      { type: "predicate", answer: false, confidence: 0.99 },
      { type: "choice", choice: "approve", confidence: 0.99 },
    ])
      expect(await Effect.runPromise(verify(respond(answer)))).toBeUndefined()
  })

  test("a failing helper settles nothing", async () => {
    expect(await Effect.runPromise(verify({ evaluate: () => Effect.fail(new Decision.Error({ reason: "unsupported-output" })) }))).toBeUndefined()
  })

  const timed = testEffect(Layer.empty)
  timed.effect("a helper slower than 15 seconds settles nothing", () =>
    Effect.gen(function* () {
      const fiber = yield* verify({ evaluate: () => Effect.never }).pipe(Effect.forkChild)
      yield* TestClock.adjust("14 seconds")
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("2 seconds")
      expect(yield* Fiber.join(fiber)).toBeUndefined()
    }),
  )
})
