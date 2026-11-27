export * as AutonomyDefaults from "./autonomy-defaults.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"

export const Mode = Schema.Literals(["manual", "yolo", "auto"]).annotate({ identifier: "AutonomyDefaults.Mode" })
export type Mode = typeof Mode.Type

export const YoloAcceptedAt = Schema.Struct({
  permissions: NonNegativeInt.pipe(optional),
  guardrails: NonNegativeInt.pipe(optional),
  answers: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "AutonomyDefaults.YoloAcceptedAt" })
export type YoloAcceptedAt = typeof YoloAcceptedAt.Type

export const Info = Schema.Struct({
  permissions: Mode,
  guardrails: Mode,
  answers: Mode,
  yoloAcceptedAt: YoloAcceptedAt.pipe(optional),
}).annotate({ identifier: "AutonomyDefaults.Info" })
export type Info = typeof Info.Type

export const Change = Schema.Struct({
  permissions: Mode.pipe(optional),
  guardrails: Mode.pipe(optional),
  answers: Mode.pipe(optional),
  acceptYolo: Schema.Boolean.pipe(optional),
})
export type Change = typeof Change.Type
