export * as SessionSkillStatus from "./session-skill-status.js"

import { Schema } from "effect"
import { SessionMessage } from "./session-message.js"
import { Skill } from "./skill.js"

export const State = Schema.Union([
  Schema.Struct({ state: Schema.Literal("active") }),
  Schema.Struct({
    state: Schema.Literal("inactive"),
    inactiveReason: Schema.Literals(["agent_switched", "compacted"]),
  }),
])
export type State = typeof State.Type

export const Conflict = Schema.Struct({
  type: Schema.Literals(["skill", "instruction"]),
  id: Schema.String,
  name: Schema.String,
})
export type Conflict = typeof Conflict.Type

const Fields = {
  id: Skill.ID,
  name: Skill.Name,
  activatedBy: Schema.Literals(["reference", "tool"]),
  activationMessageID: SessionMessage.ID,
  content: Schema.String,
  conflicts: Schema.Array(Conflict),
  declarations: Skill.Conflicts,
}

export const Info = Schema.Union([
  Schema.Struct({ ...Fields, state: Schema.Literal("active"), inactiveReason: Schema.Never.pipe(Schema.optional) }),
  Schema.Struct({
    ...Fields,
    state: Schema.Literal("inactive"),
    inactiveReason: Schema.Literals(["agent_switched", "compacted"]),
  }),
])
export type Info = typeof Info.Type
