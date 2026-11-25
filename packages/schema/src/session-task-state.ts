import { Schema } from "effect"

export const SessionTaskState = Schema.Literals([
  "starting", "running", "waiting", "supervising", "cancelling", "cancelled", "completed", "failed", "lost",
])
