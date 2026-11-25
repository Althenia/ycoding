import { Schema } from "effect"

export const AgentID = Schema.String.pipe(Schema.brand("Agent.ID"))
export type AgentID = typeof AgentID.Type
