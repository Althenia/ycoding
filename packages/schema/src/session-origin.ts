import { Schema } from "effect"

export const Origin = Schema.Literal("dots-executor").annotate({ identifier: "Session.Origin" })
export type Origin = typeof Origin.Type
