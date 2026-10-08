import { expect, test } from "bun:test"
import { createProviderAuth, providerAuthPrompts } from "./provider-auth"
import type { ProviderAuthOperation } from "@ycoding-ai/remote"
import type { RemoteRequestOutcome } from "./transport"

test("conditional authentication fields follow their declared answers", () => {
  const prompts = [{ type: "text" as const, key: "host", message: "Host", when: { key: "kind", op: "eq" as const, value: "enterprise" } }]
  expect(providerAuthPrompts(prompts, { kind: "public" })).toEqual([])
  expect(providerAuthPrompts(prompts, { kind: "enterprise" })).toEqual(prompts)
})

test("authentication does not replay an unconfirmed secret write and never retains its secret", async () => {
  for (const status of ["unknown", "failed"] as const) {
  const calls: ProviderAuthOperation[] = []
  const auth = createProviderAuth({ scope: { deviceID: "dev_1", generation: 1 }, target: { sessionID: "ses_1" }, current: () => true,
    request: async (operation) => { calls.push(operation); return { status, error: { code: "outcome_unknown", message: "Lost answer" } } }, changed: () => {} })
  await auth.key("test", "Work", "synthetic-secret")
  expect(calls).toEqual(["provider.auth.key"])
  expect(auth.state().phase).toBe("unknown")
  expect(JSON.stringify(auth.state())).not.toContain("synthetic-secret")
  auth.dispose()
  }
})

test("a failed status read retains the unresolved attempt, while terminal status removes code submission ownership", async () => {
  let failRead = true
  const auth = createProviderAuth({ scope: { deviceID: "dev_1", generation: 1 }, target: { sessionID: "ses_1" }, current: () => true, changed: () => {},
    request: async (operation) => operation === "provider.auth.begin" ? { status: "ok", value: { data: { type: "oauth", attemptID: "con_auth", mode: "auto", manualCode: true, url: "https://example.com/auth", instructions: "Sign in", time: { created: 1, expires: Date.now() + 1000 } } } }
      : failRead ? { status: "failed", error: { code: "internal_error", message: "private diagnostic" } } : { status: "ok", value: { data: { status: "complete", time: { created: 1, expires: 2 } } } } })
  await auth.begin("test", "device", "Work", {})
  await auth.check()
  expect(auth.state().phase).toBe("unknown")
  expect(auth.state().attempt?.attemptID).toBe("con_auth")
  await auth.load()
  expect(auth.state().attempt?.attemptID).toBe("con_auth")
  failRead = false
  await auth.check()
  expect(auth.state().phase).toBe("complete")
  expect(auth.state().attempt).toBeUndefined()
  auth.dispose()
})

test("a late begun attempt is cancelled on dismissal, and a replaced machine receives no old attempt", async () => {
  let settle: (value: RemoteRequestOutcome) => void = () => {}
  const calls: ProviderAuthOperation[] = []
  let current = true
  const auth = createProviderAuth({ scope: { deviceID: "dev_1", generation: 1 }, target: { sessionID: "ses_1" }, current: () => current,
    request: async (operation) => { calls.push(operation); if (operation === "provider.auth.begin") return new Promise((resolve) => { settle = resolve }); return { status: "ok", value: { data: { status: "cancelled" } } } }, changed: () => {} })
  const beginning = auth.begin("test", "device", "Work", {})
  auth.dispose()
  settle({ status: "ok", value: { data: { type: "oauth", attemptID: "con_auth", mode: "auto", url: "https://example.com/auth", instructions: "Code ABCD", time: { created: 1, expires: Date.now() + 1000 } } } })
  await beginning
  expect(calls).toEqual(["provider.auth.begin", "provider.auth.cancel"])
  current = false
  await auth.key("test", "Work", "synthetic-secret")
  expect(calls).toHaveLength(2)
})

test("an older status reply cannot restore pending after a newer reply completed the attempt", async () => {
  const replies: ((value: RemoteRequestOutcome) => void)[] = []
  const auth = createProviderAuth({ scope: { deviceID: "dev_1", generation: 1 }, target: { sessionID: "ses_1" }, current: () => true, changed: () => {},
    request: async (operation) => operation === "provider.auth.begin" ? { status: "ok", value: { data: { type: "command", attemptID: "con_auth", time: { created: 1, expires: Date.now() + 1000 } } } }
      : new Promise((resolve) => replies.push(resolve)) })
  await auth.begin("test", "command", "Work", {})
  const first = auth.check()
  const second = auth.check()
  expect(replies).toHaveLength(2)
  replies[1]!({ status: "ok", value: { data: { status: "complete", time: { created: 1, expires: 2 } } } })
  await second
  replies[0]!({ status: "ok", value: { data: { status: "pending", time: { created: 1, expires: 2 } } } })
  await first
  expect(auth.state().phase).toBe("complete")
  expect(auth.state().attempt).toBeUndefined()
  auth.dispose()
})
