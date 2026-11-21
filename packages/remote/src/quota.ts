import { QuotaPaceMilestone, create, decodeLossless, encodeLossless, QuotaPaceSchema } from "@ycoding-ai/protocol/v5"
import type { QuotaPace } from "@ycoding-ai/protocol/v5"

export type RemoteQuotaMilestone = "almost-out" | "cutting-it-close" | "will-run-out"
export type RemoteQuota = {
  readonly providerID: string
  readonly windowID: string
  readonly milestone: RemoteQuotaMilestone
  readonly resetAt: number
}

const milestones = [
  [QuotaPaceMilestone.ALMOST_OUT, "almost-out"],
  [QuotaPaceMilestone.CUTTING_IT_CLOSE, "cutting-it-close"],
  [QuotaPaceMilestone.WILL_RUN_OUT, "will-run-out"],
] as const

export function quotaKey(quota: RemoteQuota): string {
  return JSON.stringify([quota.providerID, quota.windowID, quota.milestone, Math.round(quota.resetAt / 60_000)])
}

export function quotaFromWire(pace: QuotaPace): RemoteQuota | undefined {
  const milestone = milestones.find((entry) => entry[0] === pace.milestone)?.[1]
  if (milestone === undefined || pace.providerId === undefined || pace.windowId === undefined) return undefined
  return {
    providerID: decodeLossless(pace.providerId),
    windowID: decodeLossless(pace.windowId),
    milestone,
    resetAt: Number(pace.resetAt),
  }
}

export function quotaToWire(quota: RemoteQuota): QuotaPace {
  return create(QuotaPaceSchema, {
    providerId: encodeLossless(quota.providerID),
    windowId: encodeLossless(quota.windowID),
    milestone: milestones.find((entry) => entry[1] === quota.milestone)![0],
    resetAt: BigInt(quota.resetAt),
  })
}
