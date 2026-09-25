export * as MemoryInstructions from "./instructions"

import { Instruction } from "@ycoding-ai/schema/instruction"
import { Effect, Schema } from "effect"
import { Instructions } from "../instructions/index"

export const content =
  "The memory tool stores durable linked Markdown knowledge: repository scope for this repository and its worktrees, knowledge scope for concepts shared across repositories. Before substantive work, search memory for relevant decisions, constraints, and gotchas, then verify retrieved facts against live files before relying on them. At a safe boundary after the primary task is complete and validated, write or update one concept for each newly verified, durable, non-obvious fact or decision that future work needs, citing its sources; read an existing concept first and pass its digest. Never store transient task state, transcripts, logs, secrets, credentials, private URLs, customer data, or speculation. Do not interrupt the primary task to maintain memory."

export function make() {
  return Instructions.make({
    key: Instruction.Key.make("ycoding/workspace-memory"),
    codec: Schema.String,
    read: Effect.succeed(content),
    render: {
      initial: (value) => value,
      changed: (_previous, value) => value,
    },
  })
}
