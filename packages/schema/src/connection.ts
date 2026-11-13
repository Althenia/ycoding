export * as Connection from "./connection.js"

import { Schema } from "effect"
import { Credential } from "./credential.js"
import { optional } from "./schema.js"

export interface CredentialInfo extends Schema.Schema.Type<typeof CredentialInfo> {}
export const CredentialInfo = Schema.Struct({
  type: Schema.Literal("credential"),
  id: Credential.ID,
  label: Schema.String,
  /** Whether this stored credential is the active profile for its integration. */
  active: Schema.Boolean,
  /** Whether the stored credential came from an OAuth sign-in or an API key. Absent from older servers. */
  kind: Schema.Literals(["oauth", "key"]).pipe(optional),
  status: Schema.Literals(["connected", "expired", "refresh_failed"]).pipe(optional),
  message: optional(Schema.String),
}).annotate({ identifier: "Connection.CredentialInfo" })

export interface EnvInfo extends Schema.Schema.Type<typeof EnvInfo> {}
export const EnvInfo = Schema.Struct({
  type: Schema.Literal("env"),
  name: Schema.String,
}).annotate({ identifier: "Connection.EnvInfo" })

export const Info = Schema.Union([CredentialInfo, EnvInfo])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Connection.Info" })
export type Info = typeof Info.Type
