export async function submitPromptWithSkills<A>(input: {
  prompt: (resume: boolean, admitted?: A) => Promise<A>
  skills: Array<() => Promise<unknown>>
  onPhase?: (phase: { type: "skill"; index: number; total: number } | { type: "admission" } | { type: "wake" }) => void
  onAdmitted?: (admitted: A) => void | Promise<void>
}) {
  for (const [index, skill] of input.skills.entries()) {
    input.onPhase?.({ type: "skill", index: index + 1, total: input.skills.length })
    await skill()
  }
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
