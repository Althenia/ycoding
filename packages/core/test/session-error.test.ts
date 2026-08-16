import { describe, expect, test } from "bun:test"
import {
  AuthenticationReason,
  ContentPolicyReason,
  InvalidProviderOutputReason,
  InvalidRequestReason,
  LLMError,
  NoRouteReason,
  ModelID,
  ProviderID,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
  UnknownProviderReason,
  ToolFailure,
} from "@ycoding-ai/ai"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { Tool } from "@ycoding-ai/plugin/effect/tool"
import { toSessionError } from "@ycoding-ai/core/session/to-session-error"
import { SessionRunnerRetry } from "@ycoding-ai/core/session/runner/retry"

const llm = (reason: LLMError["reason"]) => new LLMError({ module: "test", method: "stream", reason })

describe("toSessionError", () => {
  test("maps every LLM reason to the open wire type", () => {
    expect(toSessionError(llm(new RateLimitReason({ message: "rate", retryAfterMs: 123 })))).toEqual({
      type: "provider.rate-limit",
      message: "rate",
    })
    expect(toSessionError(llm(new AuthenticationReason({ message: "auth", kind: "invalid" }))).type).toBe(
      "provider.auth",
    )
    expect(toSessionError(llm(new QuotaExceededReason({ message: "quota" }))).type).toBe("provider.quota")
    expect(toSessionError(llm(new ContentPolicyReason({ message: "blocked" }))).type).toBe("provider.content-filter")
    expect(toSessionError(llm(new TransportReason({ message: "transport" }))).type).toBe("provider.transport")
    expect(toSessionError(llm(new ProviderInternalReason({ message: "internal", status: 500 }))).type).toBe(
      "provider.internal",
    )
    expect(toSessionError(llm(new InvalidProviderOutputReason({ message: "output" }))).type).toBe(
      "provider.invalid-output",
    )
    expect(toSessionError(llm(new InvalidRequestReason({ message: "request" }))).type).toBe("provider.invalid-request")
    expect(
      toSessionError(
        llm(
          new NoRouteReason({
            route: "route",
            provider: ProviderID.make("provider"),
            model: ModelID.make("model"),
          }),
        ),
      ).type,
    ).toBe("provider.no-route")
    expect(toSessionError(llm(new UnknownProviderReason({ message: "unknown" }))).type).toBe("provider.unknown")
  })

  test("preserves the permission rejection type without exposing internal fields", () => {
    const blocked = new PermissionV2.BlockedError({ rules: [], permission: "external_directory", resources: [] })
    expect(toSessionError(blocked)).toEqual({
      type: "permission.rejected",
      message: "Permission denied: external_directory",
    })
    expect(toSessionError(new ToolFailure({ message: blocked.message, error: blocked }))).toEqual({
      type: "permission.rejected",
      message: "Permission denied: external_directory",
    })
    expect(toSessionError(new Tool.Failure({ message: "failed" }))).toEqual({
      type: "tool.execution",
      message: "failed",
    })
  })

  test("retries only rate limits, provider-internal failures, and transport failures", () => {
    const eligible = [
      llm(new RateLimitReason({ message: "rate" })),
      llm(new ProviderInternalReason({ message: "internal", status: 500 })),
      llm(new TransportReason({ message: "transport" })),
    ]
    const ineligible = [
      llm(new AuthenticationReason({ message: "auth", kind: "invalid" })),
      llm(new QuotaExceededReason({ message: "quota" })),
      llm(new ContentPolicyReason({ message: "blocked" })),
      llm(new InvalidProviderOutputReason({ message: "output" })),
      llm(new InvalidRequestReason({ message: "request" })),
      llm(new NoRouteReason({ route: "route", provider: ProviderID.make("provider"), model: ModelID.make("model") })),
      llm(new UnknownProviderReason({ message: "unknown" })),
    ]

    expect(eligible.map(SessionRunnerRetry.isRetryable)).toEqual([true, true, true])
    expect(ineligible.map(SessionRunnerRetry.isRetryable)).toEqual([false, false, false, false, false, false, false])
  })

  test("stops retrying when the provider reset is beyond the honoured ceiling", () => {
    const withinCeiling = llm(
      new RateLimitReason({ message: "rate", retryAfterMs: SessionRunnerRetry.RETRY_AFTER_CEILING_MS }),
    )
    const beyondCeiling = llm(
      new RateLimitReason({ message: "rate", retryAfterMs: SessionRunnerRetry.RETRY_AFTER_CEILING_MS + 1 }),
    )
    const subscriptionReset = llm(new RateLimitReason({ message: "rate", retryAfterMs: 5 * 60 * 60 * 1000 }))

    expect(SessionRunnerRetry.isRetryable(withinCeiling)).toBe(true)
    expect(SessionRunnerRetry.isRetryable(beyondCeiling)).toBe(false)
    expect(SessionRunnerRetry.isRetryable(subscriptionReset)).toBe(false)
  })

  test("keeps rate limits without a reset hint retryable", () => {
    expect(SessionRunnerRetry.isRetryable(llm(new RateLimitReason({ message: "rate" })))).toBe(true)
  })

  test("applies the same ceiling to provider-internal backoff hints", () => {
    const beyondCeiling = llm(
      new ProviderInternalReason({
        message: "internal",
        status: 503,
        retryAfterMs: SessionRunnerRetry.RETRY_AFTER_CEILING_MS + 1,
      }),
    )
    expect(SessionRunnerRetry.isRetryable(beyondCeiling)).toBe(false)
  })

  test("surfaces a long provider reset as an actionable rate-limit session error", () => {
    expect(
      toSessionError(
        llm(
          new RateLimitReason({
            message: "Provider reported rate_limit_error (Claude subscription usage limit reached)",
            retryAfterMs: 5 * 60 * 60 * 1000,
          }),
        ),
      ),
    ).toEqual({
      type: "provider.rate-limit",
      message: "Provider reported rate_limit_error (Claude subscription usage limit reached)",
    })
  })
})
