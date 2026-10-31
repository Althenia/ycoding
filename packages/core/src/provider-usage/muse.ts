export * as MuseUsage from "./muse"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Option, Schema } from "effect"
import { Provider } from "../provider"

const Percent = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Duration = Schema.Int.check(Schema.isGreaterThan(0))
const Subscription = Schema.Struct({
  tier: Schema.optional(Schema.NullOr(Schema.String)),
  window: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        used_percent: Schema.optional(Schema.NullOr(Percent)),
        resets_at: Schema.optional(Schema.NullOr(Timestamp)),
        window_duration_mins: Schema.optional(Schema.NullOr(Duration)),
      }),
    ),
  ),
  weekly: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        used_percent: Schema.optional(Schema.NullOr(Percent)),
        resets_at: Schema.optional(Schema.NullOr(Timestamp)),
      }),
    ),
  ),
})
const Event = Schema.Struct({ type: Schema.Literal("response.subscription_usage"), subscription: Subscription })
const decodeEvent = Schema.decodeUnknownOption(Event)
const decodeSubscription = Schema.decodeUnknownOption(Subscription)
const providerID = Provider.ID.make("muse")

export function label(tierName?: string | null) {
  const tier = tierName?.trim()
  return tier ? `Muse (Meta) · ${tier}` : "Muse (Meta)"
}

export function normalize(event: unknown, observedAt: number, tierName?: string | null) {
  const decoded = Option.getOrUndefined(decodeEvent(event))
  if (!decoded) return undefined
  return normalizeSubscription(decoded.subscription, observedAt, tierName)
}

export function normalizeSubscription(subscription: unknown, observedAt: number, tierName?: string | null) {
  const decoded = Option.getOrUndefined(decodeSubscription(subscription))
  if (!decoded) return undefined
  const window = decoded.window
  const weekly = decoded.weekly
  const minutes = window?.window_duration_mins ?? undefined
  return new ProviderUsage.Snapshot({
    providerID,
    label: label(tierName),
    status: "available",
    source: "response_stream",
    stability: "observed",
    updatedAt: Math.max(0, Math.trunc(observedAt)),
    windows: [
      ...(window
        ? [
            new ProviderUsage.Window({
              id: "window",
              label:
                minutes === undefined
                  ? "Window"
                  : minutes >= 60
                    ? `${minutes / 60}-hour window`
                    : `${minutes}-minute window`,
              unit: "percent",
              ...(window.used_percent == null ? {} : { used: window.used_percent }),
              ...(window.resets_at == null ? {} : { resetAt: window.resets_at * 1000 }),
              ...(minutes === undefined ? {} : { periodSeconds: minutes * 60 }),
            }),
          ]
        : []),
      ...(weekly
        ? [
            new ProviderUsage.Window({
              id: "weekly",
              label: "Weekly",
              unit: "percent",
              periodSeconds: 604800,
              ...(weekly.used_percent == null ? {} : { used: weekly.used_percent }),
              ...(weekly.resets_at == null ? {} : { resetAt: weekly.resets_at * 1000 }),
            }),
          ]
        : []),
    ],
  })
}

export function unreported(updatedAt: number, tierName?: string | null) {
  return new ProviderUsage.Snapshot({
    providerID,
    label: label(tierName),
    status: "unsupported",
    source: "response_stream",
    stability: "observed",
    updatedAt: Math.max(0, Math.trunc(updatedAt)),
    windows: [],
    message: "Quota is reported after the next Muse response",
  })
}

export function inactive(updatedAt: number) {
  return new ProviderUsage.Snapshot({
    providerID,
    label: "Muse (Meta)",
    status: "unsupported",
    source: "response_stream",
    stability: "observed",
    updatedAt: Math.max(0, Math.trunc(updatedAt)),
    windows: [],
    message: "Muse subscription/payment setup is required",
  })
}
