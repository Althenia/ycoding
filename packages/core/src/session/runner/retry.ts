export * as SessionRunnerRetry from "./retry";

import { LLMError } from "@ycoding-ai/ai";
import { SessionError } from "@ycoding-ai/schema/session-error";
import { Data, Duration, Effect, Schedule } from "effect";
import { EventV2 } from "../../event";
import { SessionEvent } from "../event";
import { SessionMessage } from "../message";
import { SessionSchema } from "../schema";
import type { SessionRunner } from "./index";

export class RetryableFailure extends Data.TaggedError(
  "SessionRunner.RetryableFailure",
)<{
  readonly cause: LLMError;
  readonly assistantMessageID: SessionMessage.ID;
  readonly error: SessionError.Error;
  readonly step: number;
}> {}

/**
 * Longest provider-requested backoff we will sleep through. Anthropic
 * subscription OAuth 429s can carry a multi-hour reset, and
 * sitting on one is indistinguishable from a hung session. Past this ceiling we
 * stop retrying and let the rate-limit message — which carries the reset time —
 * reach the user immediately. We never retry *sooner* than the provider asked;
 * the choice is only between waiting and reporting.
 */
export const RETRY_AFTER_CEILING_MS = 120_000;
export const MAX_ATTEMPTS = 10;

const reasonRetryAfterMs = (reason: LLMError["reason"]) =>
  reason._tag === "RateLimit" || reason._tag === "ProviderInternal"
    ? reason.retryAfterMs
    : undefined;

export function isRetryable(error: LLMError) {
  const backoff = reasonRetryAfterMs(error.reason);
  if (backoff !== undefined && backoff > RETRY_AFTER_CEILING_MS) return false;
  switch (error.reason._tag) {
    case "RateLimit":
    case "ProviderInternal":
    case "Transport":
      return true;
    case "Authentication":
    case "QuotaExceeded":
    case "ContentPolicy":
    case "InvalidProviderOutput":
    case "InvalidRequest":
    case "NoRoute":
    case "UnknownProvider":
      return false;
    default: {
      const exhaustive: never = error.reason;
      return exhaustive;
    }
  }
}

const retryAfter = (failure: RetryableFailure) =>
  reasonRetryAfterMs(failure.cause.reason);

export const schedule = (
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  attemptsBeforeRetry: number,
) =>
  Schedule.max([
    Schedule.exponential("2 seconds"),
    Schedule.recurs(Math.max(0, MAX_ATTEMPTS - attemptsBeforeRetry - 1)),
  ]).pipe(
    Schedule.setInputType<RetryableFailure | SessionRunner.RunError>(),
    Schedule.passthrough,
    Schedule.while(({ input }) => input instanceof RetryableFailure),
    Schedule.modifyDelay(({ input: failure, duration: delay }) => {
      const minimum =
        failure instanceof RetryableFailure ? retryAfter(failure) : undefined;
      const exponential = Duration.min(delay, Duration.millis(RETRY_AFTER_CEILING_MS));
      return Effect.succeed(
        minimum === undefined
          ? exponential
          : Duration.max(exponential, Duration.millis(minimum)),
      );
    }),
    Schedule.tap((metadata) =>
      metadata.input instanceof RetryableFailure
        ? events.publish(SessionEvent.RetryScheduled, {
            sessionID,
            assistantMessageID: metadata.input.assistantMessageID,
            attempt: attemptsBeforeRetry + metadata.attempt + 1,
            at: metadata.now + Duration.toMillis(metadata.duration),
            error: metadata.input.error,
          })
        : Effect.void,
    ),
  );
