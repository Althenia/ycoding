export function previewBuildNumber(
  input: {
    readonly now?: Date
    readonly runNumber?: string
    readonly runAttempt?: string
  } = {},
) {
  if (!input.runNumber) return (input.now ?? new Date()).toISOString().replace(/\D/g, "").slice(0, 17)
  if (input.runAttempt && input.runAttempt !== "1") return `${input.runNumber}.${input.runAttempt}`
  return input.runNumber
}
