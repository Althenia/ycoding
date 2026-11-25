export * as ConfigDots from "./dots"

import { Schema } from "effect"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable native Dots access from trusted global configuration (default: false).",
  }),
  profile: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  fullAccessExecutor: Schema.optional(
    Schema.Struct({
      environmentId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,256}$/)),
      harnessKeySha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    }),
  ).annotate({
    description:
      "Trusted global binding for the native Rust executor: exact environment ID and SHA-256 digest of the raw X25519 then MLKEM768 static public keys.",
  }),
  name: Schema.optional(Schema.String.check(Schema.isPattern(/^[\x21-\x7e](?:[\x20-\x7e]{0,98}[\x21-\x7e])?$/))).annotate({
    description:
      "Display label this computer registers with ChatGPT from trusted global configuration: 1-100 printable ASCII characters without leading or trailing spaces (default: host name plus a short installation suffix).",
  }),
}).check(Schema.makeFilter((value) => value.enabled !== true || value.profile !== undefined, {
  expected: "enabled Dots requires an explicit profile",
})).annotate({ identifier: "Config.Dots" })
