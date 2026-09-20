export * as Config from "./config.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"

const Updated = ephemeral({
  type: "config.updated",
  schema: {},
})

export const Event = { Updated, Definitions: inventory(Updated) }

/**
 * Where a configuration document came from. `global` is the platform configuration directory,
 * `project` is any discovered project document, and `virtual` is a document without a file path
 * such as well-known integration configuration or inline `YCODING_CONFIG_CONTENT`.
 */
export const Scope = Schema.Literals(["global", "project", "virtual"]).annotate({ identifier: "Config.Scope" })
export type Scope = typeof Scope.Type

/** A writable configuration file scope. Session overrides are not configuration files. */
export const WriteScope = Schema.Literals(["global", "project"]).annotate({ identifier: "Config.WriteScope" })
export type WriteScope = typeof WriteScope.Type

/** A configuration document that contributed to the effective values, lowest priority first. */
export class Source extends Schema.Class<Source>("Config.Source")({
  path: Schema.String.annotate({ description: "Absolute path of the configuration document." }),
  scope: Scope,
  keys: Schema.Array(Schema.String).annotate({
    description: "Top-level configuration keys this document defines.",
  }),
  revision: Schema.String.annotate({
    description:
      "SHA-256 of the document's raw bytes, before `{env:}` and `{file:}` substitution. Pass it back as expectedRevision to detect a concurrent edit.",
  }),
}) {}

/**
 * Effective configuration with provenance. Secret-bearing leaves are replaced by
 * `Config.REDACTED`; values are otherwise the settled values after priority folding.
 */
export class Read extends Schema.Class<Read>("Config.Read")({
  values: Schema.Record(Schema.String, Schema.Json).annotate({
    description:
      "Effective top-level configuration values. Credential material, provider headers, and MCP environment values are redacted.",
  }),
  sources: Schema.Array(Source),
}) {}

/** One top-level key the patch would set or remove. */
export class Change extends Schema.Class<Change>("Config.Change")({
  key: Schema.String,
  value: optional(Schema.Json).annotate({ description: "Absent when the patch removes the key." }),
}) {}

/** A validated patch that has not been written. */
export class Preview extends Schema.Class<Preview>("Config.Preview")({
  scope: WriteScope,
  path: Schema.String,
  revision: Schema.String.annotate({
    description: "Revision of the document the patch was validated against. Pass this back as expectedRevision.",
  }),
  result: Schema.String.annotate({ description: "Revision the document would have after the patch." }),
  changes: Schema.Array(Change),
}) {}

/** A committed patch and the settled readback. */
export class Commit extends Schema.Class<Commit>("Config.Commit")({
  scope: WriteScope,
  path: Schema.String,
  revision: Schema.String,
  changes: Schema.Array(Change),
  unsettled: Schema.Array(Schema.String).annotate({
    description: "Patched keys whose effective value is still owned by another source after the write.",
  }),
  read: Read,
}) {}

/** A validated patch request. `patch` is a partial configuration document keyed by top-level key. */
export class Patch extends Schema.Class<Patch>("Config.Patch")({
  patch: Schema.Record(Schema.String, Schema.Json).annotate({
    description:
      "Top-level configuration keys to set. A null value removes the key. Nested objects replace the whole subtree.",
  }),
  scope: WriteScope,
  expectedRevision: optional(Schema.String).annotate({
    description: "Revision from a previous read or preview. A mismatch fails the write without modifying the file.",
  }),
}) {}

/** The sentinel replacing secret-bearing values in configuration reads. */
export const REDACTED = "[redacted]"
