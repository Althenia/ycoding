export const UNSETTLED_STEP_MESSAGE = "Provider did not settle the step"

export const ANSWERLESS_AFTER_RECOVERY_MESSAGE =
  "The provider returned no answer after text-only recovery. Retry the request or choose another model."

export const isUnfinishedEnding = (error: { readonly type: string; readonly message: string } | undefined) =>
  error?.type === "provider.invalid-output" &&
  (error.message === UNSETTLED_STEP_MESSAGE || error.message === ANSWERLESS_AFTER_RECOVERY_MESSAGE)
