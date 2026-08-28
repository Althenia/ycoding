export * as ConfigNtfy from "./ntfy"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigV2.Ntfy")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  topic: Schema.String.pipe(Schema.optional),
}) {}
