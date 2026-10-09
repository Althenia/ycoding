export * as Config from "./config.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"

const Updated = ephemeral({
  type: "config.updated",
  schema: {},
})

export const Event = { Updated, Definitions: inventory(Updated) }

export const DiagnosticReason = Schema.Literals(["invalid-json", "invalid-values", "removed-keys"]).annotate({
  identifier: "Config.DiagnosticReason",
  description:
    "Why a configuration document was ignored: unparsable JSON/JSONC, values rejected by the configuration schema, or keys the current runtime rejects.",
})
export type DiagnosticReason = typeof DiagnosticReason.Type

export interface Diagnostic extends Schema.Schema.Type<typeof Diagnostic> {}
export const Diagnostic = Schema.Struct({
  path: Schema.String.annotate({ description: "Configuration file path or virtual source that was ignored." }),
  reason: DiagnosticReason,
  message: Schema.String.annotate({ description: "Human-readable detail naming the offending keys or values." }),
}).annotate({ identifier: "Config.Diagnostic" })
