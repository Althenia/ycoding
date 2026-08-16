import { describe, expect, test } from "bun:test"
import { isContextOverflow } from "../src"
import { classifyProviderFailure, rateLimitDetails } from "../src/provider-error"
import { HttpRateLimitDetails } from "../src/schema"

describe("provider error classification", () => {
  test("classifies provider token limit messages as context overflow", () => {
    const messages = [
      "tokens in request more than max tokens allowed",
      '{"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
      "Requested token count exceeds the model's maximum context length of 131072 tokens.",
      "Input length (265330) exceeds model's maximum context length (262144).",
      "Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
      "The input (516368 tokens) is longer than the model's context length (262144 tokens).",
      "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
      "Too many tokens",
      "Token limit exceeded",
    ]

    expect(messages.every(isContextOverflow)).toBe(true)
  })

  test("does not classify rate limits as context overflow", () => {
    const messages = [
      "Throttling error: Too many tokens, please wait before trying again.",
      "Rate limit exceeded, please retry after 30 seconds.",
      "Too many requests. Please slow down.",
    ]

    expect(messages.some(isContextOverflow)).toBe(false)
  })

  test("classifies V1 plain-text rate limit fallbacks", () => {
    expect(
      [
        "Request rate increased too quickly",
        "Rate limit exceeded, please try again later",
        "Too many requests, please slow down",
      ].map((message) => classifyProviderFailure({ message })._tag),
    ).toEqual(["RateLimit", "RateLimit", "RateLimit"])
  })

  test("classifies V1 JSON rate limit fallbacks", () => {
    expect(
      [
        '{"type":"error","error":{"type":"too_many_requests"}}',
        '{"type":"error","error":{"code":"rate_limit_exceeded"}}',
        '{"code":"bad_request","error":{"code":"rate_limit_exceeded"}}',
        '{"type":"error","error":{"code":"unknown","type":"too_many_requests"}}',
      ].map((message) => classifyProviderFailure({ message })._tag),
    ).toEqual(["RateLimit", "RateLimit", "RateLimit", "RateLimit"])
  })

  test("classifies V1 overloaded provider codes", () => {
    expect(
      ['{"code":"resource_exhausted"}', '{"code":"service_unavailable"}'].map(
        (message) => classifyProviderFailure({ message })._tag,
      ),
    ).toEqual(["ProviderInternal", "ProviderInternal"])
  })

  test("classifies nested provider codes when a top-level code is also present", () => {
    expect(
      [
        '{"code":"bad_request","error":{"code":"usage_not_included"}}',
        '{"code":"bad_request","error":{"code":"server_error"}}',
        '{"code":"bad_request","error":{"type":"invalid_request_error"}}',
      ].map((message) => classifyProviderFailure({ message })._tag),
    ).toEqual(["QuotaExceeded", "ProviderInternal", "InvalidRequest"])
  })

  test("keeps unknown and malformed provider payloads non-retryable", () => {
    expect(classifyProviderFailure({ message: '{"error":{"message":"no_kv_space"}}' })._tag).toBe("UnknownProvider")
    expect(classifyProviderFailure({ message: '{"type":"error","error":{"code":123}}' })._tag).toBe("UnknownProvider")
    expect(classifyProviderFailure({ message: "not-json" })._tag).toBe("UnknownProvider")
  })

  test("classifies a status-less streamed rate_limit_error as a retryable rate limit", () => {
    expect(classifyProviderFailure({ message: "rate_limit_error", code: "rate_limit_error" })._tag).toBe("RateLimit")
  })

  test("explains the reset window when only rate-limit headers are available", () => {
    const reason = classifyProviderFailure({
      status: 429,
      message: "Provider reported rate_limit_error",
      code: "rate_limit_error",
      retryAfterMs: 90_000,
      rateLimit: new HttpRateLimitDetails({
        retryAfterMs: 90_000,
        reset: { requests: "2026-07-25T18:00:00Z" },
      }),
    })
    expect(reason._tag).toBe("RateLimit")
    expect(reason.message).toBe(
      "Provider reported rate_limit_error (retry after 90s; requests resets at 2026-07-25T18:00:00Z)",
    )
  })

  test("names the Claude subscription limit when unified rate-limit headers are present", () => {
    const reason = classifyProviderFailure({
      status: 429,
      message: "Provider reported rate_limit_error",
      code: "rate_limit_error",
      rateLimit: new HttpRateLimitDetails({
        remaining: { "unified-5h": "0" },
        reset: { "unified-5h": "2026-07-25T18:00:00Z" },
      }),
    })
    expect(reason.message).toBe(
      "Provider reported rate_limit_error (Claude subscription usage limit reached; unified-5h resets at 2026-07-25T18:00:00Z)",
    )
  })

  test("leaves rate-limit messages untouched when no rate-limit detail exists", () => {
    expect(classifyProviderFailure({ status: 429, message: "Slow down" }).message).toBe("Slow down")
  })

  test("collects Anthropic unified rate-limit headers", () => {
    expect(
      rateLimitDetails(
        {
          "anthropic-ratelimit-unified-5h-limit": "100",
          "anthropic-ratelimit-unified-5h-remaining": "0",
          "anthropic-ratelimit-unified-5h-reset": "2026-07-25T18:00:00Z",
          "anthropic-ratelimit-unified-reset": "2026-07-25T18:00:00Z",
        },
        60_000,
      ),
    ).toEqual(
      new HttpRateLimitDetails({
        retryAfterMs: 60_000,
        limit: { "unified-5h": "100" },
        remaining: { "unified-5h": "0" },
        reset: { "unified-5h": "2026-07-25T18:00:00Z", unified: "2026-07-25T18:00:00Z" },
      }),
    )
  })

  test("returns no rate-limit details when nothing is present", () => {
    expect(rateLimitDetails({ "content-type": "application/json" }, undefined)).toBeUndefined()
  })
})
