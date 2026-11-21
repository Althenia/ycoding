export * as ConfigGoal from "./goal"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("Config.Goal")({
  stall_timeout_seconds: PositiveInt.pipe(Schema.optional),
}) {}

export const defaultStallTimeoutSeconds = 600

export const stallTimeoutSeconds = (info: Info | undefined) => info?.stall_timeout_seconds ?? defaultStallTimeoutSeconds
