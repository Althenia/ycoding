export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"
import { Hash } from "../util/hash"

const Percent = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 }))
export const Advisory = Schema.Union([
  Schema.Literal(false),
  Schema.Struct({
    consider_percent: Percent,
    strongly_advised_percent: Percent,
  }).check(
    Schema.makeFilter((value) => value.consider_percent < value.strongly_advised_percent, {
      expected: "consider_percent lower than strongly_advised_percent",
    }),
  ),
])
export type Advisory = typeof Advisory.Type

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  keep_recent_messages: NonNegativeInt.pipe(Schema.optional),
  reserved_output_tokens: NonNegativeInt.pipe(Schema.optional),
  context_safety_margin_tokens: NonNegativeInt.pipe(Schema.optional),
  timeout_seconds: NonNegativeInt.pipe(Schema.optional),
  max_output_tokens: NonNegativeInt.pipe(Schema.optional),
  max_manifest_bytes: NonNegativeInt.pipe(Schema.optional),
  max_internal_passes: NonNegativeInt.pipe(Schema.optional),
  advisory: Advisory.pipe(Schema.optional),
}) {}

export interface Resolved {
  readonly keepRecentMessages: number
  readonly reservedOutputTokens: number
  readonly contextSafetyMarginTokens: number
  readonly timeoutSeconds: number
  readonly maxOutputTokens: number
  readonly maxManifestBytes: number
  readonly maxInternalPasses: number
  readonly advisory: false | { readonly considerPercent: number; readonly stronglyAdvisedPercent: number }
}

const defaults: Resolved = {
  keepRecentMessages: 20,
  reservedOutputTokens: 0,
  contextSafetyMarginTokens: 4_096,
  timeoutSeconds: 60,
  maxOutputTokens: 0,
  maxManifestBytes: 65_536,
  maxInternalPasses: 8,
  advisory: { considerPercent: 70, stronglyAdvisedPercent: 90 },
}

const algorithmRevision = 3

export const admissionDigest = (policy: Resolved, revision = algorithmRevision) =>
  Hash.sha256(JSON.stringify({ revision, policy }))

export const resolve = (infos: ReadonlyArray<Info>): Resolved =>
  infos.reduce<Resolved>(
    (result, info) => ({
      keepRecentMessages: info.keep_recent_messages ?? result.keepRecentMessages,
      reservedOutputTokens: info.reserved_output_tokens ?? result.reservedOutputTokens,
      contextSafetyMarginTokens: info.context_safety_margin_tokens ?? result.contextSafetyMarginTokens,
      timeoutSeconds: info.timeout_seconds ?? result.timeoutSeconds,
      maxOutputTokens: info.max_output_tokens ?? result.maxOutputTokens,
      maxManifestBytes: info.max_manifest_bytes ?? result.maxManifestBytes,
      maxInternalPasses: info.max_internal_passes ?? result.maxInternalPasses,
      advisory:
        info.advisory === undefined
          ? result.advisory
          : info.advisory === false
            ? false
            : {
                considerPercent: info.advisory.consider_percent,
                stronglyAdvisedPercent: info.advisory.strongly_advised_percent,
              },
    }),
    defaults,
  )
