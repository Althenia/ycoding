export * as Config from "./config.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"

const Updated = ephemeral({
  type: "config.updated",
  schema: {},
})

export const Event = { Updated, Definitions: inventory(Updated) }

export const DiagnosticReason = Schema.Literals(["invalid-json", "invalid-values", "removed-keys"]).annotate({
  identifier: "Config.DiagnosticReason",
  description:
    "Why a document or item was rejected: unparsable JSON/JSONC, schema-invalid values, or removed or unknown keys.",
})
export type DiagnosticReason = typeof DiagnosticReason.Type

export interface Diagnostic extends Schema.Schema.Type<typeof Diagnostic> {}
export const Diagnostic = Schema.Struct({
  path: Schema.String.annotate({ description: "Configuration file path or virtual source containing the rejected item." }),
  reason: DiagnosticReason,
  jsonPath: optional(Schema.String).annotate({ description: "JSON path of the dropped or fail-closed item; absent for unparsable documents." }),
  failClosed: optional(Schema.Boolean).annotate({ description: "True when invalid security configuration is replaced with restrictive defaults." }),
  message: Schema.String.annotate({ description: "Human-readable detail naming the offending keys or values." }),
}).annotate({ identifier: "Config.Diagnostic" })
