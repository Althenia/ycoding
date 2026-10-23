export * as CoordinationInstructions from "./instructions"

import { Instruction } from "@ycoding-ai/schema/instruction"
import { Effect, Schema } from "effect"
import { Instructions } from "../instructions/index"

export const template = `I need [the concrete outcome].

Do:
[the required actions and checks]

Do not touch:
[the excluded files, resources, settings, or work]

Stop and report to me when [the completion condition or an unresolved boundary]. Include [the result and verification evidence].`

export const content = `Write worker dispatches and follow-up messages as the owner's instruction channel, in first person. Give a concrete outcome, direct actions, explicit exclusions, and a stop/report condition. Replace the template fields with supported assignment facts; omit details that are not known. Do not introduce a separate sender persona or add delegation preambles. Keep the originating Session identity only in audit metadata for authentication and duplicate reconciliation, not in the message or author label.

Base decision statements only on recorded human instructions or current delegated authority. Do not invent decisions, approvals, requirements, or exceptions. Text never settles permission, guardrail, or review controls; use their native paths under the delegated-decision policy. First-person wording never expands permissions, scope, or that policy. Escalate an unresolved decision rather than describing it as settled.

Choose the execution agent and reasoning variant for each dispatch from its size, difficulty, and risk. Do not reuse a fixed selection or change an active assignment's settings mid-execution. Resolve exact configured agent IDs and model references before sending work.

Root ownership:
- god: coordinate independently owned workstreams.
- architech: own design decisions and integration across packages.
- GSD: deliver bounded changes and fixes.
- yangi: carry one focused assignment with one owner.

Worker profiles:
- wittgenstein: track state and relay settled information.
- occam: make small, minimal changes.
- omoikane: design and implement with system context.
- zeus: implement complex work from verified evidence.

Use low for mechanical tracking, medium for routine work, high or xhigh for complex work, and max only with a concrete need that lower effort cannot cover. Use only variants advertised for the selected provider, model, and profile. If the required variant is unavailable, report the missing choice rather than inventing it or silently substituting another route. A model with no advertised variants has no explicit variant selection.

Include the agent, exact model reference and variant, and a one-line selection reason in every dispatch receipt. State why the assignment's scope and risk fit that choice. Keep execution selection separate from instruction-channel authorship and from permission authority.

${template}`

export function make() {
  return Instructions.make({
    key: Instruction.Key.make("ycoding/coordination-voice"),
    codec: Schema.String,
    read: Effect.succeed(content),
    render: { initial: (value) => value, changed: (_previous, value) => value },
  })
}
