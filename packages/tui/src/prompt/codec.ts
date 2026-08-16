import type { Prompt, PromptInput } from "@ycoding-ai/schema"
import type { Types } from "effect"

export type EditablePromptInput = Types.DeepMutable<PromptInput.Prompt>

export function projectedPromptInput(input: Pick<Prompt, "text" | "files" | "agents">): EditablePromptInput {
  return {
    text: input.text,
    files: input.files?.map((file) => ({
      uri: `ycoding-attachment://sha256/${file.content.digest}`,
      name: file.name,
      description: file.description,
      mention: file.mention ? { ...file.mention } : undefined,
    })),
    agents: input.agents?.map((agent) => ({
      name: agent.name,
      mention: agent.mention ? { ...agent.mention } : undefined,
    })),
  }
}
