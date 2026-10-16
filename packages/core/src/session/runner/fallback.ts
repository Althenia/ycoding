export * as SessionModelFallback from "./fallback"

import type { LLMError } from "@ycoding-ai/ai"
import { Model } from "@ycoding-ai/schema/model"
import { Config } from "../../config"
import { SessionRunnerModel } from "./model"
import { SessionRunnerRetry } from "./retry"

export function immediate(error: LLMError) {
  switch (error.reason._tag) {
    case "QuotaExceeded":
    case "NoRoute":
      return true
    case "RateLimit":
    case "ProviderInternal":
      return error.reason.retryAfterMs !== undefined && error.reason.retryAfterMs > SessionRunnerRetry.RETRY_AFTER_CEILING_MS
    case "Transport":
    case "Authentication":
    case "ContentPolicy":
    case "InvalidProviderOutput":
    case "InvalidRequest":
    case "UnknownProvider":
      return false
    default: {
      const exhaustive: never = error.reason
      return exhaustive
    }
  }
}

export function unavailable(
  error: unknown,
): error is
  | SessionRunnerModel.ModelUnavailableError
  | SessionRunnerModel.VariantUnavailableError
  | SessionRunnerModel.UnsupportedPackageError {
  return (
    error instanceof SessionRunnerModel.ModelUnavailableError ||
    error instanceof SessionRunnerModel.VariantUnavailableError ||
    error instanceof SessionRunnerModel.UnsupportedPackageError
  )
}

export function next(entries: readonly Config.Entry[], primary: Model.Ref, tried: ReadonlyArray<Model.Ref>) {
  return (Config.latest(entries, "model_fallbacks")?.[`${primary.providerID}/${primary.id}`] ?? [])
    .map((entry) =>
      Model.Ref.make({
        providerID: entry.providerID,
        id: entry.model,
        ...(entry.variant === undefined ? {} : { variant: entry.variant }),
        ...(entry.profile === undefined ? {} : { profile: entry.profile }),
      }),
    )
    .find((candidate) => !tried.some((model) => same(model, candidate)))
}

export function same(left: Model.Ref, right: Model.Ref) {
  return (
    left.providerID === right.providerID &&
    left.id === right.id &&
    left.variant === right.variant &&
    left.profile === right.profile
  )
}
