export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  keep_recent_messages: NonNegativeInt.pipe(Schema.optional),
  reserved_output_tokens: NonNegativeInt.pipe(Schema.optional),
  context_safety_margin_tokens: NonNegativeInt.pipe(Schema.optional),
  timeout_seconds: NonNegativeInt.pipe(Schema.optional),
  max_output_tokens: NonNegativeInt.pipe(Schema.optional),
  max_summary_bytes: NonNegativeInt.pipe(Schema.optional),
  max_internal_passes: NonNegativeInt.pipe(Schema.optional),
}) {}
