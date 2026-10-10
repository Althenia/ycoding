export * as ConfigPrediction from "./prediction"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("Config.Prediction")({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Suggest the next user message after an idle reply (default: false). Acceptance fills the composer only.",
  }),
  memory: Schema.optional(Schema.Boolean).annotate({
    description:
      "Use bounded workspace-memory search snippets in prediction requests when memory_read allows (default: true). Consulted only when enabled.",
  }),
}) {}

export const resolve = (infos: readonly Info[]) =>
  infos.reduce(
    (settings, info) => ({ enabled: info.enabled ?? settings.enabled, memory: info.memory ?? settings.memory }),
    { enabled: false, memory: true },
  )
