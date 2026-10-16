export * as ConfigAnalyticsRetention from "./analytics-retention"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("Config.AnalyticsRetention")({
  usage_days: PositiveInt.pipe(Schema.optional),
  latency_days: PositiveInt.pipe(Schema.optional),
  incident_days: PositiveInt.pipe(Schema.optional),
}) {}
