export * as ConfigAutonomy from "./autonomy"

import { Schema } from "effect"
import { SessionAutonomy } from "@ycoding-ai/schema/session-autonomy"
import { NonNegativeInt } from "../schema"

export const Defaults = Schema.Struct({
  permissions: SessionAutonomy.DecisionMode.pipe(Schema.optional),
  guardrails: SessionAutonomy.DecisionMode.pipe(Schema.optional),
  answers: SessionAutonomy.DecisionMode.pipe(Schema.optional),
  yolo_accepted_at: Schema.Struct({
    permissions: NonNegativeInt.pipe(Schema.optional),
    guardrails: NonNegativeInt.pipe(Schema.optional),
    answers: NonNegativeInt.pipe(Schema.optional),
  }).pipe(Schema.optional),
}).annotate({ identifier: "Config.Autonomy.Defaults" })

export class Info extends Schema.Class<Info>("Config.Autonomy")({
  defaults: Defaults.pipe(Schema.optional).annotate({
    description:
      "Global-only saved default mode of each autonomy category for new root Sessions (default: manual). A yolo category requires its yolo_accepted_at timestamp and reads as manual without it.",
  }),
}) {}
