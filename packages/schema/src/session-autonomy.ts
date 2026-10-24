export * as SessionAutonomy from "./session-autonomy.js"

import { Schema } from "effect"

export const DecisionMode = Schema.Literals(["manual", "yolo", "auto"]).annotate({
  identifier: "SessionAutonomy.DecisionMode",
})
export type DecisionMode = typeof DecisionMode.Type

export const Category = Schema.Literals(["permissions", "guardrails", "answers"]).annotate({
  identifier: "SessionAutonomy.Category",
})
export type Category = typeof Category.Type

export interface Decisions extends Schema.Schema.Type<typeof Decisions> {}
export const Decisions = Schema.Struct({
  permissions: DecisionMode,
  guardrails: DecisionMode,
  answers: DecisionMode,
}).annotate({ identifier: "SessionAutonomy.Decisions" })
