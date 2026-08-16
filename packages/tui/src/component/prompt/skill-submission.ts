export async function submitPromptWithSkills<A>(input: {
  prompt: (resume: boolean, admitted?: A) => Promise<A>
  skills: Array<() => Promise<unknown>>
}) {
  for (const skill of input.skills) await skill()
  const admitted = await input.prompt(false)
  await input.prompt(true, admitted)
  return admitted
}
