export * as ConfigDots from "./dots"

import { Schema } from "effect"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable native Dots access from trusted global configuration (default: false).",
  }),
  profile: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  name: Schema.optional(Schema.String.check(Schema.isPattern(/^[\x21-\x7e](?:[\x20-\x7e]{0,98}[\x21-\x7e])?$/))).annotate({
    description:
      "Display label this computer registers with ChatGPT from trusted global configuration: 1-100 printable ASCII characters without leading or trailing spaces (default: host name plus a short installation suffix).",
  }),
}).check(Schema.makeFilter((value) => value.enabled !== true || value.profile !== undefined, {
  expected: "enabled Dots requires an explicit profile",
})).annotate({ identifier: "Config.Dots" })
