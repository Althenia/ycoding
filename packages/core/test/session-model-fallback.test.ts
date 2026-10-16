import { describe, expect, test } from "bun:test"
import {
  AuthenticationReason,
  ContentPolicyReason,
  InvalidProviderOutputReason,
  InvalidRequestReason,
  LLMError,
  NoRouteReason,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
  UnknownProviderReason,
} from "@ycoding-ai/ai"
import { Config } from "@ycoding-ai/core/config"
import { SessionModelFallback } from "@ycoding-ai/core/session/runner/fallback"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { Schema } from "effect"

const failure = (reason: LLMError["reason"]) => new LLMError({ module: "test", method: "stream", reason })
const ref = (providerID: string, id: string, extra: { variant?: string; profile?: string } = {}) =>
  Schema.decodeUnknownSync(Model.Ref)({ providerID, id, ...extra })
const entries = (model_fallbacks: unknown) => [
  new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)({ model_fallbacks }) }),
]

describe("SessionModelFallback.immediate", () => {
  test("switches at once on quota, missing routes, and provider-requested waits beyond the retry ceiling", () => {
    expect(SessionModelFallback.immediate(failure(new QuotaExceededReason({ message: "quota" })))).toBe(true)
    expect(
      SessionModelFallback.immediate(
        failure(
          Schema.decodeUnknownSync(NoRouteReason)({
            _tag: "NoRoute",
            route: "openai-chat",
            provider: "fake",
            model: "fake-model",
          }),
        ),
      ),
    ).toBe(true)
    expect(SessionModelFallback.immediate(failure(new RateLimitReason({ message: "later", retryAfterMs: 120_001 })))).toBe(
      true,
    )
    expect(
      SessionModelFallback.immediate(failure(new ProviderInternalReason({ message: "overloaded", retryAfterMs: 600_000 }))),
    ).toBe(true)
  })

  test("leaves retryable, credential, policy, request, and unclassified failures to their existing handling", () => {
    for (const reason of [
      new RateLimitReason({ message: "slow down", retryAfterMs: 120_000 }),
      new RateLimitReason({ message: "slow down" }),
      new ProviderInternalReason({ message: "internal" }),
      new TransportReason({ message: "reset" }),
      new AuthenticationReason({ message: "expired", kind: "expired" }),
      new ContentPolicyReason({ message: "blocked" }),
      new InvalidRequestReason({ message: "bad request" }),
      new InvalidRequestReason({ message: "too long", classification: "context-overflow" }),
      new InvalidProviderOutputReason({ message: "malformed" }),
      new UnknownProviderReason({ message: "unknown" }),
    ])
      expect(SessionModelFallback.immediate(failure(reason))).toBe(false)
  })
})

describe("SessionModelFallback.unavailable", () => {
  test("treats unresolvable models, variants, and packages as unavailable but not profile or credential failures", () => {
    const providerID = Provider.ID.make("fake")
    const modelID = Model.ID.make("fake-model")
    expect(SessionModelFallback.unavailable(new SessionRunnerModel.ModelUnavailableError({ providerID, modelID }))).toBe(true)
    expect(
      SessionModelFallback.unavailable(
        new SessionRunnerModel.VariantUnavailableError({ providerID, modelID, variant: Model.VariantID.make("high") }),
      ),
    ).toBe(true)
    expect(
      SessionModelFallback.unavailable(
        new SessionRunnerModel.UnsupportedPackageError({ providerID, modelID, package: "missing" }),
      ),
    ).toBe(true)
    expect(
      SessionModelFallback.unavailable(new SessionRunnerModel.ProfileUnavailableError({ providerID, profile: "Work" })),
    ).toBe(false)
    expect(
      SessionModelFallback.unavailable(new SessionRunnerModel.ClaudeCodeReconnectError({ providerID, modelID })),
    ).toBe(false)
  })
})

describe("SessionModelFallback.next", () => {
  const config = entries({
    "anthropic/claude-opus-5": ["openai/gpt-6-sol#high", "Work#anthropic/claude-opus-5", "fake/backup"],
  })

  test("returns the first configured model that has not been tried, for any variant or profile of the key", () => {
    expect(SessionModelFallback.next(config, ref("anthropic", "claude-opus-5", { variant: "max" }), [])).toEqual(
      ref("openai", "gpt-6-sol", { variant: "high" }),
    )
    expect(
      SessionModelFallback.next(config, ref("anthropic", "claude-opus-5"), [
        ref("anthropic", "claude-opus-5"),
        ref("openai", "gpt-6-sol", { variant: "high" }),
      ]),
    ).toEqual(ref("anthropic", "claude-opus-5", { profile: "Work" }))
  })

  test("returns nothing when the chain is exhausted or the model has no chain", () => {
    expect(
      SessionModelFallback.next(config, ref("anthropic", "claude-opus-5"), [
        ref("openai", "gpt-6-sol", { variant: "high" }),
        ref("anthropic", "claude-opus-5", { profile: "Work" }),
        ref("fake", "backup"),
      ]),
    ).toBeUndefined()
    expect(SessionModelFallback.next(config, ref("openai", "gpt-6-sol"), [])).toBeUndefined()
    expect(SessionModelFallback.next([], ref("anthropic", "claude-opus-5"), [])).toBeUndefined()
  })

  test("uses only the nearest configuration document that sets fallbacks", () => {
    const layered = [
      ...entries({ "anthropic/claude-opus-5": ["fake/global"] }),
      ...entries({ "anthropic/claude-opus-5": ["fake/project"] }),
    ]
    expect(SessionModelFallback.next(layered, ref("anthropic", "claude-opus-5"), [])).toEqual(ref("fake", "project"))
  })
})
