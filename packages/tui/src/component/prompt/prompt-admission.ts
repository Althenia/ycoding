export async function submitPrompt<A>(input: {
  prompt: (resume: boolean, admitted?: A) => Promise<A>
  onPhase?: (phase: { type: "admission" } | { type: "wake" }) => void
  onAdmitted?: (admitted: A) => void | Promise<void>
}) {
  input.onPhase?.({ type: "admission" })
  const admitted = await input.prompt(false)
  await input.onAdmitted?.(admitted)
  input.onPhase?.({ type: "wake" })
  const wakeError = await input.prompt(true, admitted).then(
    () => undefined,
    (error) => error,
  )
  return wakeError === undefined ? { admitted } : { admitted, wakeError }
}
