import { expect, test } from "bun:test"
import { parseClientMessage, remoteOperationAccess, remoteOperations, type RemoteDotsStatus } from "../src/index"

const parse = (operation: string, input?: unknown, sessionID?: string | null) =>
  parseClientMessage(JSON.stringify({ type: "request", id: "req_test", operation, sessionID, input }))

test("names and exact target receipts survive remote status and attachment validation", async () => {
  const { readDotsStatus } = await import("../src/index")
  const target = { dotID: "dot-a", threadID: "thread-a", environmentID: "env-a", revision: "a".repeat(64) }
  const value = { access: { enabled: true, revision: 1 }, configuration: { ready: true }, connection: { state: "connected", hostname: "box.local", name: "Named desk" }, computer: { state: "detached", name: "Executor desk", target } } satisfies RemoteDotsStatus
  expect(readDotsStatus(value)).toEqual(value)
  expect(parse("dots.attach", { replaceOthers: true, expectedTarget: target }).ok).toBe(true)
  for (const invalid of [{ ...target, revision: "short" }, { ...target, environmentID: "" }, { ...target, accountID: "extra" }])
    expect(parse("dots.attach", { replaceOthers: true, expectedTarget: invalid }).ok).toBe(false)
  expect(readDotsStatus({ ...value, computer: { ...value.computer, target: { ...target, revision: "short" } } })).toBeUndefined()
})

test("global Dots controls reject Session and Location scope and preserve exact revisions", () => {
  expect(parse("dots.get").ok).toBe(true)
  expect(parse("dots.set", { enabled: true, expectedRevision: 0 }).ok).toBe(true)
  expect(parse("dots.set", { enabled: false, expectedRevision: Number.MAX_SAFE_INTEGER }).ok).toBe(true)
  for (const sessionID of ["ses_test", null]) {
    expect(parse("dots.get", undefined, sessionID).ok).toBe(false)
    expect(parse("dots.set", { enabled: true, expectedRevision: 0 }, sessionID).ok).toBe(false)
  }
  for (const input of [{}, { sessionID: "ses_test" }, { directory: "/synthetic" }])
    expect(parse("dots.get", input).ok).toBe(false)
  for (const input of [{ enabled: true }, { enabled: "true", expectedRevision: 0 }, { enabled: true, expectedRevision: -1 }, { enabled: true, expectedRevision: 1.5 }, { enabled: true, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { enabled: true, expectedRevision: 0, source: {} }, { enabled: true, expectedRevision: 0, directory: "/synthetic" }, { enabled: true, expectedRevision: 0, sessionID: "ses_test" }])
    expect(parse("dots.set", input).ok).toBe(false)
  expect(remoteOperationAccess["dots.get"]).toBe("read")
  expect(remoteOperationAccess["dots.set"]).toBe("mutation")
})

test("computer attachment requires exact replacement consent without Session scope", () => {
  expect(parse("dots.attach", { replaceOthers: true }).ok).toBe(true)
  for (const input of [undefined, {}, { replaceOthers: false }, { replaceOthers: "true" }, { replaceOthers: true, environmentID: "env_other" }, { replaceOthers: true, directory: "/synthetic" }])
    expect(parse("dots.attach", input).ok).toBe(false)
  for (const sessionID of ["ses_test", null]) expect(parse("dots.attach", { replaceOthers: true }, sessionID).ok).toBe(false)
  expect(remoteOperationAccess["dots.attach"]).toBe("mutation")
})

test("global Dots status validates access, configuration and every connection state without defaults", async () => {
  const { readDotsStatus } = await import("../src/index")
  const status: RemoteDotsStatus = { access: { enabled: false, revision: 0 }, configuration: { ready: false }, connection: { state: "off" } }
  expect(readDotsStatus(status)).toEqual(status)
  for (const state of ["unavailable", "off", "connecting", "connected", "error"] as const) {
    const value = { ...status, configuration: { ready: true, profile: "Synthetic", message: "Configured" }, connection: { state, hostname: "synthetic-host", message: "Synthetic status" } }
    expect(readDotsStatus(value)).toEqual(value)
  }
  expect(readDotsStatus({ ...status, configuration: { ready: true, profile: "p".repeat(256), message: "m".repeat(500) }, connection: { state: "connected", hostname: "h".repeat(256), message: "m".repeat(500) } })).toBeDefined()
  for (const value of [null, {}, { ...status, access: undefined }, { ...status, configuration: undefined }, { ...status, connection: undefined },
    ...[{ ...status.access, revision: -1 }, { ...status.access, revision: 1.5 }, { ...status.access, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...status.access, enabled: "false" }].map((access) => ({ ...status, access })),
    ...[{ ready: "false" }, { ready: true, profile: null }, { ready: false, message: 1 }, { ready: true, profile: "" }, { ready: true, profile: "p".repeat(257) }, { ready: true, profile: "p\u001b" }, { ready: true, message: "" }, { ready: true, message: "m".repeat(501) }, { ready: true, message: "m\u0085" }].map((configuration) => ({ ...status, configuration })),
    ...[{ state: "idle" }, { state: "connected", hostname: 1 }, { state: "error", message: null }, { state: "connected", hostname: "" }, { state: "connected", hostname: "h".repeat(257) }, { state: "connected", hostname: "h\u001b" }, { state: "error", message: "" }, { state: "error", message: "m".repeat(501) }, { state: "error", message: "m\u0085" }].map((connection) => ({ ...status, connection })),
    { sessionID: "ses_test", rootSessionID: "ses_test", enabled: false, revision: 0, inherited: false, configured: true }])
    expect(readDotsStatus(value)).toBeUndefined()
  expect(readDotsStatus({ ...status, credential: "discarded", configuration: { ...status.configuration, token: "discarded" } })).toEqual(status)
})

test("global Dots status keeps a valid computer state and rejects an invalid one", async () => {
  const { readDotsStatus } = await import("../src/index")
  const status: RemoteDotsStatus = { access: { enabled: true, revision: 1 }, configuration: { ready: true }, connection: { state: "connected" } }
  for (const state of ["attached", "detached", "unavailable"] as const) {
    expect(readDotsStatus({ ...status, computer: { state } })).toEqual({ ...status, computer: { state } })
    expect(readDotsStatus({ ...status, computer: { state, message: "m".repeat(500) } })).toEqual({ ...status, computer: { state, message: "m".repeat(500) } })
  }
  expect(readDotsStatus({ ...status, computer: { state: "attached", environmentID: "discarded" } })).toEqual({ ...status, computer: { state: "attached" } })
  for (const computer of [null, "attached", {}, { state: "connected" }, { state: "detached", message: "" }, { state: "detached", message: "m".repeat(501) }, { state: "detached", message: "m\u001b" }, { state: "detached", message: 1 }])
    expect(readDotsStatus({ ...status, computer })).toBeUndefined()
})

test("remote exposes only access administration and computer attachment for Dots", () => {
  expect(remoteOperations.filter((operation) => operation.startsWith("dots.") || operation.startsWith("session.dots."))).toEqual([
    "dots.get", "dots.set", "dots.attach",
  ])
  for (const operation of ["session.dots.access.get", "session.dots.access.set", "session.dots.bind", "session.dots.exchange.create", "dots.bind", "dots.prompt", "dots.settle", "local.app.open", "artifact.demo.preview", "mcp.request"])
    expect(parse(operation).ok).toBe(false)
})
