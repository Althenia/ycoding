export * as Lifecycle from "./lifecycle.js"

import { Schema } from "effect"

export const Decision = Schema.Literals(["continue", "recover", "complete"]).annotate({
  identifier: "Lifecycle.Decision",
})
export type Decision = typeof Decision.Type

/**
 * What the evaluated step produced. `tool_results` needs another step to consume them, `answered` ended
 * with assistant text, `truncated` hit the output limit, `silent` settled without text or tool calls, and
 * `unsettled` ended without a finish reason.
 */
export const Basis = Schema.Literals(["tool_results", "answered", "truncated", "silent", "unsettled"]).annotate({
  identifier: "Lifecycle.Basis",
})
export type Basis = typeof Basis.Type
