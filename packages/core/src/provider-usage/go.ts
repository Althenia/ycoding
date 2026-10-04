export * as GoUsage from "./go"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Provider } from "../provider"
import { Schema } from "effect"

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

export function normalize(input: {
  readonly providerID: Provider.ID
  readonly label: string
  readonly updatedAt: number
  readonly response: unknown
}) {
  const root = record(input.response)
  const usage = record(root?.usage)
  if (!usage) throw new Error("Invalid OpenCode Go usage response")
  const windows = (["rolling", "weekly", "monthly"] as const).map((key) => {
    const window = record(usage[key])
    const percent = window?.percent
    if (!window || typeof percent !== "number" || !Number.isFinite(percent) || percent < 0)
      throw new Error("Invalid OpenCode Go usage response")
    const resetAt = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : NaN
    return new ProviderUsage.Window({
      id: key === "rolling" ? "session" : key,
      label: key === "rolling" ? "Session" : key === "weekly" ? "Weekly" : "Monthly",
      unit: "percent", used: Math.min(100, percent),
      periodSeconds: key === "rolling" ? 18_000 : key === "weekly" ? 604_800 : 2_592_000,
      ...(Number.isFinite(resetAt) && resetAt >= 0 ? { resetAt } : {}),
    })
  })
  return new ProviderUsage.Snapshot({
    providerID: input.providerID, label: input.label, status: "available",
    source: "provider_api", stability: "stable", updatedAt: Math.max(0, Math.trunc(input.updatedAt)), windows,
  })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}
