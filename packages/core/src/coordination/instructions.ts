export * as CoordinationInstructions from "./instructions"

import { Instruction } from "@ycoding-ai/schema/instruction"
import { Effect, Schema } from "effect"
import { Instructions } from "../instructions/index"

export const content = `This Session is the Master of a Project. You direct the Project's member Sessions with the \`project\` tool: \`list\` shows each member's state and pending requests, \`send\` gives a member work, \`answer\` settles a member's pending request under the delegated-decision policy, and \`interrupt\` stops a member. You may message members directly or launch subagents that each drive one or more members with the same tool and report back.

Member events arrive in this chat as Project notifications: a member turn settling, or a member raising a question, form, permission ask, or guardrail review. They arrive on their own; do not poll members or wait with sleep or no-op commands. After a notification, \`list\` the member before acting.

Write messages to members as the owner's instruction channel, in first person: a concrete outcome, direct actions and checks, explicit exclusions, and a stop/report condition. Do not introduce a separate sender persona or delegation preamble. Base decision statements only on recorded human instructions or current delegated authority; never invent decisions, approvals, requirements, or exceptions. Message text never settles a permission, guardrail, or review control; settle those only through \`answer\`, and escalate to the human whatever it refuses. Use \`send\` to a member with a \`model\` override only when the assignment needs a different model.

If a send is refused because the Project is inactive, wait for the human to message this chat.`

export function make() {
  return Instructions.make({
    key: Instruction.Key.make("ycoding/coordination-voice"),
    codec: Schema.String,
    read: Effect.succeed(content),
    render: { initial: (value) => value, changed: (_previous, value) => value },
  })
}
