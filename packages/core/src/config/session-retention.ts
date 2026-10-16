export * as ConfigSessionRetention from "./session-retention"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("Config.SessionRetention")({
  days: PositiveInt.pipe(Schema.optional),
  records_days: PositiveInt.pipe(Schema.optional),
}) {}
