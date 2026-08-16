export * as ProjectArtifactInstructions from "./instructions"

import { Instruction } from "@ycoding-ai/schema/instruction"
import { Effect, Schema } from "effect"
import { Instructions } from "../instructions/index"

export const content =
  "At a safe boundary after the primary task is complete and validated, create or update at most one Project Artifact for each newly learned reusable insight. The insight must be repeated, durable, repository-specific, and useful in future work. Never persist transient task state, current todos, user preferences, prompts, logs, secrets, credentials, private paths or URLs, customer data, or speculation. Search existing artifacts first and update the owned project version rather than duplicating it. Prefer a skill; use a command only for an invokable instruction-only template; use a least-privilege agent only for a genuine reusable role. Workflows are not a first-class artifact. Never create or enable a plugin automatically. Do not interrupt the primary task to author an artifact."

export function make() {
  return Instructions.make({
    key: Instruction.Key.make("ycoding/project-artifact-authoring"),
    codec: Schema.String,
    read: Effect.succeed(content),
    render: {
      initial: (value) => value,
      changed: (_previous, value) => value,
    },
  })
}
