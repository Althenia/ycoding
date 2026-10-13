export * as MuseUsage from "./muse"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Option, Schema } from "effect"
import { Provider } from "../provider"

const Percent = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100))
const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Event = Schema.Struct({
  type: Schema.Literal("response.subscription_usage"),
  subscription: Schema.Struct({
    window: Schema.optional(
      Schema.Struct({
        used_percent: Schema.optional(Percent),
        resets_at: Schema.optional(Timestamp),
        window_duration_mins: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
      }),
    ),
    weekly: Schema.optional(
      Schema.Struct({ used_percent: Schema.optional(Percent), resets_at: Schema.optional(Timestamp) }),
    ),
  }),
})
const decodeEvent = Schema.decodeUnknownOption(Event)
const providerID = Provider.ID.make("muse")

export function normalize(event: unknown, observedAt: number) {
  const decoded = Option.getOrUndefined(decodeEvent(event))
  if (!decoded) return undefined
  const window = decoded.subscription.window
  const weekly = decoded.subscription.weekly
  const minutes = window?.window_duration_mins
  return new ProviderUsage.Snapshot({
    providerID,
    label: "Muse (Meta)",
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
              ...(window.used_percent === undefined ? {} : { used: window.used_percent }),
              ...(window.resets_at === undefined ? {} : { resetAt: window.resets_at * 1000 }),
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
              ...(weekly.used_percent === undefined ? {} : { used: weekly.used_percent }),
              ...(weekly.resets_at === undefined ? {} : { resetAt: weekly.resets_at * 1000 }),
            }),
          ]
        : []),
    ],
  })
}

export function unreported(updatedAt: number) {
  return new ProviderUsage.Snapshot({
    providerID,
    label: "Muse (Meta)",
    status: "unsupported",
    source: "response_stream",
    stability: "observed",
    updatedAt: Math.max(0, Math.trunc(updatedAt)),
    windows: [],
    message: "Quota is reported after the next Muse response",
  })
}
