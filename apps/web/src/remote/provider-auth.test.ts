import { expect, test } from "bun:test"
import { createProviderAuth, providerAuthPrompts, readProviderAuthList } from "./provider-auth"
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

const target = { sessionID: "ses_1" }
const listing = (profiles: readonly unknown[]) => ({ status: "ok" as const, value: { data: [{ id: "openai", name: "OpenAI", providers: ["openai"], profiles, methods: [
  { type: "oauth", id: "browser", label: "ChatGPT", available: true }, { type: "key", label: "API key", available: true }] }] } })
const oauth = { name: "work", active: true, kind: "oauth", status: "connected" } as const
const key = { name: "keys", active: false, kind: "key", status: "connected" } as const

test("profile kind, status and the exact refresh failure message are read from the list", () => {
  const read = readProviderAuthList(listing([oauth, { name: "old", active: false, kind: "oauth", status: "expired" }, { name: "bad", active: false, kind: "oauth", status: "refresh_failed", message: "invalid_grant: token revoked" }, key]).value)
  expect(read?.[0]?.profiles).toEqual([oauth, { name: "old", active: false, kind: "oauth", status: "expired" }, { name: "bad", active: false, kind: "oauth", status: "refresh_failed", message: "invalid_grant: token revoked" }, key])
  for (const profile of [{ name: "x", active: true }, { name: "x", active: true, kind: "token", status: "connected" }, { name: "x", active: true, kind: "key", status: "revoked" }, { name: "x", active: true, kind: "key", status: "refresh_failed", message: 5 }])
    expect(readProviderAuthList(listing([profile]).value)).toBeUndefined()
})

test("refresh sends the profile label once, reports success, and re-reads the profile state", async () => {
  const calls: { operation: ProviderAuthOperation; input: Readonly<Record<string, unknown>> }[] = []
  let status = "expired"
  const auth = createProviderAuth({ scope: { deviceID: "dev_1", generation: 1 }, target, current: () => true, changed: () => {},
    request: async (operation, input) => { calls.push({ operation, input }); return operation === "provider.auth.refresh" ? (status = "connected", { status: "ok", value: { data: { status: "refreshed", expires: 1234 } } }) : listing([{ ...oauth, status }]) } })
  await auth.load()
  expect(auth.state().integrations[0]?.profiles[0]?.status).toBe("expired")
  await auth.refresh("openai", "work")
  expect(calls.filter((call) => call.operation === "provider.auth.refresh")).toEqual([{ operation: "provider.auth.refresh", input: { target, integrationID: "openai", label: "work" } }])
  expect(auth.state().phase).toBe("ready")
  expect(auth.state().message).toBe("Refreshed work.")
  expect(auth.state().integrations[0]?.profiles[0]?.status).toBe("connected")
  auth.dispose()
})

test("a failed refresh shows the exact failure message and the profile's refresh_failed state", async () => {
  const message = "invalid_grant: refresh token revoked"
  const auth = createProviderAuth({ scope: { deviceID: "dev_1", generation: 1 }, target, current: () => true, changed: () => {},
    request: async (operation) => operation === "provider.auth.refresh" ? { status: "ok", value: { data: { status: "failed", message } } } : listing([{ ...oauth, status: "refresh_failed", message }]) })
  await auth.refresh("openai", "work")
  expect(auth.state().phase).toBe("ready")
  expect(auth.state().message).toBe(`Refresh failed for work: ${message}`)
  expect(auth.state().integrations[0]?.profiles[0]).toEqual({ ...oauth, status: "refresh_failed", message })
  auth.dispose()
})

test("refresh never replays an unconfirmed or unreadable answer and is blocked by an unresolved attempt or a replaced machine", async () => {
  for (const reply of [{ status: "unknown", error: { code: "outcome_unknown", message: "lost" } }, { status: "ok", value: { data: { status: "refreshed" } } }] as const) {
    const calls: ProviderAuthOperation[] = []
    const auth = createProviderAuth({ scope: { deviceID: "dev_1", generation: 1 }, target, current: () => true, changed: () => {}, request: async (operation) => { calls.push(operation); return reply } })
    await auth.refresh("openai", "work")
    expect(calls).toEqual(["provider.auth.refresh"])
    expect(auth.state().phase).toBe("unknown")
    auth.dispose()
  }
  const calls: ProviderAuthOperation[] = []
  let current = true
  const auth = createProviderAuth({ scope: { deviceID: "dev_1", generation: 1 }, target, current: () => current, changed: () => {},
    request: async (operation) => { calls.push(operation); return operation === "provider.auth.begin" ? { status: "ok", value: { data: { type: "command", attemptID: "con_auth", time: { created: 1, expires: Date.now() + 1000 } } } } : { status: "ok", value: { data: { status: "cancelled" } } } } })
  await auth.begin("openai", "browser", "work", {})
  await auth.refresh("openai", "work")
  expect(calls).toEqual(["provider.auth.begin"])
  await auth.cancel()
  current = false
  await auth.refresh("openai", "work")
  expect(calls).toEqual(["provider.auth.begin", "provider.auth.cancel"])
  auth.dispose()
})

test("a refresh answer arriving after disposal publishes nothing", async () => {
  let settle: (value: RemoteRequestOutcome) => void = () => {}
  const published: string[] = []
  const auth = createProviderAuth({ scope: { deviceID: "dev_1", generation: 1 }, target, current: () => true, changed: (state) => published.push(state.phase),
    request: (operation) => operation === "provider.auth.refresh" ? new Promise((resolve) => { settle = resolve }) : Promise.resolve(listing([oauth])) })
  const refreshing = auth.refresh("openai", "work")
  auth.dispose()
  settle({ status: "ok", value: { data: { status: "refreshed", expires: 1 } } })
  await refreshing
  expect(published).toEqual(["sending"])
})

test("reconnecting an existing label begins the flow under that label and cancelling leaves the profile list untouched", async () => {
  const calls: { operation: ProviderAuthOperation; input: Readonly<Record<string, unknown>> }[] = []
  const auth = createProviderAuth({ scope: { deviceID: "dev_1", generation: 1 }, target, current: () => true, changed: () => {},
    request: async (operation, input) => { calls.push({ operation, input }); return operation === "provider.auth.begin" ? { status: "ok", value: { data: { type: "oauth", attemptID: "con_auth", mode: "auto", url: "https://example.com/auth", instructions: "Sign in", time: { created: 1, expires: Date.now() + 1000 } } } }
      : operation === "provider.auth.list" ? listing([oauth, key]) : { status: "ok", value: { data: { status: "cancelled" } } } } })
  await auth.load()
  await auth.begin("openai", "browser", "work", {})
  expect(calls.at(-1)).toEqual({ operation: "provider.auth.begin", input: { target, integrationID: "openai", methodID: "browser", label: "work", inputs: {} } })
  expect(auth.state().phase).toBe("pending")
  await auth.cancel()
  expect(calls.at(-1)?.operation).toBe("provider.auth.cancel")
  expect(auth.state().phase).toBe("ready")
  expect(auth.state().integrations[0]?.profiles).toEqual([oauth, key])
  auth.dispose()
})

test("a failed reconnect attempt keeps the profile list and shows the machine's failure message", async () => {
  const auth = createProviderAuth({ scope: { deviceID: "dev_1", generation: 1 }, target, current: () => true, changed: () => {},
    request: async (operation) => operation === "provider.auth.begin" ? { status: "ok", value: { data: { type: "command", attemptID: "con_auth", time: { created: 1, expires: Date.now() + 1000 } } } }
      : operation === "provider.auth.status" ? { status: "ok", value: { data: { status: "failed", message: "access_denied: user declined", time: { created: 1, expires: 2 } } } } : listing([oauth]) })
  await auth.load()
  await auth.begin("openai", "browser", "work", {})
  await auth.check()
  expect(auth.state().phase).toBe("failed")
  expect(auth.state().attempt).toBeUndefined()
  expect(auth.state().message).toBe("Authentication failed: access_denied: user declined")
  expect(auth.state().integrations[0]?.profiles).toEqual([oauth])
  auth.dispose()
})

test("replacing a key sends the label once and the synthetic key never enters state or messages", async () => {
  const synthetic = "sk-synthetic-key"
  const calls: { operation: ProviderAuthOperation; input: Readonly<Record<string, unknown>> }[] = []
  const states: string[] = []
  const auth = createProviderAuth({ scope: { deviceID: "dev_1", generation: 1 }, target, current: () => true, changed: (state) => states.push(JSON.stringify(state)),
    request: async (operation, input) => { calls.push({ operation, input }); return operation === "provider.auth.key" ? { status: "ok", value: { data: { status: "complete" } } } : listing([key]) } })
  await auth.load()
  await auth.key("openai", "keys", synthetic)
  expect(calls.filter((call) => call.operation === "provider.auth.key")).toEqual([{ operation: "provider.auth.key", input: { target, integrationID: "openai", label: "keys", key: synthetic } }])
  expect(auth.state().phase).toBe("complete")
  expect(JSON.stringify(auth.state())).not.toContain(synthetic)
  expect(states.join("")).not.toContain(synthetic)
  auth.dispose()
})
