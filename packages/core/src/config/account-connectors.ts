export * as ConfigAccountConnectors from "./account-connectors"

import { Schema } from "effect"

export class ChatGPT extends Schema.Class<ChatGPT>("Config.AccountConnectors.ChatGPT")({
  enabled: Schema.Boolean,
  profile: Schema.String.check(Schema.isNonEmpty()).pipe(Schema.optional),
  connectors: Schema.Record(Schema.String, Schema.Literals(["allow", "deny"])).pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("Config.AccountConnectors")({
  chatgpt: ChatGPT.pipe(Schema.optional),
  claude: Schema.Struct({
    enabled: Schema.Boolean,
    profile: Schema.String.check(Schema.isNonEmpty()).pipe(Schema.optional),
    connectors: Schema.Record(Schema.String, Schema.Literals(["allow", "deny"])).pipe(Schema.optional),
  }).pipe(Schema.optional),
}) {}

export type Claude = NonNullable<Info["claude"]>
