export * as ConfigDots from "./dots"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("Config.Dots")({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable the Dots native connector: destinations, binding, messaging, and runtime controls (default: false).",
  }),
}) {}
