import { expect, test } from "bun:test"
import { QuotaPaceMilestone, QuotaPaceSchema, create, encodeLossless } from "@ycoding-ai/protocol/v5"
import { parsePushSubscription, pushCategories, quotaFromWire, quotaKey, quotaToWire } from "../src/index"
import type { RemoteQuota } from "../src/index"

const quota: RemoteQuota = { providerID: "anthropic", windowID: "five-hour", milestone: "will-run-out", resetAt: 1_800_001_800_000 }
const pace = (fields: Partial<Parameters<typeof create<typeof QuotaPaceSchema>>[1]> = {}) =>
  create(QuotaPaceSchema, {
    providerId: encodeLossless("anthropic"),
    windowId: encodeLossless("five-hour"),
    milestone: QuotaPaceMilestone.WILL_RUN_OUT,
    resetAt: 1_800_001_800_000n,
    ...fields,
  })

test.each(["almost-out", "cutting-it-close", "will-run-out"] as const)("quota pace %s round-trips its closed wire fields", (milestone) => {
  expect(quotaFromWire(quotaToWire({ ...quota, milestone }))).toEqual({ ...quota, milestone })
})

test("quota pace conversion admits only the closed milestones", () => {
  expect(quotaFromWire(pace())).toEqual(quota)
  for (const milestone of [0, 9]) expect(quotaFromWire(pace({ milestone: milestone as QuotaPaceMilestone }))).toBeUndefined()
})

test("quota collapse identity rounds reset jitter without carrying account or machine identity", () => {
  expect(quotaKey(quota)).toBe(quotaKey({ ...quota, resetAt: quota.resetAt - 1000 }))
  expect(quotaKey(quota)).toBe(quotaKey({ ...quota, resetAt: quota.resetAt + 1000 }))
  expect(quotaKey(quota)).not.toBe(quotaKey({ ...quota, resetAt: quota.resetAt + 60_000 }))
  expect(quotaKey(quota)).not.toBe(quotaKey({ ...quota, milestone: "almost-out" }))
  expect(quotaKey(quota)).not.toMatch(/usr_|dev_|bs_/)
})

test("the quota System switch is an independent required push category", () => {
  expect(pushCategories).toEqual(["agent-completed", "approval-requested", "machine-offline", "quota-pace"])
  const base = { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic", keys: { p256dh: "BA" + "A".repeat(85), auth: "A".repeat(22) } }
  for (const enabled of [false, true]) {
    const input = { ...base, categories: { "agent-completed": true, "approval-requested": true, "machine-offline": true, "quota-pace": enabled } }
    expect(parsePushSubscription(input)).toEqual({ ok: true, value: input })
  }
  expect(parsePushSubscription({ ...base, categories: { "agent-completed": true, "approval-requested": true, "machine-offline": true } }).ok).toBe(false)
})
