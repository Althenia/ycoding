export * as CursorUsage from "./cursor"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Provider } from "../provider"
import { Schema } from "effect"

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

export function normalize(input: {
  readonly providerID: Provider.ID
  readonly label: string
  readonly updatedAt: number
  readonly usage: unknown
  readonly plan?: unknown
}) {
  const root = record(input.usage)
  const plan = record(root?.planUsage)
  if (!plan) throw new Error("Invalid Cursor usage response")
  const end = epoch(root?.billingCycleEnd)
  const start = epoch(root?.billingCycleStart)
  const windows = [
    // `planUsage.limit`/`remaining` are plan allowance units, not percentages, so they are left out
    // rather than published against a percent meter a consumer would misread.
    percentWindow("included", "Included", plan.totalPercentUsed, {
      ...(end === undefined ? {} : { resetAt: end }),
      ...(end === undefined || start === undefined || end <= start
        ? {}
        : { periodSeconds: Math.round((end - start) / 1000) }),
    }),
    percentWindow("auto", "Auto", plan.autoPercentUsed),
    percentWindow("api", "API", plan.apiPercentUsed),
  ].filter((window) => window !== undefined)
  const name = record(record(input.plan)?.planInfo)?.planName
  const planName = typeof name === "string" ? name.trim() : ""
  return new ProviderUsage.Snapshot({
    providerID: input.providerID, label: planName ? `${input.label} ${planName}` : input.label,
    status: "available", source: "provider_internal_api", stability: "best_effort",
    updatedAt: Math.max(0, Math.trunc(input.updatedAt)), windows,
  })
}

function percentWindow(id: string, label: string, value: unknown, extra: Partial<ProviderUsage.Window> = {}) {
  const used = number(value)
  if (used === undefined) return undefined
  return new ProviderUsage.Window({ id, label, unit: "percent", used: Math.min(100, used), ...extra })
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function epoch(value: unknown) {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value
  const result = number(parsed)
  return result === undefined ? undefined : Math.trunc(result)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}
