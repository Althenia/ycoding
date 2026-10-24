export * as AntigravityUsage from "./antigravity"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Option, Schema } from "effect"
import { Provider } from "../provider"

const Fraction = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))
const Entry = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  quotaInfo: Schema.optional(
    Schema.Struct({
      remainingFraction: Schema.optional(Fraction),
      resetTime: Schema.optional(Schema.String),
    }),
  ),
})
const Payload = Schema.Struct({ models: Schema.Record(Schema.String, Schema.Unknown) })
const decode = Schema.decodeUnknownOption(Payload)
const decodeEntry = Schema.decodeUnknownOption(Entry)
const providerID = Provider.ID.make("antigravity")

export function normalize(payload: unknown, updatedAt: number) {
  const decoded = Option.getOrUndefined(decode(payload))
  if (!decoded) return undefined
  return new ProviderUsage.Snapshot({
    providerID,
    label: "Antigravity",
    status: "available",
    source: "provider_internal_api",
    stability: "client_contract",
    updatedAt: Math.max(0, Math.trunc(updatedAt)),
    windows: Object.entries(decoded.models)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .flatMap(([id, row]) => {
        const entry = Option.getOrUndefined(decodeEntry(row))
        if (!entry) return []
        const remaining = entry.quotaInfo?.remainingFraction
        if (remaining === undefined) return []
        const resetAt = entry.quotaInfo?.resetTime ? Date.parse(entry.quotaInfo.resetTime) : Number.NaN
        return [
          new ProviderUsage.Window({
            id,
            label: entry.displayName ?? id,
            unit: "percent",
            used: (1 - remaining) * 100,
            ...(Number.isFinite(resetAt) ? { resetAt } : {}),
          }),
        ]
      }),
  })
}
