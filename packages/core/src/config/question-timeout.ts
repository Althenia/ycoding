export * as ConfigQuestionTimeout from "./question-timeout"

import { Duration, Schema } from "effect"
import { NonNegativeInt } from "../schema"

export const MAX_SECONDS = 86_400
export const DEFAULT_SECONDS = 300

export const Seconds = NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_SECONDS))

export const seconds = (configured: number | undefined) => configured ?? DEFAULT_SECONDS

export const duration = (configured: number | undefined) => {
  const value = seconds(configured)
  return value === 0 ? undefined : Duration.seconds(value)
}
