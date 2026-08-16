export * as ConfigEfficiency from "./efficiency"

import { Schema } from "effect"
import { ConfigModel } from "./model"

export class PromptCache extends Schema.Class<PromptCache>("ConfigEfficiency.PromptCache")({
  anthropic_ttl: Schema.Literals(["adaptive", "5m", "1h"]).pipe(Schema.optional),
  openai_mode: Schema.Literals(["auto", "implicit", "explicit"]).pipe(Schema.optional),
  openai_extended_retention: Schema.Boolean.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigEfficiency.Info")({
  title: Schema.Literals(["local", "model", "off"]).pipe(Schema.optional),
  goal_synthesis: Schema.Literals(["local", "model"]).pipe(Schema.optional),
  helper_model: ConfigModel.Selection.pipe(Schema.optional),
  prompt_cache: PromptCache.pipe(Schema.optional),
  openai_responses_continuation: Schema.Literals(["auto", "on", "off"]).pipe(Schema.optional),
}) {}
