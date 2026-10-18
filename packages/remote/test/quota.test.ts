import { expect, test } from "bun:test"
import { parseAgentMessage, parseClientMessage, parsePushSubscription, parseRelayToAgentMessage, parseRelayToClientMessage, pushCategories, quotaKey, serializeNoticeFrame } from "../src/index"

const quota = { providerID: "anthropic", windowID: "five-hour", milestone: "will-run-out", resetAt: 1_800_001_800_000 } as const

test("quota frames preserve the allowed fields and reject browser-origin impersonation", () => {
  const frame = { type: "quota", ...quota } as const
  expect(parseAgentMessage(JSON.stringify(frame))).toEqual({ ok: true, value: frame })
  expect(parseClientMessage(JSON.stringify(frame)).ok).toBe(false)
  expect(parseRelayToClientMessage(JSON.stringify(frame)).ok).toBe(false)
  expect(parseAgentMessage(JSON.stringify({ ...frame, credentialID: "cred_synthetic" })).ok).toBe(false)
  expect(parseAgentMessage(JSON.stringify({ ...frame, deviceID: "dev_untrusted" })).ok).toBe(false)
  for (const field of ["providerID", "windowID", "milestone", "resetAt"]) {
    const missing = Object.fromEntries(Object.entries(frame).filter(([key]) => key !== field))
    expect(parseAgentMessage(JSON.stringify(missing)).ok).toBe(false)
  }
})

test.each(["almost-out", "cutting-it-close", "will-run-out"])("quota delivery results accept %s with settled or pending status", (milestone) => {
  for (const status of ["settled", "pending"] as const) {
    const frame = { type: "quota.result", ...quota, milestone, status } as const
    expect(parseRelayToAgentMessage(JSON.stringify(frame))).toEqual({ ok: true, value: frame })
    expect(parseRelayToClientMessage(JSON.stringify(frame)).ok).toBe(false)
  }
  expect(parseRelayToAgentMessage(JSON.stringify({ type: "quota.result", ...quota, milestone, status: "approved" })).ok).toBe(false)
})

test("live quota notices and presentation items remain distinct from stored Session notices", () => {
  const frame = { type: "notice.quota", ...quota, at: 1_800_000_000_000 } as const
  expect(parseRelayToClientMessage(JSON.stringify(frame))).toEqual({ ok: true, value: frame })
  const present = { type: "notice.present", items: [{ kind: "quota", ...quota }] } as const
  expect(parseRelayToClientMessage(JSON.stringify(present))).toEqual({ ok: true, value: present })
  expect(parseAgentMessage(JSON.stringify(frame)).ok).toBe(false)
  expect(parseRelayToClientMessage(JSON.stringify({ ...frame, raw: {} })).ok).toBe(false)
})

test("quota fields reject unknown milestones, unsafe resets, and unbounded or control-bearing identifiers", () => {
  for (const invalid of [{ milestone: "ahead" }, { resetAt: -1 }, { resetAt: 1.5 }, { resetAt: Number.MAX_SAFE_INTEGER + 1 }, { providerID: "x".repeat(65) }, { windowID: "x".repeat(65) }, { windowID: "bad\nwindow" }, { providerID: "" }])
    expect(parseAgentMessage(JSON.stringify({ type: "quota", ...quota, ...invalid })).ok).toBe(false)
})

test("the quota System switch belongs to the closed push category set", () => {
  expect(pushCategories).toContain("quota-pace")
})

test("quota collapse identity rounds reset jitter without carrying account or machine identity", () => {
  expect(quotaKey(quota)).toBe(quotaKey({ ...quota, resetAt: quota.resetAt - 1000 }))
  expect(quotaKey(quota)).toBe(quotaKey({ ...quota, resetAt: quota.resetAt + 1000 }))
  expect(quotaKey(quota)).not.toBe(quotaKey({ ...quota, resetAt: quota.resetAt + 60_000 }))
  expect(quotaKey(quota)).not.toBe(quotaKey({ ...quota, milestone: "almost-out" }))
})

test("quota serialization retains only the closed live notice and presentation fields", () => {
  const frame = { type: "notice.quota", ...quota, at: 1_800_000_000_000, account: "synthetic-private-account" } as const
  expect(parseRelayToClientMessage(serializeNoticeFrame(frame))).toEqual({ ok: true,
    value: { type: frame.type, ...quota, at: frame.at } })
  const item = { kind: "quota", ...quota, profile: "synthetic-private-profile" } as const
  expect(parseRelayToClientMessage(serializeNoticeFrame({ type: "notice.present", items: [item] }))).toEqual({ ok: true,
    value: { type: "notice.present", items: [{ kind: "quota", ...quota }] } })
})

test("push registration preserves the independent quota System switch", () => {
  for (const enabled of [false, true]) {
    const input = { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic", keys: { p256dh: "BA" + "A".repeat(85), auth: "A".repeat(22) },
      categories: { "agent-completed": true, "approval-requested": true, "machine-offline": true, "quota-pace": enabled } }
    expect(parsePushSubscription(input)).toEqual({ ok: true, value: input })
  }
})
