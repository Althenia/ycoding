export * as ConfigDots from "./dots"

import { Schema } from "effect"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable native Dots access from trusted global configuration (default: false).",
  }),
  profile: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
}).check(Schema.makeFilter((value) => value.enabled !== true || value.profile !== undefined, {
  expected: "enabled Dots requires an explicit profile",
})).annotate({ identifier: "Config.Dots" })
