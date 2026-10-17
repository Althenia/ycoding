import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import { Project } from "@ycoding-ai/schema/project"
import { RemoteLimits, parseChunkedValue, remoteOperations, requireSession, type RemoteRequest } from "@ycoding-ai/remote"
import { Telemetry } from "@ycoding-ai/schema/telemetry"
import { Schema } from "effect"
import { SessionOrchestrationIdentity } from "@ycoding-ai/core/session/orchestration-identity"
import { assertPrivateEndpoint, type LocalLocation, type LocalServer } from "../src/remote-local"
import { LocalFailure as LocalFailureClass } from "../src/remote-local"
import {
  createSessionRegistry,
  createOperationCache,
  createAttachmentUploads,
  createSubscriptions,
  executeRemoteOperation,
  listPage,
  parseListQuery,
  attentionDetails,
  sessionStatus,
  successFrames,
} from "../src/remote-operations"

test("reads admitted pending prompts at their verified Session Location", async () => {
  const pending = [{ id: "msg_pending", sessionID: "ses_1", admittedSeq: 3, timeCreated: 100,
    type: "user", data: { text: "Continue work" }, delivery: "queue" }]
  const fixture = await harness({ sessions: [sessionInfo("ses_1", { updated: 1 })], results: { pendingList: pending } })
  const value = valueOf(await executeRemoteOperation({ request: { ...request("session.pending.list"), sessionID: "ses_1" },
    local: fixture.local, sessions: fixture.registry, subscriptions: fixture.subscriptions }))
  expect(value).toEqual({ data: pending })
  expect(fixture.calls.filter((call) => call.method === "pendingList")).toEqual([{ method: "pendingList", args: ["ses_1", { directory: "/work" }] }])
  expect(errorOf(await executeRemoteOperation({ request: { ...request("session.pending.list"), sessionID: "ses_other" },
    local: fixture.local, sessions: fixture.registry, subscriptions: fixture.subscriptions })).code).toBe("session_not_allowed")
  expect(fixture.calls.filter((call) => call.method === "pendingList")).toHaveLength(1)
})

test("provider authentication projects safe methods and binds attempts to their initiating Location and integration", async () => {
  const integrations = [{ id: "test", name: "Test", connections: [{ type: "credential", id: "cred_private", label: "Work", active: true }], methods: [
    { type: "key" }, { type: "oauth", id: "device", label: "Device", remote: true }, { type: "oauth", id: "browser", label: "Local browser" }, { type: "command", id: "cli", label: "CLI", command: ["private-command"] },
  ] }]
  const fixture = await harness({ results: { integrationList: integrations, providerIntegrations: [{ providerID: "test", integrationID: "test" }],
    integrationOAuthBegin: { attemptID: "con_auth", mode: "auto", url: "https://example.com/auth", instructions: "Enter device code: ABCD", time: { created: 1, expires: Date.now() + 10000 } },
    integrationOAuthStatus: { status: "failed", message: "private-token", time: { created: 1, expires: 2 } },
    integrationCommandBegin: { attemptID: "con_cli", time: { created: 1, expires: Date.now() + 10000 } },
    integrationCommandStatus: { status: "pending", message: "private-token", time: { created: 1, expires: 2 } },
  } })
  const cache = createOperationCache()
  const run = (operation: RemoteRequest["operation"], fields: Record<string, unknown>) => executeRemoteOperation({ request: request(operation, { target: { sessionID: "ses_1" }, ...fields }), local: fixture.local, sessions: fixture.registry, subscriptions: fixture.subscriptions, cache })
  const listed = JSON.stringify(valueOf(await run("provider.auth.list", {})))
  expect(listed).toContain('"available":false')
  expect(listed).toContain('"name":"Work"')
  expect(listed).not.toMatch(/cred_private|private-command/)
  expect(valueOf(await run("provider.auth.begin", { integrationID: "test", methodID: "device", label: "New", inputs: {} }))).toMatchObject({ data: { attemptID: "con_auth", type: "oauth" } })
  expect(valueOf(await run("provider.auth.status", { integrationID: "test", attemptID: "con_auth" }))).toMatchObject({ data: { status: "failed", message: "Authentication failed. Try connecting again." } })
  expect(errorOf(await run("provider.auth.complete", { integrationID: "other", attemptID: "con_auth", code: "secret-code" })).code).toBe("invalid_message")
  expect(errorOf(await run("provider.auth.begin", { integrationID: "test", methodID: "browser", label: "New", inputs: {} })).code).toBe("invalid_message")
  expect(fixture.calls.filter((call) => call.method === "integrationOAuthBegin")).toEqual([{ method: "integrationOAuthBegin", args: [{ directory: "/work" }, "test", "device", {}, "New"] }])
  expect(valueOf(await run("provider.auth.begin", { integrationID: "test", methodID: "cli", label: "CLI", inputs: {} }))).toMatchObject({ data: { type: "command" } })
  expect(JSON.stringify(valueOf(await run("provider.auth.status", { integrationID: "test", attemptID: "con_cli" })))).not.toContain("private-token")
  expect(errorOf(await run("provider.auth.key", { target: { sessionID: "ses_missing" }, integrationID: "test", label: "New", key: "secret-key" })).code).toBe("session_not_allowed")
  expect(fixture.calls.some((call) => call.method === "integrationKey")).toBe(false)
})

test("provider authentication reserves its bounded attempt slot before asynchronous authorization starts", async () => {
  const began = Promise.withResolvers<void>()
  const secondBegan = Promise.withResolvers<"started">()
  const release = Promise.withResolvers<{ attemptID: string; mode: "auto"; url: string; instructions: string; time: { created: number; expires: number } }>()
  let calls = 0
  const fixture = await harness({ results: { integrationList: [{ id: "test", name: "Test", connections: [], methods: [{ type: "oauth", id: "device", label: "Device", remote: true }] }], providerIntegrations: [{ providerID: "test", integrationID: "test" }],
    integrationOAuthBegin: () => { calls += 1; began.resolve(); if (calls === 2) secondBegan.resolve("started"); return release.promise },
  } })
  const cache = createOperationCache()
  for (let index = 0; index < 31; index++) cache.providerAuth.set(`con_prior${index}`, { integrationID: "test", target: JSON.stringify({ sessionID: "ses_1" }), location: { directory: "/work" }, type: "oauth", expires: Date.now() + 10000 })
  const run = () => executeRemoteOperation({ request: request("provider.auth.begin", { target: { sessionID: "ses_1" }, integrationID: "test", methodID: "device", label: "Work", inputs: {} }), local: fixture.local, sessions: fixture.registry, subscriptions: fixture.subscriptions, cache })
  const first = run()
  await began.promise
  const second = run()
  const outcome = await Promise.race([second.then((frames) => frames[0].ok ? "accepted" : "rejected"), secondBegan.promise])
  release.resolve({ attemptID: "con_new", mode: "auto", url: "https://example.com/auth", instructions: "Sign in", time: { created: 1, expires: Date.now() + 10000 } })
  await Promise.all([first, second])
  expect(outcome).toBe("rejected")
  expect(calls).toBe(1)
  expect(cache.providerAuth.size).toBe(32)
})

test("an unconfirmed provider authentication start retains only its bounded reservation until expiry", async () => {
  let now = 1000
  const cache = createOperationCache(() => now)
  const fixture = await harness({ results: { integrationList: [{ id: "test", name: "Test", connections: [], methods: [{ type: "oauth", id: "device", label: "Device", remote: true }] }], providerIntegrations: [{ providerID: "test", integrationID: "test" }], integrationOAuthBegin: new LocalFailureClass("transport", "synthetic-private-diagnostic") } })
  const run = (operation: RemoteRequest["operation"], fields: Record<string, unknown>) => executeRemoteOperation({ request: request(operation, { target: { sessionID: "ses_1" }, ...fields }), local: fixture.local, sessions: fixture.registry, subscriptions: fixture.subscriptions, cache })
  const frames = await run("provider.auth.begin", { integrationID: "test", methodID: "device", label: "Work", inputs: {} })
  expect(errorOf(frames).code).toBe("outcome_unknown")
  expect(JSON.stringify(frames)).not.toContain("synthetic-private-diagnostic")
  expect(cache.providerAuth.size).toBe(1)
  expect(fixture.calls.filter((call) => call.method === "integrationOAuthBegin")).toHaveLength(1)
  now += 600001
  await run("provider.auth.list", {})
  expect(cache.providerAuth.size).toBe(0)
})

test("prompt skills are admitted as metadata without activating queued instructions in the connector", async () => {
  const test = await harness({ results: { prompt: { id: "msg_1" } } })
  const outcome = await executeRemoteOperation({ request: request("session.prompt", { id: "msg_1", text: "Review later", delivery: "queue", skills: ["audit", "test"] }),
    local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
  expect(valueOf(outcome)).toEqual({ data: { id: "msg_1" } })
  expect(test.calls.filter((call) => call.method === "prompt" || call.method === "skill")).toEqual([{ method: "prompt", args: ["ses_1", { directory: "/work" }, {
    id: "msg_1", text: "Review later", delivery: "queue", metadata: { skills: [{ id: "audit" }, { id: "test" }] },
  }] }])
  for (const skills of ["audit", [""], [" "], ["x".repeat(129)], Array.from({ length: 201 }, () => "audit")]) {
    const invalid = await executeRemoteOperation({ request: request("session.prompt", { text: "Invalid skills", skills }), local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
    expect(errorOf(invalid).code).toBe("invalid_message")
  }
  expect(test.calls.filter((call) => call.method === "prompt")).toHaveLength(1)
})

test("manual compaction uses only the backend's verified Session Location and stable ID", async () => {
  const result = { id: "cmp_web_1", sessionID: "ses_1", trigger: "manual", status: "ended", requestedThrough: { messageID: "msg_1", seq: 1 }, timeCreated: 100 }
  const fixture = await harness({ results: { compact: result } })
  const run = (sessionID: string, input: Record<string, unknown> = { id: "cmp_web_1" }) => executeRemoteOperation({
    request: { ...request("session.compact", input), sessionID }, local: fixture.local,
    sessions: fixture.registry, subscriptions: fixture.subscriptions,
  })
  expect(valueOf(await run("ses_1"))).toEqual({ data: result })
  expect(fixture.calls.filter((call) => call.method === "compact")).toEqual([
    { method: "compact", args: ["ses_1", { directory: "/work" }, "cmp_web_1"] },
  ])
  expect(errorOf(await run("ses_other")).code).toBe("session_not_allowed")
  expect(errorOf(await run("ses_1", { id: "cmp_web_1", directory: "/private" })).code).toBe("invalid_message")
  expect(errorOf(await run("ses_1", { id: "msg_wrong" })).code).toBe("invalid_message")
  expect(fixture.calls.filter((call) => call.method === "compact")).toHaveLength(1)
})

test("machine keep-awake forwards global backend controls without a caller Location or Session", async () => {
  const fixture = await harness({
    sessions: [],
    results: {
      keepAwakeGet: { state: "off", lid: "off", sleepHold: false },
      keepAwakeSet: { state: "on", lid: "on", sleepHold: true, manual: false },
    },
  })
  const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>, sessionID?: string) => executeRemoteOperation({
    request: { ...request(operation, input), ...(sessionID === undefined ? {} : { sessionID }) }, local: fixture.local,
    sessions: fixture.registry, subscriptions: fixture.subscriptions,
  })
  expect(valueOf(await run("machine.keepAwake.get"))).toEqual({ data: { state: "off", lid: "off", sleepHold: false } })
  expect(valueOf(await run("machine.keepAwake.set", { enabled: true }))).toEqual({
    data: { state: "on", lid: "on", sleepHold: true, manual: false },
  })
  expect(fixture.calls).toEqual([{ method: "keepAwakeGet", args: [] }, { method: "keepAwakeSet", args: [true] }])
  expect(errorOf(await run("machine.keepAwake.set", { enabled: true, directory: "/private" })).code).toBe("invalid_message")
  expect(errorOf(await run("machine.keepAwake.set", { enabled: "true" })).code).toBe("invalid_message")
  expect(errorOf(await run("machine.keepAwake.get", undefined, "ses_1")).code).toBe("invalid_message")
  expect(fixture.calls).toHaveLength(2)
})

test("machine telemetry consent forwards global reads and writes only the current notice version", async () => {
  const consent = { enabled: true, noticeVersion: 1, decidedAt: 10 }
  const fixture = await harness({ sessions: [], results: { telemetryConsentGet: { noticeVersion: 1, consent }, telemetryConsentSet: consent } })
  const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>, sessionID?: string) => executeRemoteOperation({
    request: { ...request(operation, input), ...(sessionID === undefined ? {} : { sessionID }) }, local: fixture.local,
    sessions: fixture.registry, subscriptions: fixture.subscriptions,
  })
  expect(valueOf(await run("machine.telemetry.consent.get"))).toEqual({ data: { noticeVersion: 1, consent } })
  expect(valueOf(await run("machine.telemetry.consent.set", { enabled: true, noticeVersion: 1 }))).toEqual({ data: consent })
  expect(fixture.calls).toEqual([
    { method: "telemetryConsentGet", args: [] },
    { method: "telemetryConsentSet", args: [{ enabled: true, noticeVersion: 1 }] },
  ])
  expect(errorOf(await run("machine.telemetry.consent.set", { enabled: true, noticeVersion: 2 })).code).toBe("invalid_message")
  expect(errorOf(await run("machine.telemetry.consent.get", undefined, "ses_1")).code).toBe("invalid_message")
  expect(fixture.calls).toHaveLength(2)
})

test("disabled local telemetry append maps to a distinct non-replayable remote failure", async () => {
  const fixture = await harness({ sessions: [], results: { latencyAppend: new LocalFailureClass("telemetry_disabled", "disabled") } })
  const result = await executeRemoteOperation({ request: request("machine.latency.append", { samples: [{ kind: "long-task", at: "2026-10-04T12:00:00.000Z", durationMs: 60 }] }),
    local: fixture.local, sessions: fixture.registry, subscriptions: fixture.subscriptions })
  expect(errorOf(result).code).toBe("telemetry_disabled")
  expect(fixture.calls.filter((call) => call.method === "latencyAppend")).toHaveLength(1)
})

test("machine latency writes and reads only validated anonymous samples at the authenticated local backend", async () => {
  const sample = { kind: "request", at: "2026-10-04T12:00:00.000Z", operation: "session.list", outcome: "ok", queueMs: 4, settlementMs: 9, totalMs: 13 }
  const task = { kind: "long-task", at: sample.at, durationMs: 70 }
  const fixture = await harness({ sessions: [], results: { latencyAppend: { accepted: 2 }, latencyList: { data: [sample, task], cursor: {} } } })
  const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>, sessionID?: string) => executeRemoteOperation({
    request: { ...request(operation, input), ...(sessionID === undefined ? {} : { sessionID }) }, local: fixture.local,
    sessions: fixture.registry, subscriptions: fixture.subscriptions,
  })
  expect(valueOf(await run("machine.latency.append", { samples: [sample, task] }))).toEqual({ accepted: 2 })
  expect(valueOf(await run("machine.latency.list", { limit: 60 }))).toEqual({ data: [sample, task], cursor: {} })
  expect(fixture.calls).toEqual([
    { method: "latencyAppend", args: [[sample, task]] },
    { method: "latencyList", args: [{ limit: 60 }] },
  ])
  for (const input of [{ samples: [{ ...sample, text: "private" }] }, { samples: [sample], directory: "/private" }, { samples: [] }])
    expect(errorOf(await run("machine.latency.append", input)).code).toBe("invalid_message")
  expect(errorOf(await run("machine.latency.list", { limit: 201 })).code).toBe("invalid_message")
  expect(errorOf(await run("machine.latency.append", { samples: [sample] }, "ses_1")).code).toBe("invalid_message")
  expect(fixture.calls).toHaveLength(2)
})

test("local telemetry operation names cover the relay's current forwarded operations without self-upload", () => {
  const decode = Schema.decodeUnknownSync(Telemetry.Operation)
  for (const operation of remoteOperations) {
    if (operation === "machine.latency.append" || operation === "machine.latency.list" || operation === "machine.telemetry.consent.get" || operation === "machine.telemetry.consent.set") continue
    expect(decode(operation)).toBe(operation)
  }
  expect(() => decode("machine.latency.append")).toThrow()
})

test("unconfirmed machine control and compaction writes are unknown, not failed or replayed", async () => {
  const fixture = await harness({ results: {
    compact: new LocalFailureClass("transport", "Socket closed"),
    keepAwakeSet: new LocalFailureClass("transport", "Socket closed"),
  } })
  for (const frame of [request("session.compact", { id: "cmp_1" }), request("machine.keepAwake.set", { enabled: true })]) {
    expect(errorOf(await executeRemoteOperation({ request: frame, local: fixture.local,
      sessions: fixture.registry, subscriptions: fixture.subscriptions })).code).toBe("outcome_unknown")
  }
  expect(fixture.calls.filter((call) => call.method === "compact" || call.method === "keepAwakeSet")).toHaveLength(2)
})

test("refuses an oversized pending inventory rather than silently dropping prompts", async () => {
  const pending = Array.from({ length: 201 }, (_, index) => ({ id: `msg_${index}`, sessionID: "ses_1", admittedSeq: index,
    timeCreated: index, type: "user", data: { text: `Prompt ${index}` }, delivery: "queue" }))
  const fixture = await harness({ sessions: [sessionInfo("ses_1", { updated: 1 })], results: { pendingList: pending } })
  expect(errorOf(await executeRemoteOperation({ request: { ...request("session.pending.list"), sessionID: "ses_1" },
    local: fixture.local, sessions: fixture.registry, subscriptions: fixture.subscriptions })).code).toBe("message_too_large")
})

test("uploaded chunks resolve only for their Session and reach the local prompt as a canonical data URL", async () => {
  const test = await harness({ sessions: [sessionInfo("ses_1", { updated: 1 }), sessionInfo("ses_2", { updated: 1 })], results: { prompt: { id: "msg_1" }, command: { id: "msg_2" } } })
  const uploads = createAttachmentUploads()
  const uploadID = "4ab94d33-6e6b-41a3-a638-f0a6596854a9"
  const send = (index: number, last: boolean, data: string, sessionID = "ses_1") => executeRemoteOperation({ request: { ...request("session.attachment.upload", { uploadID, index, last, data }), sessionID }, uploads, local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
  expect(valueOf(await send(0, false, "aGVs"))).toMatchObject({ received: 3 })
  const uri = `ycoding-upload://${uploadID}`
  const prompt = (sessionID: string) => executeRemoteOperation({ request: { ...request("session.prompt", { text: "Review", files: [{ uri, name: "hello.txt" }] }), sessionID }, uploads, local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
  expect(errorOf(await prompt("ses_1")).code).toBe("invalid_message")
  expect(errorOf(await send(2, true, "bG8=")).code).toBe("invalid_message")
  expect(errorOf(await send(0, true, "bG8=")).code).toBe("invalid_message")
  expect(errorOf(await send(1, true, "bG8=", "ses_2")).code).toBe("invalid_message")
  expect(valueOf(await send(1, true, "bG8="))).toEqual({ uri })
  expect(errorOf(await prompt("ses_2")).code).toBe("invalid_message")
  expect(valueOf(await prompt("ses_1"))).toEqual({ data: { id: "msg_1" } })
  expect(test.calls.find((call) => call.method === "prompt")?.args[2]).toMatchObject({ files: [{ uri: "data:application/octet-stream;base64,aGVsbG8=", name: "hello.txt" }] })
  const command = await executeRemoteOperation({ request: request("session.command", { command: "test", files: [{ uri }] }), uploads, local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
  expect(valueOf(command)).toEqual({ data: { id: "msg_2" } })
  expect(test.calls.find((call) => call.method === "command")?.args[2]).toMatchObject({ files: [{ uri: "data:application/octet-stream;base64,aGVsbG8=" }] })
  uploads.clear()
  expect(errorOf(await prompt("ses_1")).code).toBe("invalid_message")
})

test("upload storage rejects oversize, expires idle buffers and clears on disconnect", () => {
  let now = 0
  const uploads = createAttachmentUploads({ now: () => now })
  const id = "4ab94d33-6e6b-41a3-a638-f0a6596854a9"
  expect(uploads.append("ses_1", id, 0, false, "AAAA")).toEqual({ received: 3 })
  now = RemoteLimits.attachmentTtlMs + 1
  expect(() => uploads.resolve("ses_1", `ycoding-upload://${id}`)).toThrow()
  expect(() => uploads.append("ses_1", id, 1, true, "AAAA")).toThrow()
  const huge = Buffer.alloc(RemoteLimits.maxAttachmentBytes + 1).toString("base64")
  for (let offset = 0, index = 0; offset < huge.length; offset += RemoteLimits.maxAttachmentChunkChars, index++) {
    const chunk = huge.slice(offset, offset + RemoteLimits.maxAttachmentChunkChars)
    if (offset + RemoteLimits.maxAttachmentChunkChars >= huge.length) expect(() => uploads.append("ses_1", id, index, true, chunk)).toThrow()
    else uploads.append("ses_1", id, index, false, chunk)
  }
  expect(() => uploads.resolve("ses_1", `ycoding-upload://${id}`)).toThrow()
  uploads.append("ses_1", id, 0, true, "AAAA")
  uploads.clear()
  expect(() => uploads.resolve("ses_1", `ycoding-upload://${id}`)).toThrow()
})

test("two maximum-size uploads exhaust the bounded connection buffer", () => {
  const uploads = createAttachmentUploads()
  const encoded = Buffer.alloc(RemoteLimits.maxAttachmentBytes).toString("base64")
  try {
    expect(() => uploads.append("ses_1", "4ab94d33-6e6b-41a3-a638-000000000000", 0, false, "YQ==")).toThrow()
    for (const id of ["4ab94d33-6e6b-41a3-a638-f0a6596854a9", "4ab94d33-6e6b-41a3-a638-f0a6596854aa"]) {
      for (let offset = 0, index = 0; offset < encoded.length; offset += RemoteLimits.maxAttachmentChunkChars, index++)
        uploads.append("ses_1", id, index, offset + RemoteLimits.maxAttachmentChunkChars >= encoded.length, encoded.slice(offset, offset + RemoteLimits.maxAttachmentChunkChars))
    }
    expect(() => uploads.append("ses_1", "4ab94d33-6e6b-41a3-a638-f0a6596854ab", 0, true, "AAAA")).toThrow()
  } finally { uploads.clear() }
})

test("small uploads cannot exhaust the agent through unbounded buffer entries", () => {
  const uploads = createAttachmentUploads()
  try {
    for (let index = 0; index < 64; index++)
      uploads.append("ses_1", `4ab94d33-6e6b-41a3-a638-${index.toString(16).padStart(12, "0")}`, 0, true, "AAAA")
    expect(() => uploads.append("ses_1", "4ab94d33-6e6b-41a3-a638-000000000040", 0, true, "AAAA")).toThrow()
  } finally { uploads.clear() }
})

test("window snapshots forward the opaque cursor and managed reads retain scoped not-found and size errors", async () => {
  const digest = "a".repeat(64)
  const test = await harness({ results: {
    snapshot: async (_id: string, _location: LocalLocation, options?: { limit?: number; before?: string }) => ({ sourceEpoch: "epoch_1", session: sessionInfo("ses_1", { updated: 1 }), messages: [], watermark: { seq: 4 }, before: options?.before }),
    attachmentRead: async (_id: string, _location: LocalLocation, value: string) => {
      if (value === "b".repeat(64)) throw new LocalFailureClass("not_found", "unreferenced")
      if (value === "c".repeat(64)) throw new LocalFailureClass("too_large", "oversized")
      return { mime: "image/png", bytes: 3, data: "YWJj" }
    },
  } })
  const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>) => executeRemoteOperation({ request: request(operation, input), local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
  expect(valueOf(await run("session.snapshot", { limit: 2, before: "opaque_cursor" }))).toMatchObject({ before: "opaque_cursor", watermark: { seq: 4 } })
  expect(test.calls.at(-1)).toEqual({ method: "snapshot", args: ["ses_1", { directory: "/work" }, { limit: 2, before: "opaque_cursor" }] })
  expect(errorOf(await run("session.snapshot", { before: "opaque_cursor" })).code).toBe("invalid_message")
  expect(valueOf(await run("session.attachment.read", { digest }))).toEqual({ mime: "image/png", bytes: 3, data: "YWJj" })
  expect(test.calls.at(-1)).toEqual({ method: "attachmentRead", args: ["ses_1", { directory: "/work" }, digest] })
  expect(errorOf(await run("session.attachment.read", { digest: "../wrong" })).code).toBe("invalid_message")
  expect(errorOf(await run("session.attachment.read", { digest: "b".repeat(64) })).code).toBe("not_found")
  expect(errorOf(await run("session.attachment.read", { digest: "c".repeat(64) })).code).toBe("message_too_large")
})

test("windowed snapshots shrink under the relay chunk cap and fail a single oversized message", async () => {
  const messages = [{ id: "msg_old", text: "x".repeat(9 * 1024 * 1024) }, { id: "msg_new", text: "y".repeat(9 * 1024 * 1024) }]
  const test = await harness({ results: { snapshot: async (_id: string, _location: LocalLocation, options?: { limit?: number }) => ({
    sourceEpoch: "epoch_1", session: sessionInfo("ses_1", { updated: 1 }), messages: messages.slice(-(options?.limit ?? 2)),
    watermark: { seq: 4 }, ...(options?.limit === 1 ? { before: "older" } : {}),
  }) } })
  const frames = await executeRemoteOperation({ request: request("session.snapshot", { limit: 2 }), sessions: test.registry, subscriptions: test.subscriptions, local: test.local })
  expect(frames.length).toBeGreaterThan(1)
  expect(frames.length).toBeLessThanOrEqual(RemoteLimits.maxChunksPerResponse)
  const value = parseChunkedValue(frames.map((frame) => frame.ok ? String(frame.value) : ""))
  expect(value).toMatchObject({ ok: true, value: { before: "older", messages: [{ id: "msg_new" }] } })
  expect(test.calls.filter((call) => call.method === "snapshot").map((call) => call.args[2])).toEqual([{ limit: 2 }, { limit: 1 }])

  const oversized = await harness({ results: { snapshot: async () => ({ messages: [{ id: "msg_large", text: "z".repeat(17 * 1024 * 1024) }] }) } })
  expect(errorOf(await executeRemoteOperation({ request: request("session.snapshot", { limit: 1 }), sessions: oversized.registry, subscriptions: oversized.subscriptions, local: oversized.local })).code).toBe("message_too_large")
})

const capturedPatch = (file: string, line = "new") => `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${line}`
const capturedEdit = (file: string, patch = capturedPatch(file), status = "completed") => ({ type: "tool", id: `call_${file}`, name: "edit",
  state: { status, structured: status === "completed" ? { files: [{ file, patch, additions: 65, deletions: 3 }] } : {} } })
const capturedReply = (id: string, content: unknown[] = []) => ({ id, type: "assistant", time: { created: 2, completed: 3 }, content })
const capturedRun = (test: Awaited<ReturnType<typeof harness>>, cursor?: string, sessionID = "ses_1") => executeRemoteOperation({
  request: { ...request("session.capturedChanges.list", cursor ? { cursor } : undefined), sessionID }, local: test.local, sessions: test.registry, subscriptions: test.subscriptions })

test("captured changes groups each prompt segment's repeated edits once, tags them with their own reply, and reads no ledger", async () => {
  const test = await harness({ results: { capturedInputs: async () => [
    { id: "msg_user_1", type: "user" },
    capturedReply("msg_step_1", [capturedEdit("src/a.ts", capturedPatch("src/a.ts", "one")), capturedEdit("src/b.ts")]),
    capturedReply("msg_reply_1", [capturedEdit("src/a.ts", capturedPatch("src/a.ts", "two"))]),
    { id: "msg_compact", type: "compaction", status: "completed", boundary: { messageID: "msg_step_1" } },
    { id: "msg_user_2", type: "user" }, capturedReply("msg_reply_2", []),
    { id: "msg_steer", type: "user" }, capturedReply("msg_reply_3", [capturedEdit("src/a.ts", capturedPatch("src/a.ts", "three"))]),
  ] } })
  const page = valueOf(await capturedRun(test)) as { data: { placementMessageID: string; path: string; additions: number; files: unknown[] }[]; cursor?: unknown }
  expect(page.data.map((group) => [group.placementMessageID, group.path, group.additions, group.files.length])).toEqual([
    ["msg_reply_1", "src/a.ts", 2, 2], ["msg_reply_1", "src/b.ts", 1, 1], ["msg_reply_3", "src/a.ts", 1, 1],
  ])
  expect(page.cursor).toBeUndefined()
  expect(test.calls.filter((call) => call.method === "messages" || call.method === "capturedInputs" || call.method === "subagentPage" || call.method === "fileChangeList").map((call) => call.method)).toEqual(["capturedInputs"])
})

test("captured changes attributes a reused child's work to the parent segment that dispatched it and skips unverified children", async () => {
  const send = SessionOrchestrationIdentity.send("ses_1", "msg_reply_2", "call_send")
  const test = await harness({ sessions: [sessionInfo("ses_1", { updated: 1 }), sessionInfo("ses_child", { updated: 2, directory: "/child", parentID: "ses_1" }),
    sessionInfo("ses_foreign", { updated: 3, parentID: "ses_other" })], results: { capturedInputs: async (id: string) => id === "ses_1" ? [
    { id: "msg_user_1", type: "user" }, capturedReply("msg_reply_1", [{ type: "tool", id: "call_launch", name: "subagent", state: { status: "completed", structured: { sessionID: "ses_child" } } }]),
    { id: "msg_user_2", type: "user" }, capturedReply("msg_reply_2", [
      { type: "tool", id: "call_send", name: "subagent_control", state: { status: "completed", structured: { action: "send", task: { sessionID: "ses_child" } } } },
      { type: "tool", id: "call_forged", name: "subagent", state: { status: "completed", structured: { sessionID: "ses_foreign" } } }]),
  ] : [
    { id: "msg_task_launch", type: "user" }, capturedReply("msg_child_1", [capturedEdit("src/first.ts")]),
    { id: send, type: "synthetic", metadata: { source: "subagent_parent", kind: "message" } }, capturedReply("msg_child_2", [capturedEdit("src/later.ts")]),
  ] } })
  const page = valueOf(await capturedRun(test)) as { data: { placementMessageID: string; path: string }[] }
  expect(page.data.map((group) => [group.placementMessageID, group.path])).toEqual([["msg_reply_1", "src/first.ts"], ["msg_reply_2", "src/later.ts"]])
  expect(test.calls.filter((call) => call.method === "capturedInputs").map((call) => call.args.slice(0, 2))).toEqual([
    ["ses_1", { directory: "/work" }], ["ses_child", { directory: "/child" }],
  ])
})

test("captured changes pages complete groups across segments and labels a patch too large for one page", async () => {
  const files = (prefix: string) => Array.from({ length: 60 }, (_, index) => ({ file: `src/${prefix}-${index}.ts`, patch: capturedPatch(`src/${prefix}-${index}.ts`) }))
  const test = await harness({ sessions: [sessionInfo("ses_1", { updated: 1 }), sessionInfo("ses_2", { updated: 1 })], results: { capturedInputs: async () => [
    { id: "msg_user_1", type: "user" }, capturedReply("msg_reply_1", [{ type: "tool", id: "call_a", name: "edit", state: { status: "completed", structured: { files: files("a") } } }]),
    { id: "msg_user_2", type: "user" }, capturedReply("msg_reply_2", [{ type: "tool", id: "call_b", name: "edit", state: { status: "completed", structured: { files: files("b") } } }]),
  ] } })
  const first = valueOf(await capturedRun(test)) as { data: { placementMessageID: string; path: string }[]; cursor: { next: string } }
  expect(first.data).toHaveLength(100)
  expect(first.data.filter((group) => group.placementMessageID === "msg_reply_2")).toHaveLength(40)
  const second = valueOf(await capturedRun(test, first.cursor.next)) as { data: { placementMessageID: string; path: string }[]; cursor?: unknown }
  expect(second.data.map((group) => group.path)).toEqual(Array.from({ length: 20 }, (_, index) => `src/b-${index + 40}.ts`))
  expect(second.data.every((group) => group.placementMessageID === "msg_reply_2") && second.cursor === undefined).toBe(true)
  expect(errorOf(await capturedRun(test, first.cursor.next, "ses_2")).code).toBe("invalid_message")
  expect(errorOf(await capturedRun(test, "bad".repeat(100))).code).toBe("invalid_message")

  const largePatch = `@@ -1 +1 @@\n-old\n+${"x".repeat(600_000)}`
  const large = await harness({ results: { capturedInputs: async () => [{ id: "msg_user", type: "user" },
    capturedReply("msg_reply", [capturedEdit("src/large.ts", largePatch)])] } })
  const frames = await capturedRun(large)
  expect(frames.length).toBeLessThanOrEqual(RemoteLimits.maxChunksPerResponse)
  expect(valueOf(frames)).toMatchObject({ data: [{ placementMessageID: "msg_reply", path: "src/large.ts", additions: 0, deletions: 0, files: [{ diff: "", unavailable: true }] }] })
})

test("captured changes tags a running segment's completed edit with its last assistant and ends a child segment at a manual input", async () => {
  const test = await harness({ sessions: [sessionInfo("ses_1", { updated: 1 }), sessionInfo("ses_child", { updated: 2, directory: "/child", parentID: "ses_1" })], results: { capturedInputs: async (id: string) => id === "ses_1" ? [
    { id: "msg_user", type: "user" },
    capturedReply("msg_step_1", [capturedEdit("src/a.ts"), { type: "tool", id: "call_launch", name: "subagent", state: { status: "running", structured: { sessionID: "ses_child" } } }]),
    { id: "msg_step_2", type: "assistant", time: { created: 4 }, content: [] },
  ] : [
    { id: "msg_task_launch", type: "user" }, capturedReply("msg_child_1", [capturedEdit("src/child.ts")]),
    { id: "msg_manual", type: "user" }, capturedReply("msg_child_2", [capturedEdit("src/manual.ts")]),
  ] } })
  const page = valueOf(await capturedRun(test)) as { data: { placementMessageID: string; path: string }[] }
  expect(page.data.map((group) => [group.placementMessageID, group.path])).toEqual([["msg_step_2", "src/a.ts"], ["msg_step_2", "src/child.ts"]])
})

test("captured changes returns nothing for a Session with no completed edit and rejects a cursor for it", async () => {
  const test = await harness({ results: { capturedInputs: async () => [{ id: "msg_user", type: "user" },
    capturedReply("msg_reply", [capturedEdit("src/a.ts", undefined, "error"), capturedEdit("src/b.ts", undefined, "running")])] } })
  expect(valueOf(await capturedRun(test))).toEqual({ data: [] })
  expect(errorOf(await capturedRun(test, "AAAA")).code).toBe("invalid_message")
})

test("a 10 MiB managed attachment fits the bounded relay response without wasting half of each frame", () => {
  const frames = successFrames("req_attachment", { mime: "image/png", bytes: 10 * 1024 * 1024, data: Buffer.alloc(10 * 1024 * 1024).toString("base64") })
  expect(frames.length).toBeGreaterThan(1)
  expect(frames.length).toBeLessThanOrEqual(RemoteLimits.maxChunksPerResponse)
  expect(frames.every((frame) => frame.ok)).toBe(true)
})

test("streamed JSON chunks preserve Unicode across their UTF-8 byte boundary", () => {
  for (const prefix of ["", "p", "pp", "ppp"]) {
    const message = { id: "msg_emoji", text: prefix + "😀".repeat(180_000) }
    const frames = successFrames("req_emoji", message)
    expect(frames.length).toBeGreaterThan(1)
    const bytes = Buffer.concat(frames.map((frame) => Buffer.from(new TextEncoder().encode(String(frame.ok ? frame.value : "")))))
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(message)
  }
})

test("one-message stream carries a large indexed projection in bounded frames", async () => {
  const message = { id: "msg_long", type: "user", text: "long result ".repeat(200_000) }
  const test = await harness({ results: { messageRead: async () => message } })
  const run = (input: Record<string, unknown>) => executeRemoteOperation({ request: request("session.message.stream", input), sessions: test.registry, subscriptions: test.subscriptions, local: test.local })
  const frames = await run({ messageID: "msg_long" })
  expect(frames.length).toBeGreaterThan(1)
  expect(frames.length).toBeLessThanOrEqual(RemoteLimits.maxChunksPerResponse)
  expect(parseChunkedValue(frames.map((frame) => frame.ok ? String(frame.value) : ""))).toMatchObject({ ok: true, value: message })
  expect(errorOf(await run({ messageID: "msg_long", offset: 1 })).code).toBe("invalid_message")
  expect(test.calls.filter((call) => call.method === "messageRead").every((call) => call.args[0] === "ses_1" && recordOf(call.args[1]).directory === "/work")).toBe(true)
})

test("repeated references cannot expand one upload beyond the local admission byte budget", async () => {
  const test = await harness({ results: { prompt: { id: "msg_1" } } })
  const uploads = createAttachmentUploads()
  const uploadID = "4ab94d33-6e6b-41a3-a638-f0a6596854a9"
  const encoded = Buffer.alloc(RemoteLimits.maxAttachmentBytes).toString("base64")
  try {
    for (let offset = 0, index = 0; offset < encoded.length; offset += RemoteLimits.maxAttachmentChunkChars, index++)
      uploads.append("ses_1", uploadID, index, offset + RemoteLimits.maxAttachmentChunkChars >= encoded.length, encoded.slice(offset, offset + RemoteLimits.maxAttachmentChunkChars))
    const uri = `ycoding-upload://${uploadID}`
    const outcome = await executeRemoteOperation({ request: request("session.prompt", { text: "Review", files: [{ uri }, { uri }, { uri }] }), uploads,
      local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
    expect(errorOf(outcome).code).toBe("message_too_large")
    expect(test.calls.some((call) => call.method === "prompt")).toBe(false)
  } finally { uploads.clear() }
})

test("existing global Sessions appear in read-only workspace groups without enabling global creation", async () => {
  const directory = process.cwd()
  const session = { ...sessionInfo("ses_global", { updated: 1, directory }), projectID: Project.ID.global }
  const test = await harness({ sessions: [session], results: { projectList: [] } })
  const requestGroup = (sessionsOnly: boolean) => executeRemoteOperation({ request: request("workspace.list", { sessionsOnly }),
    local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
  expect(valueOf(await requestGroup(true))).toMatchObject({ data: [{ projectID: Project.ID.global, directory }] })
  expect(valueOf(await requestGroup(false))).toEqual({ data: [] })
})

const scratch = join(import.meta.dir, "../../../.cache/tmp")
await mkdir(scratch, { recursive: true })

function sessionInfo(id: string, table: { updated: number; title?: string; directory?: string; parentID?: string; agent?: string }): SessionInfo {
  const directory = table.directory ?? "/work"
  return {
    id,
    ...(table.parentID === undefined ? {} : { parentID: table.parentID }),
    ...(table.agent === undefined ? {} : { agent: table.agent }),
    projectID: "prj_1",
    // The contract carries a Model.Ref object, never a provider/model string.
    model: { providerID: "test", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: table.updated, updated: table.updated },
    title: table.title ?? id,
    location: { directory, workspaceID: undefined },
  } as unknown as SessionInfo
}

test("connector list forwards activity separately from the update ordering key", async () => {
  const older = { ...sessionInfo("ses_older", { updated: 100 }), time: { created: 100, updated: 100, active: 90 } }
  const newer = sessionInfo("ses_newer", { updated: 200 })
  const test = await harness({ sessions: [older, newer] })
  const page = valueOf(await executeRemoteOperation({ request: request("session.list", { order: "desc" }),
    local: test.local, sessions: test.registry, subscriptions: test.subscriptions })) as { data: SessionInfo[] }
  expect(page.data.map((row) => row.id)).toEqual([newer.id, older.id])
  expect(page.data.find((row) => row.id === older.id)?.time).toMatchObject({ updated: 100, active: 90 })
})

function formInfo(id: string, sessionID: string) {
  return {
    id,
    sessionID,
    title: "Approval",
    metadata: { kind: "question" },
    fields: [{ key: "approved", type: "boolean", title: "Approve?", required: true }],
  }
}

type Call = { readonly method: string; readonly args: readonly unknown[] }

function fakeLocal(results: Partial<Record<keyof LocalServer, unknown>> = {}) {
  results.outstandingSessions ??= { data: [], running: [], failed: [], lost: [] }
  results.permissionRequests ??= []
  results.formRequests ??= []
  results.guardrailRequestList ??= []
  results.snapshot ??= (id: string) => ({ sourceEpoch: "epoch_1", watermark: { type: "log.synced", aggregateID: id, seq: 1 } })
  const calls: Call[] = []
  const local = new Proxy({} as LocalServer, {
    get(_target, property: PropertyKey) {
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args })
        const result = results[property as keyof LocalServer]
        if (typeof result === "function") return Promise.resolve((result as (...a: unknown[]) => unknown)(...args))
        if (result instanceof Error) return Promise.reject(result)
        return Promise.resolve(result)
      }
    },
  })
  return { local, calls }
}

async function harness(options: {
  results?: Partial<Record<keyof LocalServer, unknown>>
  sessions?: readonly SessionInfo[]
}) {
  const infos = options.sessions ?? [sessionInfo("ses_1", { updated: 1 })]
  // The caller keeps the reference so a test can install a failure after setup.
  const results = options.results ?? {}
  results.listPage ??= async () => ({ data: infos })
  results.getSession ??= async (sessionID: string) => infos.find((info) => info.id === sessionID)
  const { local, calls } = fakeLocal(results)
  const registry = createSessionRegistry({
    local,
  })
  await registry.refresh()
  // Registry verification is setup, not part of the operation under test.
  calls.length = 0
  const subscriptions = createSubscriptions()
  return { local, calls, registry, subscriptions }
}

function request(operation: RemoteRequest["operation"], input?: Record<string, unknown>): RemoteRequest {
  return {
    type: "request",
    id: "req_1",
    operation,
    ...(requireSession(operation) ? { sessionID: "ses_1" } : {}),
    ...(input === undefined ? {} : { input }),
  }
}

/** Read operations this suite maps; the shared contract owns the full operation list. */
const readOperations = [
  "session.get",
  "session.messages",
  "session.compaction.list",
  "session.snapshot",
  "session.pending.list",
  "session.todo.list",
  "session.active",
  "session.log",
  "session.autonomy.get",
  "session.permission.list",
  "session.guardrail.status",
  "session.guardrail.request.list",
  "session.form.list",
] as const

function valueOf(frames: readonly { ok: boolean }[]) {
  expect(frames).toHaveLength(1)
  const frame = frames[0] as { ok: true; value: unknown }
  expect(frame.ok).toBe(true)
  return frame.value
}

function errorOf(frames: readonly { ok: boolean }[]) {
  expect(frames).toHaveLength(1)
  const frame = frames[0] as { ok: false; error: { code: string; message: string } }
  expect(frame.ok).toBe(false)
  return frame.error
}

function recordOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected an object")
  return value
}

function arrayOf(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array")
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

describe("backend Session authorization", () => {
  test("notifies changed metadata when a scoped verification sees it before periodic refresh", async () => {
    let current = sessionInfo("ses_1", { updated: 1, title: "Initial" })
    let invalidations = 0
    const { local } = fakeLocal({ listPage: async () => ({ data: [current] }), getSession: async () => current })
    const registry = createSessionRegistry({ local, onChange: () => invalidations++ })
    await registry.refresh()
    invalidations = 0
    current = { ...current, title: "Renamed" }
    await registry.verify("ses_1")
    expect(invalidations).toBe(1)
    await registry.refresh()
    expect(invalidations).toBe(1)
    current = { ...current, location: { directory: "/work/moved" }, time: { ...current.time, pinned: 2 } }
    await registry.verify("ses_1")
    expect(invalidations).toBe(2)
  })

  test("keeps activity that only advances the updated time out of client list invalidations", async () => {
    let current = sessionInfo("ses_1", { updated: 1, title: "Initial" })
    let invalidations = 0
    const { local } = fakeLocal({ listPage: async () => ({ data: [current] }), getSession: async () => current })
    const registry = createSessionRegistry({ local, onChange: () => invalidations++ })
    await registry.refresh()
    invalidations = 0
    for (let updated = 2; updated <= 50; updated++) {
      current = { ...current, time: { ...current.time, updated } }
      await registry.verify("ses_1")
    }
    await registry.refresh()
    expect(invalidations).toBe(0)
    expect(registry.snapshot().map((session) => session.time.updated)).toEqual([50])
  })

  test("records reported activity without notifying list consumers", async () => {
    let current = { ...sessionInfo("ses_1", { updated: 1 }), time: { created: 1, updated: 1, active: 2 } }
    let invalidations = 0
    const { local } = fakeLocal({ listPage: async () => ({ data: [current] }), getSession: async () => current })
    const registry = createSessionRegistry({ local, onChange: () => invalidations++ })
    await registry.refresh()
    invalidations = 0
    current = { ...current, time: { ...current.time, active: 5 } }
    await registry.verify("ses_1")
    expect(invalidations).toBe(0)
    expect(registry.snapshot()[0]?.time.active).toBe(5)
    await registry.refresh()
    expect(invalidations).toBe(0)
  })

  test("a verification window serves repeated verifications until invalidated, renewed, or elapsed", async () => {
    let clock = 0
    const current = sessionInfo("ses_1", { updated: 1 })
    const { local, calls } = fakeLocal({ listPage: async () => ({ data: [current] }), getSession: async () => current })
    const registry = createSessionRegistry({ local, verifyWindowMs: 1_000, now: () => clock })
    await registry.refresh()
    const reads = () => calls.filter((call) => call.method === "getSession").length
    await registry.verify("ses_1")
    await registry.verify("ses_1")
    expect(reads()).toBe(1)
    registry.invalidate("ses_1")
    await registry.verify("ses_1")
    expect(reads()).toBe(2)
    await registry.renew("ses_1")
    expect(reads()).toBe(3)
    clock = 1_000
    await registry.verify("ses_1")
    expect(reads()).toBe(4)
  })

  test("concurrent verifications of one Session share a single read that aborts with its last waiter", async () => {
    const gate = Promise.withResolvers<void>()
    const current = sessionInfo("ses_1", { updated: 1 })
    let seen: AbortSignal | undefined
    const { local, calls } = fakeLocal({ listPage: async () => ({ data: [current] }), getSession: async (...args: unknown[]) => { seen = args[2] as AbortSignal; await gate.promise; return current } })
    const registry = createSessionRegistry({ local })
    await registry.refresh()
    const first = new AbortController()
    const second = new AbortController()
    const one = registry.verify("ses_1", first.signal)
    const two = registry.verify("ses_1", second.signal)
    const three = registry.verify("ses_1")
    expect(calls.filter((call) => call.method === "getSession")).toHaveLength(1)
    first.abort()
    expect(seen?.aborted).toBe(false)
    await expect(one).rejects.toBeDefined()
    gate.resolve()
    expect((await two)?.id).toBe("ses_1")
    expect((await three)?.id).toBe("ses_1")
  })

  test("adds one created Session at its reported Location without reading the inventory", async () => {
    let changes = 0
    const created = sessionInfo("ses_new", { updated: 2, directory: "/elsewhere" })
    const { local, calls } = fakeLocal({ listPage: async () => ({ data: [] }), getSession: async () => created })
    const registry = createSessionRegistry({ local, onChange: () => changes++ })
    await registry.refresh()
    calls.length = 0
    await registry.add("ses_new", { directory: "/elsewhere" })
    await registry.add("ses_new", { directory: "/elsewhere" })
    expect(calls.map((call) => [call.method, call.args[0], call.args[1]])).toEqual([["getSession", "ses_new", { directory: "/elsewhere" }]])
    expect(registry.ids()).toEqual(["ses_new"])
    expect(changes).toBe(1)
  })

  test("refuses a session absent from the authoritative backend inventory", async () => {
    const { local, registry, subscriptions, calls } = await harness({})
    const outcome = await executeRemoteOperation({
      request: { ...request("session.messages"), sessionID: "ses_other" },
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("session_not_allowed")
    expect(calls.map((call) => call.method)).toEqual(["listPage"])
  })

  test("relays the local compaction history read at the verified Location without reading the transcript", async () => {
    const history = {
      data: [
        { jobID: "cmp_a", trigger: "auto", status: "running", created: 1 },
        { jobID: "cmp_b", trigger: "manual", status: "failed", code: "cancelled", created: 2 },
        { jobID: "cmp_c", trigger: "manual", status: "completed", metrics: { excludedMessages: 3, excludedParts: 1, inputTokens: 100, retainedTokens: 40 }, created: 3 },
      ],
      truncated: true, completedBefore: 3, completedCount: 4, totalSavedTokens: 240,
    }
    const { local, registry, subscriptions, calls } = await harness({
      sessions: [sessionInfo("ses_1", { updated: 1, directory: "/bound" })],
      results: { compactionList: async () => history },
    })
    const run = (sessionID = "ses_1") => executeRemoteOperation({ request: { ...request("session.compaction.list"), sessionID }, sessions: registry, subscriptions, local })
    expect(errorOf(await run("ses_foreign")).code).toBe("session_not_allowed")
    expect(calls.some((call) => call.method === "compactionList")).toBe(false)
    expect(valueOf(await run())).toEqual(history)
    expect(calls.filter((call) => call.method === "compactionList")).toEqual([{ method: "compactionList", args: ["ses_1", { directory: "/bound" }] }])
  })

  test("serves every backend session from the global list", async () => {
    const sessions = [sessionInfo("ses_1", { updated: 2 }), sessionInfo("ses_2", { updated: 1, directory: "/work/two" })]
    const { local, registry, subscriptions } = await harness({
      sessions,
      results: { getSession: async (sessionID: string) => sessions.find((session) => session.id === sessionID) },
    })
    await registry.refresh()
    const outcome = await executeRemoteOperation({ request: request("session.list"), sessions: registry, subscriptions, local })
    const value = valueOf(outcome) as { data: readonly SessionInfo[] }
    expect(value.data.map((session) => session.id)).toEqual(["ses_1", "ses_2"])
    // The relayed session keeps the contract's field shapes: Model.Ref stays an object.
    expect(value.data[0].model).toEqual({ providerID: "test", id: "model" })
  })

  test("always addresses the local server at its backend Location, never a remote value", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      results: { prompt: async () => ({ id: "msg_1" }) },
    })
    const rejected = await executeRemoteOperation({
      request: request("session.prompt", { text: "hi", directory: "/etc" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(rejected).code).toBe("invalid_message")
    expect(calls).toEqual([])

    const accepted = await executeRemoteOperation({
      request: request("session.prompt", { text: "hi" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(accepted)).toEqual({ data: { id: "msg_1" } })
    expect(calls.at(-1)).toEqual({ method: "prompt", args: ["ses_1", { directory: "/work" }, { text: "hi" }] })
  })
})

describe("workspace inventory and Session creation", () => {
  test("passes explicit agent and model choices to the local Session create", async () => {
    const directory = process.cwd()
    const sessions = [sessionInfo("ses_seed", { updated: 1, directory })]
    const test = await harness({ sessions, results: {
      projectList: [{ id: "prj_1", worktree: directory }], projectDirectories: [], projectCurrent: { id: "prj_1", directory },
      createSession: (id: string) => {
        const created = sessionInfo(id, { updated: 2, directory })
        sessions.push(created)
        return created
      },
    } })
    const workspaces = arrayOf(recordOf(valueOf(await executeRemoteOperation({ request: request("workspace.list"), local: test.local,
      sessions: test.registry, subscriptions: test.subscriptions }))).data)
    const model = { providerID: "test", id: "model", variant: "high", profile: "work" }
    const outcome = await executeRemoteOperation({ request: request("session.create", { id: "ses_chosen", workspace: recordOf(workspaces[0]).id,
      agent: "build", model }), local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
    expect(valueOf(outcome)).toMatchObject({ data: { id: "ses_chosen" } })
    expect(test.calls.find((call) => call.method === "createSession")?.args).toEqual(["ses_chosen", { directory }, "build", model])
  })

  test("hides temporary and global creation workspaces while listing existing global Sessions read-only", async () => {
    const directory = process.cwd()
    const sessions = [sessionInfo("ses_allowed", { updated: 1, directory }),
      { ...sessionInfo("ses_global", { updated: 2, directory }), projectID: "global" },
      sessionInfo("ses_temp", { updated: 3, directory: "/tmp" })]
    const test = await harness({ sessions, results: {
      projectList: [{ id: "global", worktree: directory }, { id: "prj_1", worktree: directory }],
      projectDirectories: async () => [{ directory }, { directory: "/tmp" }],
    } })
    for (const input of [undefined, { sessionsOnly: true }]) {
      const value = arrayOf(recordOf(valueOf(await executeRemoteOperation({ request: request("workspace.list", input), local: test.local,
        sessions: test.registry, subscriptions: test.subscriptions }))).data)
      expect(value).toHaveLength(input?.sessionsOnly ? 2 : 1)
      expect(value.find((item) => recordOf(item).projectID === "prj_1")).toMatchObject({ projectID: "prj_1", directory, name: "cli" })
      if (input?.sessionsOnly) expect(value.find((item) => recordOf(item).projectID === "global")).toMatchObject({ projectID: "global", directory })
    }
  })

  test("resolves dot segments so a recorded directory joins and names its workspace", async () => {
    const directory = process.cwd()
    const sessions = [sessionInfo("ses_plain", { updated: 1, directory }), sessionInfo("ses_dotted", { updated: 2, directory: `${directory}/test/..` })]
    const test = await harness({ sessions, results: { projectList: [{ id: "prj_1", worktree: directory }], projectDirectories: async () => [] } })
    for (const input of [undefined, { sessionsOnly: true }]) {
      const value = arrayOf(recordOf(valueOf(await executeRemoteOperation({ request: request("workspace.list", input), local: test.local,
        sessions: test.registry, subscriptions: test.subscriptions }))).data)
      expect(value).toHaveLength(1)
      expect(value[0]).toMatchObject({ projectID: "prj_1", directory, name: "cli" })
      const id = String(recordOf(value[0]).id)
      expect(listPage(sessions, parseListQuery({ workspace: id, limit: 10 })).data.map((session) => session.id)).toEqual(["ses_dotted", "ses_plain"])
    }
  })

  test("uses backend inventory only, rejects changed project and child-ID reuse, and verifies a root create", async () => {
    const directory = await mkdtemp(join(scratch, "ycoding-remote-workspace-unit-"))
    const globalWorktree = await mkdtemp(join(scratch, "ycoding-global-project-worktree-"))
    try {
      let sessions = [sessionInfo("ses_seed", { updated: 1, directory })]
      let currentProjectID = "prj_changed"
      const results: Partial<Record<keyof LocalServer, unknown>> = {
        listPage: async () => ({ data: sessions }),
        getSession: async (sessionID: string) => sessions.find((session) => session.id === sessionID),
        projectList: async () => [
          { id: "global", worktree: globalWorktree, time: { created: 1, updated: 1 }, sandboxes: [] },
          { id: "prj_1", worktree: "/", name: "Test project", time: { created: 1, updated: 1 }, sandboxes: [] },
        ],
        projectDirectories: async (projectID: string) => (projectID === "prj_1" ? [{ directory }] : []),
        projectCurrent: async () => ({ id: currentProjectID, directory: "/" }),
        createSession: async (id: string, location: { directory: string; workspaceID?: string }) => {
          const created = { ...sessionInfo(id, { updated: 2, directory }), location }
          sessions = [...sessions, created]
          return created
        },
      }
      const { local, calls } = fakeLocal(results)
      const registry = createSessionRegistry({ local })
      await registry.refresh()
      calls.length = 0
      const subscriptions = createSubscriptions()
      const inventoryResponse = await executeRemoteOperation({
        request: request("workspace.list"),
        sessions: registry,
        subscriptions,
        local,
      })
      const inventory = arrayOf(recordOf(valueOf(inventoryResponse)).data)
      expect(inventory).toHaveLength(1)
      expect(recordOf(inventory[0])).toMatchObject({ projectID: "prj_1", directory, name: "Test project" })
      expect(inventory.map((workspace) => recordOf(workspace).directory)).not.toContain(globalWorktree)
      expect(calls.some((call) => call.method === "projectCurrent")).toBe(false)
      const workspace = recordOf(inventory[0]).id
      if (typeof workspace !== "string") throw new Error("workspace identifier was missing")

      const changed = await executeRemoteOperation({
        request: request("session.create", { id: "ses_created", workspace }),
        sessions: registry,
        subscriptions,
        local,
      })
      expect(errorOf(changed).code).toBe("invalid_message")
      expect(calls.some((call) => call.method === "createSession")).toBe(false)

      currentProjectID = "prj_1"
      const created = await executeRemoteOperation({
        request: request("session.create", { id: "ses_created", workspace }),
        sessions: registry,
        subscriptions,
        local,
      })
      expect(valueOf(created)).toMatchObject({ data: { id: "ses_created", projectID: "prj_1", location: { directory } } })
      expect(calls.some((call) => call.method === "projectCurrent")).toBe(true)
      expect(calls.find((call) => call.method === "createSession")).toEqual({
        method: "createSession",
        args: ["ses_created", { directory }],
      })

      sessions = [...sessions, sessionInfo("ses_child_taken", { updated: 3, directory, parentID: "ses_seed" })]
      const childReuse = await executeRemoteOperation({
        request: request("session.create", { id: "ses_child_taken", workspace }),
        sessions: registry,
        subscriptions,
        local,
      })
      expect(errorOf(childReuse).code).toBe("invalid_message")
      expect(calls.filter((call) => call.method === "createSession")).toHaveLength(1)

      results.createSession = () => Promise.reject(new LocalFailureClass("transport", "no response"))
      const uncertain = await executeRemoteOperation({
        request: request("session.create", { id: "ses_create_uncertain", workspace }),
        sessions: registry,
        subscriptions,
        local,
      })
      expect(errorOf(uncertain).code).toBe("outcome_unknown")
      expect(calls.filter((call) => call.method === "createSession")).toHaveLength(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
      await rm(globalWorktree, { recursive: true, force: true })
    }
  })
})

describe("operation mapping", () => {
  test("maps frozen accounting and forecast reads at verified Session Locations and rejects invalid scopes", async () => {
    const empty = { requests: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: { pricedRequests: 0, unpricedRequests: 0 } }
    const prompts = { units: [], unattributed: empty, history: "retained" }
    const tasks = { tasks: [], total: empty, history: "retained" }
    const forecast = { asOf: 1, localScope: "backend", localRates: [], quotas: [] }
    const report = { group: "profile", rows: [], total: {}, rowCount: 0 }
    const fixture = await harness({ results: { promptCosts: prompts, taskCosts: tasks, sessionUsageReport: report, usageForecast: { data: forecast } } })
    const run = (operation: RemoteRequest["operation"], fields: Record<string, unknown>, sessionID?: string) => executeRemoteOperation({ request: { ...request(operation, fields), ...(sessionID ? { sessionID } : {}) }, local: fixture.local, sessions: fixture.registry, subscriptions: fixture.subscriptions })
    expect(valueOf(await run("session.promptCosts", { inputIDs: ["msg_original"] }, "ses_1"))).toEqual({ data: prompts })
    expect(valueOf(await run("session.taskCosts", { sessionIDs: ["ses_1"] }, "ses_1"))).toEqual({ data: tasks })
    expect(valueOf(await run("session.usageReport", { group: "profile", providerID: "openai", profile: "Work", modelID: "shared", selectedEffort: "high" }, "ses_1"))).toEqual({ data: report })
    expect(valueOf(await run("usage.forecast", { localScope: "backend" }))).toEqual({ data: forecast })
    expect(valueOf(await run("usage.forecast", { localScope: "location" }, "ses_1"))).toEqual({ data: forecast })
    expect(fixture.calls.filter((call) => ["promptCosts", "taskCosts", "sessionUsageReport", "usageForecast"].includes(call.method))).toEqual([
      { method: "promptCosts", args: ["ses_1", { directory: "/work" }, ["msg_original"]] },
      { method: "taskCosts", args: ["ses_1", { directory: "/work" }, ["ses_1"]] },
      { method: "sessionUsageReport", args: ["ses_1", { directory: "/work" }, { group: "profile", providerID: "openai", profile: "Work", modelID: "shared", selectedEffort: "high" }] },
      { method: "usageForecast", args: ["backend"] }, { method: "usageForecast", args: ["location", { directory: "/work" }] },
    ])
    expect(errorOf(await run("usage.forecast", { localScope: "backend" }, "ses_1")).code).toBe("invalid_message")
    expect(errorOf(await run("usage.forecast", { localScope: "location" })).code).toBe("invalid_message")
    expect(errorOf(await run("session.promptCosts", { inputIDs: ["msg_original", "msg_original"] }, "ses_1")).code).toBe("invalid_message")
    expect(errorOf(await run("session.taskCosts", { sessionIDs: Array.from({ length: 101 }, (_, index) => `ses_${index}`) }, "ses_1")).code).toBe("invalid_message")
    expect(errorOf(await run("session.promptCosts", { inputIDs: ["msg_original"] }, "ses_foreign")).code).toBe("session_not_allowed")
  })

  test("maps global usage reads to their exact local Protocol bodies without a browser Location", async () => {
    const providers = { location: { directory: "/work", project: { id: "prj_1", directory: "/work" } }, data: [{ providerID: "test", status: "available", source: "provider_api", stability: "stable", windows: [] }] }
    const summary = { logical: 1, physical: 1, tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }
    const report = { group: "model", rows: [], total: summary, rowCount: 0 }
    const test = await harness({ results: { providerUsageList: providers, usageSummary: summary, usageReport: report } })
    const runUsage = (operation: RemoteRequest["operation"], input?: Record<string, unknown>) => executeRemoteOperation({
      request: request(operation, input), local: test.local, sessions: test.registry, subscriptions: test.subscriptions,
    })
    expect(valueOf(await runUsage("usage.providers", { refresh: true }))).toEqual({ data: providers.data })
    expect(valueOf(await runUsage("usage.summary"))).toEqual({ data: summary })
    expect(valueOf(await runUsage("usage.report", { group: "model", from: 0, to: 10, limit: 2, sort: "cost", order: "desc" }))).toEqual({ data: report })
    expect(valueOf(await runUsage("usage.report", { group: "day", timeZone: "Asia/Kathmandu" }))).toEqual({ data: report })
    expect(test.calls.filter((call) => ["providerUsageList", "usageSummary", "usageReport"].includes(call.method))).toEqual([
      { method: "providerUsageList", args: [true] }, { method: "usageSummary", args: [] },
      { method: "usageReport", args: [{ group: "model", from: 0, to: 10, limit: 2, sort: "cost", order: "desc" }] },
      { method: "usageReport", args: [{ group: "day", timeZone: "Asia/Kathmandu" }] },
    ])
    test.calls.length = 0
    expect(errorOf(await runUsage("usage.report", { group: "model", limit: 201 })).code).toBe("invalid_message")
    expect(errorOf(await runUsage("usage.report", { group: "day", timeZone: "" })).code).toBe("invalid_message")
    expect(test.calls.some((call) => call.method === "usageReport")).toBe(false)
  })

  test("maps global incident reads to exact local calls without a Session or browser Location", async () => {
    const report = { rows: [{ providerID: "p", modelID: "m", fallbacks: 1, escalated: 0, rejected: 0, last: 5 }], groups: 1 }
    const recent = { items: [{ id: "inc_1", time: 5, kind: "fallback", category: "rate_limit", ruleIDs: [], agent: "build" }] }
    const test = await harness({ results: { incidentReport: report, incidentRecent: recent } })
    const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>, sessionID?: string) => executeRemoteOperation({
      request: { ...request(operation, input), ...(sessionID ? { sessionID } : {}) }, local: test.local, sessions: test.registry, subscriptions: test.subscriptions,
    })
    expect(valueOf(await run("incident.report", { group: "agent", from: 1, to: 9, offset: 2, limit: 50 }))).toEqual({ data: report })
    expect(valueOf(await run("incident.report", { group: "model" }))).toEqual({ data: report })
    expect(valueOf(await run("incident.recent", { provider: "p", model: "m" }))).toEqual({ data: recent })
    expect(valueOf(await run("incident.recent", { provider: "p", model: "m", agent: "build", limit: 20 }))).toEqual({ data: recent })
    expect(test.calls.filter((call) => call.method.startsWith("incident"))).toEqual([
      { method: "incidentReport", args: [{ group: "agent", from: 1, to: 9, offset: 2, limit: 50 }] },
      { method: "incidentReport", args: [{ group: "model" }] },
      { method: "incidentRecent", args: [{ provider: "p", model: "m" }] },
      { method: "incidentRecent", args: [{ provider: "p", model: "m", agent: "build", limit: 20 }] },
    ])
    test.calls.length = 0
    for (const [operation, input] of [
      ["incident.report", undefined], ["incident.report", {}], ["incident.report", { group: "session" }],
      ["incident.report", { group: "model", limit: 201 }], ["incident.report", { group: "model", limit: 0 }],
      ["incident.report", { group: "model", offset: -1 }], ["incident.report", { group: "model", from: 9, to: 1 }],
      ["incident.report", { group: "model", directory: "/private" }], ["incident.report", { group: "model", workspace: "w" }],
      ["incident.report", { group: "model", location: "/private" }], ["incident.report", { group: "model", sessionID: "ses_1" }],
      ["incident.recent", undefined], ["incident.recent", { provider: "p" }], ["incident.recent", { provider: "p", model: "m", limit: 51 }],
      ["incident.recent", { provider: "p", model: "m", agent: "" }], ["incident.recent", { provider: "p", model: "m", directory: "/private" }],
    ] as const) expect(errorOf(await run(operation, input)).code).toBe("invalid_message")
    expect(errorOf(await run("incident.report", { group: "model" }, "ses_1")).code).toBe("invalid_message")
    expect(errorOf(await run("incident.recent", { provider: "p", model: "m" }, "ses_1")).code).toBe("invalid_message")
    expect(test.calls).toEqual([])
  })

  test("guidance reads and clears resolve the owning Session Location through the backend, or use the backend default without one", async () => {
    const guidance = { enabled: true, text: "note" }
    const cleared = { enabled: true, clearedAt: 7 }
    const test = await harness({
      sessions: [sessionInfo("ses_1", { updated: 1 }), sessionInfo("ses_other", { updated: 2, directory: "/other" })],
      results: { incidentGuidance: guidance, incidentGuidanceClear: cleared },
    })
    const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>, sessionID?: string) => executeRemoteOperation({
      request: { ...request(operation, input), ...(sessionID ? { sessionID } : {}) }, local: test.local, sessions: test.registry, subscriptions: test.subscriptions,
    })
    const model = { provider: "p", model: "m" }
    expect(valueOf(await run("incident.guidance", model))).toEqual({ data: guidance })
    expect(valueOf(await run("incident.guidance", model, "ses_1"))).toEqual({ data: guidance })
    expect(valueOf(await run("incident.guidance", model, "ses_other"))).toEqual({ data: guidance })
    expect(valueOf(await run("incident.guidance.clear", model))).toEqual({ data: cleared })
    expect(valueOf(await run("incident.guidance.clear", model, "ses_1"))).toEqual({ data: cleared })
    expect(test.calls.filter((call) => call.method.startsWith("incident"))).toEqual([
      { method: "incidentGuidance", args: [model] },
      { method: "incidentGuidance", args: [model, { directory: "/work" }] },
      { method: "incidentGuidance", args: [model, { directory: "/other" }] },
      { method: "incidentGuidanceClear", args: [model] },
      { method: "incidentGuidanceClear", args: [model, { directory: "/work" }] },
    ])
  })

  test("guidance fails closed for unowned or unknown Sessions and for browser-selected scope", async () => {
    const test = await harness({ sessions: [sessionInfo("ses_1", { updated: 1 })], results: { incidentGuidance: { enabled: true }, incidentGuidanceClear: { enabled: true } } })
    const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>, sessionID?: string) => executeRemoteOperation({
      request: { ...request(operation, input), ...(sessionID ? { sessionID } : {}) }, local: test.local, sessions: test.registry, subscriptions: test.subscriptions,
    })
    const model = { provider: "p", model: "m" }
    test.calls.length = 0
    for (const operation of ["incident.guidance", "incident.guidance.clear"] as const) {
      expect(errorOf(await run(operation, model, "ses_foreign")).code).toBe("session_not_allowed")
      expect(errorOf(await run(operation, model, "ses_unknown")).code).toBe("session_not_allowed")
      for (const input of [undefined, {}, { provider: "p" }, { provider: "", model: "m" }, { ...model, sessionID: "ses_1" },
        { ...model, directory: "/private" }, { ...model, workspace: "w" }, { ...model, location: { directory: "/private" } }, { ...model, agent: "build" }])
        expect(errorOf(await run(operation, input, "ses_1")).code).toBe("invalid_message")
    }
    expect(test.calls.filter((call) => call.method.startsWith("incident"))).toEqual([])
  })

  test("a managed subagent Session cannot clear guidance but may read it", async () => {
    const sessions = [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_child", { updated: 2, parentID: "ses_root", agent: "general" })]
    const test = await harness({ sessions, results: { incidentGuidance: { enabled: true }, incidentGuidanceClear: { enabled: true } } })
    const send = (operation: RemoteRequest["operation"]) => executeRemoteOperation({
      request: { ...request(operation, { provider: "p", model: "m" }), sessionID: "ses_child" }, local: test.local, sessions: test.registry, subscriptions: test.subscriptions,
    })
    expect(errorOf(await send("incident.guidance.clear")).code).toBe("subagent_read_only")
    expect(valueOf(await send("incident.guidance"))).toEqual({ data: { enabled: true } })
    expect(test.calls.some((call) => call.method === "incidentGuidanceClear")).toBe(false)
  })

  test("an unconfirmed guidance clear is unknown, not failed or replayed", async () => {
    const test = await harness({ results: { incidentGuidanceClear: new LocalFailureClass("transport", "Socket closed") } })
    expect(errorOf(await executeRemoteOperation({ request: request("incident.guidance.clear", { provider: "p", model: "m" }),
      local: test.local, sessions: test.registry, subscriptions: test.subscriptions })).code).toBe("outcome_unknown")
    expect(test.calls.filter((call) => call.method === "incidentGuidanceClear")).toHaveLength(1)
  })

  test("a cached-attention status still refuses more than 500 running roots", async () => {
    const sessions = Array.from({ length: RemoteLimits.maxStatusSessions + 1 }, (_, index) => sessionInfo(`ses_${index}`, { updated: index }))
    const { local } = fakeLocal({ outstandingSessions: { data: sessions.map((session) => session.id), running: sessions.map((session) => session.id), failed: [], lost: [] } })
    const failure = await sessionStatus(local, sessions, {}).then(() => undefined, (cause: unknown) => cause)
    expect(failure instanceof Error ? failure.message : undefined).toBe("Session status exceeds the bounded root count")
  })

  test("status reads pending requests only at Locations with an executing Session", async () => {
    const directory = process.cwd()
    const idleLocation = join(directory, "src")
    const sessions = [
      sessionInfo("ses_root", { updated: 1, directory }),
      sessionInfo("ses_child", { updated: 2, directory, parentID: "ses_root" }),
      sessionInfo("ses_idle", { updated: 3, directory }),
      sessionInfo("ses_elsewhere", { updated: 4, directory: idleLocation }),
      sessionInfo("ses_gone", { updated: 5, directory: "/nonexistent/ycoding-removed-workspace" }),
    ]
    const idleRead = new Error("an idle Location was read for status")
    const { local, calls } = fakeLocal({
      outstandingSessions: { data: ["ses_child"], running: ["ses_child"], failed: [], lost: [] },
      permissionRequests: async (location: LocalLocation) => location.directory === directory ? [{ id: "per_1", sessionID: "ses_child" }] : Promise.reject(idleRead),
      formRequests: async (location: LocalLocation) => location.directory === directory ? [formInfo("frm_1", "ses_idle")] : Promise.reject(idleRead),
      guardrailRequestList: async () => [],
    })
    expect(await sessionStatus(local, sessions)).toEqual({ running: ["ses_root"], attention: ["ses_idle", "ses_root"],
      requestAttention: ["ses_idle", "ses_root"], requestNeeds: { ses_idle: "question", ses_root: "permission" }, failed: [] })
    expect(calls.filter((call) => call.method === "permissionRequests").map((call) => call.args[0])).toEqual([{ directory }])
    expect(calls.filter((call) => call.method === "formRequests").map((call) => call.args[0])).toEqual([{ directory }])
    expect(calls.filter((call) => call.method === "guardrailRequestList").map((call) => call.args[0])).toEqual(["ses_root"])
    expect(calls.some((call) => call.method === "permissionList" || call.method === "formList")).toBe(false)
  })

  test("a lost shell notice in a child belongs to its root's attention, not failed or outstanding work", async () => {
    const sessions = [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_child", { updated: 2, parentID: "ses_root" })]
    const { local } = fakeLocal({ outstandingSessions: { data: [], running: [], failed: [], lost: ["ses_child"] } })
    expect(await sessionStatus(local, sessions)).toEqual({ running: [], attention: ["ses_root"],
      requestAttention: [], requestNeeds: {}, failed: [], lost: ["ses_root"] })
  })

  test("status does not silently accept an older backend missing the required lost field", async () => {
    const { local } = fakeLocal({ outstandingSessions: { data: [], running: [], failed: [] } })
    await expect(sessionStatus(local, [sessionInfo("ses_root", { updated: 1 })])).rejects.toThrow(
      "Local server requires an update before remote Session status can be read",
    )
  })

  test("status names what each attention root waits for, preferring a permission over a question over a review", async () => {
    const directory = process.cwd()
    const sessions = [sessionInfo("ses_a", { updated: 1, directory }), sessionInfo("ses_b", { updated: 2, directory }),
      sessionInfo("ses_c", { updated: 3, directory }), sessionInfo("ses_c_child", { updated: 4, directory, parentID: "ses_c" })]
    const { local } = fakeLocal({
      outstandingSessions: { data: [], running: ["ses_a", "ses_b", "ses_c"], failed: [], lost: [] },
      permissionRequests: [{ id: "per_1", sessionID: "ses_c_child" }],
      formRequests: [formInfo("frm_1", "ses_b"), formInfo("frm_2", "ses_c")],
      guardrailRequestList: async (rootID: string) => [{ id: "grq_1", sessionID: rootID }],
    })
    const status = await sessionStatus(local, sessions)
    expect(status.requestNeeds).toEqual({ ses_a: "review", ses_b: "question", ses_c: "permission" })
    expect(attentionDetails(sessions, status.attention, status.requestNeeds)).toEqual([
      { sessionID: "ses_a", title: "ses_a", need: "review" },
      { sessionID: "ses_b", title: "ses_b", need: "question" },
      { sessionID: "ses_c", title: "ses_c", need: "permission" },
    ])
    expect(await sessionStatus(local, sessions, status.requestNeeds)).toMatchObject({ requestNeeds: status.requestNeeds })
  })

  test("maps the one process-wide outstanding read to non-executing family roots without per-root work reads", async () => {
    const sessions = [sessionInfo("ses_parent", { updated: 1 }),
      sessionInfo("ses_child", { updated: 2, parentID: "ses_parent" }), sessionInfo("ses_other", { updated: 3 })]
    const { local, calls } = fakeLocal({ outstandingSessions: { data: ["ses_child", "ses_other"], running: ["ses_other"], failed: [], lost: [] } })
    expect(await sessionStatus(local, sessions, {})).toMatchObject({ running: ["ses_other"], outstanding: ["ses_parent"] })
    expect(calls.map((call) => call.method)).toEqual(["outstandingSessions"])
  })

  test("status folds active descendants and unresolved requests to unique root IDs", async () => {
    const directory = process.cwd()
    const sessions = [sessionInfo("ses_root", { updated: 1, directory }), sessionInfo("ses_child", { updated: 2, parentID: "ses_root", directory }), sessionInfo("ses_other", { updated: 3, directory })]
    const { local, registry, subscriptions } = await harness({ sessions, results: {
      outstandingSessions: { data: ["ses_child"], running: ["ses_child"], failed: [], lost: [] },
      permissionRequests: async () => [{ id: "per_1", sessionID: "ses_child" }],
      formRequests: async () => [formInfo("frm_1", "ses_other")],
      guardrailRequestList: async (id: string) => id === "ses_root" ? [{ id: "grq_1", sessionID: "ses_child", rootSessionID: id }] : [],
    } })
    const outcome = await executeRemoteOperation({ request: request("session.status"), local, sessions: registry, subscriptions })
    expect(valueOf(outcome)).toEqual({ running: ["ses_root"], attention: ["ses_other", "ses_root"] })
  })

  test("status reports failure-only roots as the failed subset of attention", async () => {
    const directory = process.cwd()
    const sessions = [sessionInfo("ses_failed", { updated: 1, directory }), sessionInfo("ses_both", { updated: 2, directory }),
      sessionInfo("ses_child", { updated: 3, parentID: "ses_failed", directory })]
    const { local, registry, subscriptions } = await harness({ sessions, results: {
      permissionRequests: async () => [{ id: "per_1", sessionID: "ses_both" }],
      formRequests: async () => [],
      outstandingSessions: { data: ["ses_both"], running: ["ses_both"], failed: ["ses_child", "ses_both"], lost: [] },
      guardrailRequestList: async () => [],
    } })
    const outcome = await executeRemoteOperation({ request: request("session.status"), local, sessions: registry, subscriptions })
    expect(valueOf(outcome)).toEqual({ running: ["ses_both"], attention: ["ses_both", "ses_failed"], failed: ["ses_failed"] })
  })

  test("a lost shell notice takes attention precedence over a failed run in the same family", async () => {
    const sessions = [sessionInfo("ses_lost", { updated: 1 }), sessionInfo("ses_failed", { updated: 2 })]
    const { local, registry, subscriptions } = await harness({
      sessions,
      results: {
        outstandingSessions: { data: [], running: [], failed: ["ses_lost", "ses_failed"], lost: ["ses_lost"] },
      },
    })
    const outcome = await executeRemoteOperation({
      request: request("session.status"),
      local,
      sessions: registry,
      subscriptions,
    })
    expect(valueOf(outcome)).toEqual({ running: [], attention: ["ses_failed", "ses_lost"], failed: ["ses_failed"], lost: ["ses_lost"] })
  })

  test("status reports a loss-only idle root in lost and never in failed, with no request to answer", async () => {
    const sessions = [sessionInfo("ses_eval", { updated: 1 }), sessionInfo("ses_child", { updated: 2, parentID: "ses_eval" })]
    const { local, registry, subscriptions } = await harness({ sessions, results: {
      outstandingSessions: { data: [], running: [], failed: [], lost: ["ses_child"] },
    } })
    const outcome = await executeRemoteOperation({ request: request("session.status"), local, sessions: registry, subscriptions })
    expect(valueOf(outcome)).toEqual({ running: [], attention: ["ses_eval"], lost: ["ses_eval"] })
  })

  test("status gives a genuine request precedence over loss, loss precedence over failure, and keeps lost disjoint from failed", async () => {
    const directory = process.cwd()
    const sessions = ["asked", "asked_lost_failed", "lost_failed", "failed", "lost"].map((id, index) => sessionInfo(`ses_${id}`, { updated: index + 1, directory }))
    const { local, registry, subscriptions } = await harness({ sessions, results: {
      permissionRequests: async () => [{ id: "per_1", sessionID: "ses_asked" }, { id: "per_2", sessionID: "ses_asked_lost_failed" }],
      formRequests: async () => [], guardrailRequestList: async () => [],
      outstandingSessions: { data: [], running: ["ses_asked", "ses_asked_lost_failed"], failed: ["ses_asked_lost_failed", "ses_lost_failed", "ses_failed"], lost: ["ses_asked_lost_failed", "ses_lost_failed", "ses_lost"] },
    } })
    const outcome = valueOf(await executeRemoteOperation({ request: request("session.status"), local, sessions: registry, subscriptions })) as { attention: string[]; failed?: string[]; lost?: string[] }
    expect(outcome.attention).toEqual(["ses_asked", "ses_asked_lost_failed", "ses_failed", "ses_lost", "ses_lost_failed"])
    expect(outcome.lost).toEqual(["ses_lost", "ses_lost_failed"])
    expect(outcome.failed).toEqual(["ses_failed"])
    expect(outcome.lost!.filter((id) => outcome.failed!.includes(id))).toEqual([])
    expect(outcome.lost!.every((id) => outcome.attention.includes(id))).toBe(true)
  })

  test("status omits lost when the only unresolved work is a request or a failure", async () => {
    const directory = process.cwd()
    const sessions = [sessionInfo("ses_asked", { updated: 1, directory }), sessionInfo("ses_failed", { updated: 2, directory })]
    const { local, registry, subscriptions } = await harness({ sessions, results: {
      permissionRequests: async () => [{ id: "per_1", sessionID: "ses_asked" }], formRequests: async () => [], guardrailRequestList: async () => [],
      outstandingSessions: { data: [], running: ["ses_asked"], failed: ["ses_failed"], lost: ["ses_asked"] },
    } })
    const outcome = valueOf(await executeRemoteOperation({ request: request("session.status"), local, sessions: registry, subscriptions }))
    expect(outcome).toEqual({ running: ["ses_asked"], attention: ["ses_asked", "ses_failed"], failed: ["ses_failed"] })
  })

  test("catalog and file finder read only the verified Location and project workspace", async () => {
    const directory = process.cwd()
    const session = sessionInfo("ses_1", { updated: 1, directory })
    const results: Partial<Record<keyof LocalServer, unknown>> = {
      projectList: [{ id: "prj_1", worktree: directory, name: "Project", time: { created: 1, updated: 1 }, sandboxes: [] }],
      projectDirectories: [],
      projectCurrent: { id: "prj_1", directory },
      agentList: [{ id: "build", name: "Builder", mode: "primary", hidden: false, description: "Build", model: { providerID: "test", id: "model" }, permissions: [], request: {} }],
      providerList: [{ id: "test", name: "Test", package: "test" }, { id: "off", name: "Off", disabled: true, package: "off" }],
      modelList: [{ providerID: "test", id: "model", name: "Model", enabled: false, variants: [{ id: "high" }, { id: "low" }], profiles: [
        { name: "work", active: true, variants: ["high"], credentialID: "private", daybreak: ["daybreak_blue"] },
        { name: "personal", active: false, variants: ["low"], credentialID: "other-private" },
      ] }, { providerID: "off", id: "hidden", name: "Hidden", enabled: true, variants: [] }],
      modelDefault: { selection: { providerID: "test", id: "model", variant: "high", profile: "work" } },
      commandList: [{ name: "test", template: "example", description: "Test" }],
      skillList: [{ id: "skill", name: "Skill", description: "Help", slash: true, content: "secret" }],
      referenceList: [{ name: "Readme", path: join(directory, "README.md"), source: { type: "file" } }],
      resourceCatalog: { resources: [{ name: "Docs", uri: "mcp://docs" }], templates: [] },
      fileFind: [{ path: "package.json", type: "file" }],
    }
    const { local, registry, subscriptions, calls } = await harness({ sessions: [session], results })
    const catalog = valueOf(await executeRemoteOperation({ request: request("session.catalog"), local, sessions: registry, subscriptions }))
    expect(catalog).toEqual({ agents: [{ id: "build", name: "Builder", mode: "primary", hidden: false, description: "Build", model: { providerID: "test", id: "model" } }],
      models: [{ providerID: "test", providerName: "Test", id: "model", name: "Model", variants: ["high", "low"], enabled: false, profiles: [
        { name: "work", active: true, variants: ["high"] }, { name: "personal", active: false, variants: ["low"] },
      ] }],
      defaultModel: { providerID: "test", id: "model", variant: "high", profile: "work" }, commands: [{ name: "test", description: "Test" }],
      skills: [{ id: "skill", name: "Skill", description: "Help", slash: true }],
      references: [{ name: "Readme", uri: pathToFileURL(join(directory, "README.md")).href }], resources: [{ name: "Docs", uri: "mcp://docs" }] })
    const workspace = recordOf(arrayOf(recordOf(valueOf(await executeRemoteOperation({ request: request("workspace.list"), local, sessions: registry, subscriptions }))).data)[0]).id
    expect(workspace).toBeDefined()
    const same = valueOf(await executeRemoteOperation({ request: request("workspace.catalog", { workspace }), local, sessions: registry, subscriptions }))
    expect(same).toEqual(catalog)
    const files = valueOf(await executeRemoteOperation({ request: request("session.file.find", { query: "package", limit: 1 }), local, sessions: registry, subscriptions }))
    expect(files).toEqual({ files: [{ path: "package.json", uri: pathToFileURL(join(directory, "package.json")).href, kind: "file" }] })
    expect(calls.filter((call) => call.method === "fileFind").at(-1)?.args).toEqual([{ directory }, "package", 1])
    expect(errorOf(await executeRemoteOperation({ request: request("workspace.catalog", { workspace: "wsp_missing" }), local, sessions: registry, subscriptions })).code).toBe("invalid_message")
  })

  test("fails a catalog read on a missing source instead of publishing partial or sensitive data", async () => {
    const results: Partial<Record<keyof LocalServer, unknown>> = {
      agentList: [], modelList: [], modelDefault: null, providerList: [{ id: "test", name: "Test" }], commandList: [], skillList: [],
      referenceList: [], resourceCatalog: { resources: [], templates: [] },
    }
    const test = await harness({ results })
    results.modelList = new LocalFailureClass("server", "Provider unavailable")
    expect(errorOf(await executeRemoteOperation({ request: request("session.catalog"), local: test.local,
      sessions: test.registry, subscriptions: test.subscriptions })).code).toBe("internal_error")
  })

  test("returns all 553 offered models without a count-based catalog rejection", async () => {
    const results: Partial<Record<keyof LocalServer, unknown>> = {
      agentList: [], modelList: Array.from({ length: 553 }, (_, index) => ({ providerID: "test", id: `model-${index}`, name: `Model ${index}`, enabled: true, variants: [] })),
      modelDefault: null, providerList: [{ id: "test", name: "Test" }],
      commandList: [], skillList: [], referenceList: [], resourceCatalog: { resources: [], templates: [] },
    }
    const test = await harness({ results })
    const catalog = valueOf(await executeRemoteOperation({ request: request("session.catalog"), local: test.local,
      sessions: test.registry, subscriptions: test.subscriptions })) as { models: unknown[] }
    expect(catalog.models).toHaveLength(553)
    results.modelList = [{ providerID: "test", id: "large", name: "x".repeat(RemoteLimits.maxAgentMessageChars * RemoteLimits.maxChunksPerResponse + 1), enabled: true, variants: [] }]
    expect(errorOf(await executeRemoteOperation({ request: request("session.catalog"), local: test.local,
      sessions: test.registry, subscriptions: test.subscriptions })).code).toBe("message_too_large")
  })

  test("switches model and agent, admits commands and skills, and passes explicit create choices", async () => {
    const { local, registry, subscriptions, calls } = await harness({ results: {
      switchModel: undefined, switchAgent: undefined, command: { id: "msg_command" }, skill: undefined,
    } })
    const invoke = (operation: RemoteRequest["operation"], payload: Record<string, unknown>) => executeRemoteOperation({ request: request(operation, payload), local, sessions: registry, subscriptions })
    expect(valueOf(await invoke("session.switchModel", { model: { providerID: "test", id: "model" } }))).toBeNull()
    expect(valueOf(await invoke("session.switchModel", { model: { providerID: "test", id: "model", profile: "work" } }))).toBeNull()
    expect(valueOf(await invoke("session.switchAgent", { agent: "build" }))).toBeNull()
    expect(valueOf(await invoke("session.command", { command: "test", arguments: "--x" }))).toEqual({ data: { id: "msg_command" } })
    expect(valueOf(await invoke("session.skill", { skill: "skill" }))).toBeNull()
    expect(calls.filter((call) => ["switchModel", "switchAgent", "command", "skill"].includes(call.method))).toEqual([
      { method: "switchModel", args: ["ses_1", { directory: "/work" }, { providerID: "test", id: "model" }] },
      { method: "switchModel", args: ["ses_1", { directory: "/work" }, { providerID: "test", id: "model", profile: "work" }] },
      { method: "switchAgent", args: ["ses_1", { directory: "/work" }, "build"] },
      { method: "command", args: ["ses_1", { directory: "/work" }, { command: "test", arguments: "--x" }] },
      { method: "skill", args: ["ses_1", { directory: "/work" }, { skill: "skill" }] },
    ])
  })

  test("refuses file attachments outside the real Session root before a mutation", async () => {
    const directory = process.cwd()
    const session = sessionInfo("ses_1", { updated: 1, directory })
    const { local, registry, subscriptions, calls } = await harness({ sessions: [session], results: {
      prompt: { id: "msg_1" }, command: { id: "msg_2" }, referenceList: [{ name: "Shared", path: "/shared/ref.md" }], resourceCatalog: { resources: [], templates: [] },
      agentList: [], modelList: [], modelDefault: null, providerList: [], commandList: [], skillList: [],
    } })
    const invoke = (operation: "session.prompt" | "session.command", uri: string) => executeRemoteOperation({
      request: request(operation, { ...(operation === "session.prompt" ? { text: "hi" } : { command: "test" }), files: [{ uri }] }),
      local, sessions: registry, subscriptions,
    })
    expect(valueOf(await invoke("session.prompt", pathToFileURL(join(directory, "package.json")).href))).toEqual({ data: { id: "msg_1" } })
    expect(valueOf(await invoke("session.command", "file:///shared/ref.md"))).toEqual({ data: { id: "msg_2" } })
    calls.length = 0
    expect(errorOf(await invoke("session.prompt", "file:///etc/passwd")).code).toBe("invalid_message")
    expect(calls.some((call) => call.method === "prompt")).toBe(false)
    for (const uri of ["https://example.com/a", "file:///etc/passwd", "file:///work/../etc/passwd", "mcp://unknown"])
      expect(errorOf(await invoke("session.command", uri)).code).toBe("invalid_message")
    expect(calls.filter((call) => call.method === "command")).toEqual([])
  })

  test("resolves prompt and command agent mentions at the verified Session Location before forwarding", async () => {
    const test = await harness({ results: {
      prompt: { id: "msg_1" }, command: { id: "msg_2" },
      agentList: [
        { id: "reviewer", name: "Reviewer", mode: "subagent", hidden: false },
        { id: "general", name: "General", mode: "all", hidden: false },
        { id: "private", name: "Private", mode: "subagent", hidden: true },
        { id: "lead", name: "Lead", mode: "primary", hidden: false },
        { id: "btw", name: "BTW", mode: "subagent", hidden: false },
      ],
    } })
    const invoke = (operation: "session.prompt" | "session.command", name: string) => executeRemoteOperation({
      request: request(operation, { ...(operation === "session.prompt" ? { text: `Ask @${name}` } : { command: "test" }), agents: [{ name }] }),
      local: test.local, sessions: test.registry, subscriptions: test.subscriptions,
    })
    for (const operation of ["session.prompt", "session.command"] as const) {
      for (const name of ["missing", "private", "lead", "btw"]) {
        test.calls.length = 0
        expect(errorOf(await invoke(operation, name)).code, `${operation} ${name}`).toBe("invalid_message")
        expect(test.calls.some((call) => call.method === "prompt" || call.method === "command")).toBe(false)
      }
      test.calls.length = 0
      expect(valueOf(await invoke(operation, "reviewer"))).toMatchObject({ data: { id: operation === "session.prompt" ? "msg_1" : "msg_2" } })
      expect(test.calls.find((call) => call.method === (operation === "session.prompt" ? "prompt" : "command"))?.args[2]).toMatchObject({ agents: [{ name: "reviewer" }] })
      expect(test.calls.find((call) => call.method === "agentList")?.args[0]).toEqual({ directory: "/work" })
    }
  })

  test("refuses a file URL whose symlink escapes the Session Location", async () => {
    const directory = await mkdtemp(join(scratch, "ycoding-attachment-"))
    try {
      await symlink("/etc/passwd", join(directory, "escape.txt"))
      const test = await harness({ sessions: [sessionInfo("ses_1", { updated: 1, directory })], results: { prompt: { id: "msg_1" },
        agentList: [], modelList: [], modelDefault: null, providerList: [], commandList: [], skillList: [], referenceList: [],
        resourceCatalog: { resources: [], templates: [] } } })
      const outcome = await executeRemoteOperation({ request: request("session.prompt", { text: "Read it", files: [{ uri: pathToFileURL(join(directory, "escape.txt")).href }] }),
        sessions: test.registry, subscriptions: test.subscriptions, local: test.local })
      expect(errorOf(outcome).code).toBe("invalid_message")
      expect(test.calls.some((call) => call.method === "prompt")).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  test("reads the bounded direct-child task page at the verified parent Location", async () => {
    const page = { data: [{ sessionID: "ses_child", parentID: "ses_1", state: "running", revision: 1 }], summary: { total: 1, active: 1, running: 1, waiting: 0 }, cursor: { next: "opaque" } }
    const { local, registry, subscriptions, calls } = await harness({ results: { subagentPage: async () => page } })
    const outcome = await executeRemoteOperation({ request: request("session.subagent.list", { cursor: "opaque" }), sessions: registry, subscriptions, local })
    expect(valueOf(outcome)).toEqual(page)
    expect(calls.at(-1)).toEqual({ method: "subagentPage", args: ["ses_1", { directory: "/work" }, "opaque"] })
    expect(calls.some((call) => call.method === "getSession")).toBe(true)

    calls.length = 0
    const missing = await executeRemoteOperation({ request: { ...request("session.subagent.list"), sessionID: "ses_missing" }, sessions: registry, subscriptions, local })
    expect(errorOf(missing).code).toBe("session_not_allowed")
    expect(calls.some((call) => call.method === "subagentPage")).toBe(false)
  })
  test("Team cancel and answer authorize a direct managed child before local mutation", async () => {
    const sessions = [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_child", { updated: 2, directory: "/child", parentID: "ses_root", agent: "general" }),
      sessionInfo("ses_foreign", { updated: 3, parentID: "ses_other", agent: "general" }), sessionInfo("ses_btw", { updated: 4, parentID: "ses_root", agent: "btw" })]
    const test = await harness({ sessions, results: {
      subagentCancel: async () => ({ sessionID: "ses_child", state: "cancelling" }),
      subagentAnswer: async () => ({ sessionID: "ses_child", state: "running" }),
    } })
    const run = (operation: RemoteRequest["operation"], input: Record<string, unknown>) => executeRemoteOperation({
      request: { ...request(operation, input), sessionID: "ses_root" }, sessions: test.registry, subscriptions: test.subscriptions, local: test.local,
    })
    expect(valueOf(await run("session.subagent.cancel", { childID: "ses_child" }))).toMatchObject({ data: { state: "cancelling" } })
    expect(valueOf(await run("session.subagent.answer", { childID: "ses_child", questionID: "qst_1", text: "staging" }))).toMatchObject({ data: { state: "running" } })
    expect(test.calls.filter((call) => call.method === "subagentCancel" || call.method === "subagentAnswer")).toEqual([
      { method: "subagentCancel", args: ["ses_root", "ses_child", { directory: "/work" }] },
      { method: "subagentAnswer", args: ["ses_root", "ses_child", "qst_1", "staging", { directory: "/work" }] },
    ])
    test.calls.length = 0
    for (const childID of ["ses_foreign", "ses_btw", "ses_missing"])
      expect(errorOf(await run("session.subagent.cancel", { childID })).code).toBe("forbidden")
    expect(test.calls.some((call) => call.method === "subagentCancel")).toBe(false)
  })

  test("remote pin operations require a verified direct managed child and use its Location", async () => {
    const sessions = [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_child", { updated: 2, directory: "/child", parentID: "ses_root", agent: "general" }),
      sessionInfo("ses_foreign", { updated: 3, parentID: "ses_other", agent: "general" }), sessionInfo("ses_btw", { updated: 4, parentID: "ses_root", agent: "btw" })]
    const test = await harness({ sessions })
    const run = (sessionID: string, operation: "session.pin" | "session.unpin") => executeRemoteOperation({
      request: { ...request(operation), sessionID }, sessions: test.registry, subscriptions: test.subscriptions, local: test.local,
    })
    expect(valueOf(await run("ses_child", "session.pin"))).toBeNull()
    expect(valueOf(await run("ses_child", "session.unpin"))).toBeNull()
    expect(test.calls.filter((call) => call.method === "pin" || call.method === "unpin")).toEqual([
      { method: "pin", args: ["ses_child", { directory: "/child" }] },
      { method: "unpin", args: ["ses_child", { directory: "/child" }] },
    ])
    for (const [sessionID, code] of [["ses_root", "forbidden"], ["ses_foreign", "session_not_allowed"], ["ses_btw", "forbidden"], ["ses_missing", "session_not_allowed"]] as const)
      expect(errorOf(await run(sessionID, "session.pin")).code).toBe(code)
    expect(test.calls.filter((call) => call.method === "pin" || call.method === "unpin")).toHaveLength(2)
  })

  test("Team shells expose only root-family owners and kill no foreign or ownerless shell", async () => {
    const sessions = [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_child", { updated: 2, parentID: "ses_root", agent: "general" }),
      sessionInfo("ses_foreign", { updated: 3 })]
    const shells = [
      { id: "sh_root", command: "bun test", status: "running", metadata: { sessionID: "ses_root" }, time: { started: 1 } },
      { id: "sh_child", command: "bun lint", status: "running", metadata: { sessionID: "ses_child" }, time: { started: 2 } },
      { id: "sh_foreign", command: "private", status: "running", metadata: { sessionID: "ses_foreign" }, time: { started: 3 } },
      { id: "sh_unknown", command: "unknown", status: "running", metadata: {}, time: { started: 4 } },
      { id: "sh_queued", command: "bun typecheck", status: "queued", queuePosition: 2, metadata: { sessionID: "ses_child" }, time: { started: 5 } },
    ]
    const test = await harness({ sessions, results: { shellList: async () => shells, shellGet: async (id: string) => shells.find((shell) => shell.id === id), shellRemove: async () => undefined } })
    const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>) => executeRemoteOperation({
      request: { ...request(operation, input), sessionID: "ses_root" }, sessions: test.registry, subscriptions: test.subscriptions, local: test.local,
    })
    expect(valueOf(await run("session.team.shell.list"))).toEqual({ truncated: false, data: [
      { id: "sh_root", ownerID: "ses_root", ownerTitle: "ses_root", command: "bun test", status: "running", startedAt: 1 },
      { id: "sh_child", ownerID: "ses_child", ownerAgent: "general", ownerTitle: "ses_child", command: "bun lint", status: "running", startedAt: 2 },
      { id: "sh_queued", ownerID: "ses_child", ownerAgent: "general", ownerTitle: "ses_child", command: "bun typecheck", status: "queued", queuePosition: 2, startedAt: 5 },
    ] })
    expect(valueOf(await run("session.team.shell.kill", { shellID: "sh_child" }))).toEqual(null)
    for (const shellID of ["sh_foreign", "sh_unknown"])
      expect(errorOf(await run("session.team.shell.kill", { shellID })).code).toBe("forbidden")
    expect(test.calls.filter((call) => call.method === "shellRemove")).toEqual([{ method: "shellRemove", args: ["sh_child", { directory: "/work" }] }])
  })
  test("Team shells preview descendant commands and read the complete command only for its owner", async () => {
    const sessions = [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_child", { updated: 2, parentID: "ses_root", agent: "general" }),
      sessionInfo("ses_grandchild", { updated: 3, parentID: "ses_child", agent: "reviewer", title: "Nested review" }),
      sessionInfo("ses_foreign_child", { updated: 4, parentID: "ses_foreign", agent: "general" }), sessionInfo("ses_foreign", { updated: 5 }),
      sessionInfo("ses_orphan", { updated: 6, parentID: "ses_gone", agent: "general" })]
    const command = `ycoding grep -rIl ${"pattern-".repeat(40)} packages | head -5`
    const shells = [
      { id: "sh_nested", command, status: "running", metadata: { sessionID: "ses_grandchild" }, time: { started: 7 } },
      { id: "sh_foreignnested", command: "private", status: "running", metadata: { sessionID: "ses_foreign_child" }, time: { started: 8 } },
      { id: "sh_orphan", command: "private", status: "running", metadata: { sessionID: "ses_orphan" }, time: { started: 9 } },
      { id: "sh_absent", command: "private", status: "running", metadata: { sessionID: "ses_absent" }, time: { started: 10 } },
    ]
    const test = await harness({ sessions, results: { shellList: async () => shells, shellGet: async (id: string) => shells.find((shell) => shell.id === id), shellRemove: async () => undefined,
      shellOutput: async () => ({ output: "page", cursor: 4, size: 4, truncated: false }) } })
    const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>) => executeRemoteOperation({
      request: { ...request(operation, input), sessionID: "ses_root" }, sessions: test.registry, subscriptions: test.subscriptions, local: test.local,
    })
    expect(command.length).toBeGreaterThan(256)
    expect(valueOf(await run("session.team.shell.list"))).toEqual({ truncated: false, data: [
      { id: "sh_nested", ownerID: "ses_grandchild", ownerAgent: "reviewer", ownerTitle: "Nested review", command: `${command.slice(0, 255)}…`, status: "running", startedAt: 7 },
    ] })
    expect(test.calls.some((call) => call.method === "shellOutput")).toBe(false)
    const read = (shellID: string) => executeRemoteOperation({ request: { ...request("session.shell.output", { shellID }), sessionID: "ses_grandchild" },
      sessions: test.registry, subscriptions: test.subscriptions, local: test.local })
    expect(valueOf(await read("sh_nested"))).toEqual({ command, status: "running", data: { output: "page", cursor: 4, size: 4, truncated: false } })
    for (const shellID of ["sh_foreignnested", "sh_orphan", "sh_absent"]) expect(errorOf(await read(shellID)).code).toBe("forbidden")
    expect(test.calls.filter((call) => call.method === "shellOutput")).toHaveLength(1)
    expect(valueOf(await run("session.team.shell.kill", { shellID: "sh_nested" }))).toEqual(null)
    for (const shellID of ["sh_foreignnested", "sh_orphan", "sh_absent"])
      expect(errorOf(await run("session.team.shell.kill", { shellID })).code).toBe("forbidden")
  })

  test("Team shells resolve a moved direct child's recorded Location instead of borrowing the root header", async () => {
    const sessions = [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_child", { updated: 2, parentID: "ses_root", agent: "general", directory: "/other-work" })]
    const test = await harness({ sessions, results: {
      shellList: async (location: LocalLocation) => location.directory === "/other-work" ? [{ id: "sh_moved", command: "bun test", status: "running", metadata: { sessionID: "ses_child" }, time: { started: 1 } }] : [],
      shellGet: async (id: string, location: LocalLocation) => location.directory === "/other-work" ? { id, metadata: { sessionID: "ses_child" } } : undefined,
      shellRemove: async () => undefined,
    } })
    const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>) => executeRemoteOperation({ request: { ...request(operation, input), sessionID: "ses_root" },
      sessions: test.registry, subscriptions: test.subscriptions, local: test.local })
    expect(valueOf(await run("session.team.shell.list"))).toMatchObject({ data: [{ id: "sh_moved" }] })
    expect(valueOf(await run("session.team.shell.kill", { shellID: "sh_moved" }))).toBeNull()
    expect(test.calls.filter((call) => call.method === "shellRemove")).toEqual([{ method: "shellRemove", args: ["sh_moved", { directory: "/other-work" }] }])
  })
  test("Team shell listing discloses its 50-row boundary rather than silently dropping family shells", async () => {
    const test = await harness({ results: { shellList: async () => Array.from({ length: 51 }, (_, index) => ({ id: `sh_${index}`, command: "sleep 10", status: "running", metadata: { sessionID: "ses_1" }, time: { started: 1 } })) } })
    const result = valueOf(await executeRemoteOperation({ request: request("session.team.shell.list"), sessions: test.registry, subscriptions: test.subscriptions, local: test.local }))
    expect(isRecord(result) && Array.isArray(result.data) && result.data.length === 50 && result.truncated === true).toBe(true)
  })

  test("Team shell previews preserve commands at the boundary and bound many heredocs to one frame", async () => {
    const commands = ["x".repeat(255), "x".repeat(256), "x".repeat(257), ...Array.from({ length: 47 }, () => `cat <<'EOF'\n${"\\\"\n".repeat(200_000)}\nEOF`)]
    const test = await harness({ results: { shellList: async () => commands.map((command, index) => ({ id: `sh_${index}`, command, status: "running", metadata: { sessionID: "ses_1" }, time: { started: 1 } })) } })
    const frames = await executeRemoteOperation({ request: request("session.team.shell.list"), sessions: test.registry, subscriptions: test.subscriptions, local: test.local })
    expect(frames).toHaveLength(1)
    expect(JSON.stringify(frames[0]).length).toBeLessThanOrEqual(RemoteLimits.maxAgentMessageChars)
    const result = valueOf(frames)
    if (!isRecord(result) || !Array.isArray(result.data)) throw new Error("Expected shell list")
    expect(result.truncated).toBe(false)
    expect(result.data).toHaveLength(50)
    expect(result.data.slice(0, 3).map((shell) => shell.command)).toEqual([commands[0], commands[1], `${"x".repeat(255)}…`])
    expect(result.data.every((shell) => shell.command.length <= 256)).toBe(true)
    expect(result.data[3].command.endsWith("…")).toBe(true)
  })

  test("Team shell listing bounds aggregate owner metadata and discloses omitted rows", async () => {
    const test = await harness({ sessions: [sessionInfo("ses_1", { updated: 1, title: "\\\"\n".repeat(25_000) })], results: {
      shellList: async () => Array.from({ length: 50 }, (_, index) => ({ id: `sh_${index}`, command: "bun test", status: "running", metadata: { sessionID: "ses_1" }, time: { started: 1 } })),
    } })
    const frames = await executeRemoteOperation({ request: request("session.team.shell.list"), sessions: test.registry, subscriptions: test.subscriptions, local: test.local })
    expect(frames).toHaveLength(1)
    expect(JSON.stringify(frames[0]).length).toBeLessThanOrEqual(RemoteLimits.maxAgentMessageChars)
    const result = valueOf(frames)
    if (!isRecord(result) || !Array.isArray(result.data)) throw new Error("Expected shell list")
    expect(result.truncated).toBe(true)
    expect(result.data.length).toBeGreaterThan(0)
    expect(result.data.length).toBeLessThan(50)
  })

  test("side chats page only BTW children and create one parent-linked BTW Session", async () => {
    const sessions = [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_btw", { updated: 2, parentID: "ses_root", agent: "btw" }),
      sessionInfo("ses_child", { updated: 3, parentID: "ses_root", agent: "general" })]
    const test = await harness({ sessions, results: {
      listChildren: async () => ({ data: sessions.slice(1), cursor: { next: "older" } }),
      createSideChat: async (id: string, rootID: string) => ({ ...sessionInfo(id, { updated: 4, parentID: rootID, agent: "btw" }) }),
    } })
    const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>) => executeRemoteOperation({
      request: { ...request(operation, input), sessionID: "ses_root" }, sessions: test.registry, subscriptions: test.subscriptions, local: test.local,
    })
    expect(valueOf(await run("session.side-chat.list", { cursor: "opaque" }))).toMatchObject({ data: [{ id: "ses_btw" }] })
    expect(valueOf(await run("session.side-chat.create", { id: "ses_btw_new" }))).toMatchObject({ data: { id: "ses_btw_new", parentID: "ses_root", agent: "btw" } })
    expect(test.calls.find((call) => call.method === "createSideChat")?.args).toEqual(["ses_btw_new", "ses_root", { directory: "/work" }])
  })

  test("Team economics reads a bounded verified page without leaking unrelated Sessions", async () => {
    const sessions = [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_child", { updated: 2, parentID: "ses_root", agent: "general" }),
      sessionInfo("ses_foreign", { updated: 3 })]
    const test = await harness({ sessions, results: { diagnostics: async () => ({ data: { cache: { hitRatio: 0.75, readReported: true, writeReported: false }, context: { total: 1_000, limit: 2_000 }, tokens: { cacheRead: 12, cacheWrite: 0 } } }) } })
    const run = (ids: string[]) => executeRemoteOperation({ request: { ...request("session.team.economics", { sessionIDs: ids }), sessionID: "ses_root" },
      sessions: test.registry, subscriptions: test.subscriptions, local: test.local })
    const reported = valueOf(await run(["ses_child"]))
    expect(reported).toMatchObject({ data: [{ sessionID: "ses_child", cost: 0, tokens: { cache: { read: 0 } }, cacheRead: 12, cacheHitRatio: 0.75, contextTotal: 1_000, contextLimit: 2_000 }] })
    expect(isRecord(reported) && Array.isArray(reported.data) && isRecord(reported.data[0]) && reported.data[0].cacheWrite === undefined).toBe(true)
    test.calls.length = 0
    expect(errorOf(await run(["ses_foreign"])).code).toBe("forbidden")
    expect(test.calls.some((call) => call.method === "diagnostics")).toBe(false)
  })
  test("managed subagents reject remote input and configuration but BTW children can prompt", async () => {
    const sessions = [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_child", { updated: 2, parentID: "ses_root", agent: "general" }), sessionInfo("ses_btw", { updated: 3, parentID: "ses_root", agent: "btw" })]
    const test = await harness({ sessions, results: { prompt: { id: "msg_1" }, interrupt: undefined } })
    const send = (operation: RemoteRequest["operation"], fields?: Readonly<Record<string, unknown>>, sessionID = "ses_child") => executeRemoteOperation({
      request: { ...request(operation, fields), sessionID }, local: test.local, sessions: test.registry, subscriptions: test.subscriptions,
    })
    for (const [operation, fields] of [
      ["session.prompt", { text: "Hello" }], ["session.command", { command: "test" }], ["session.skill", { skill: "review" }],
      ["session.compact", { id: "cmp_child" }],
      ["session.switchModel", { model: { providerID: "test", id: "model" } }], ["session.switchAgent", { agent: "general" }],
      ["session.autonomy.set", { yolo: 2 }], ["session.autonomy.set", { sleep: true }],
      ["session.autonomy.set", { autoAnswer: true }],
      ["session.goal.set", { goal: "Write code" }], ["session.goal.stop", { goal: null }],
    ] as const) expect(errorOf(await send(operation, fields)).code).toBe("subagent_read_only")
    expect(test.calls.some((call) => ["prompt", "command", "compact", "skill", "switchModel", "switchAgent", "autonomySet"].includes(call.method))).toBe(false)
    expect(valueOf(await send("session.get"))).toMatchObject({ data: { id: "ses_child" } })
    expect(valueOf(await send("session.interrupt"))).toBeNull()
    expect(valueOf(await send("session.prompt", { text: "Side chat" }, "ses_btw"))).toEqual({ data: { id: "msg_1" } })
  })
  test("reads own executing family activity and never snapshots idle members", async () => {
    const sessions = [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_read", { updated: 2, parentID: "ses_root" }), sessionInfo("ses_shell", { updated: 3, parentID: "ses_root" }), sessionInfo("ses_idle", { updated: 4, parentID: "ses_root" }), sessionInfo("ses_foreign", { updated: 5 })]
    const test = await harness({ sessions, results: {
      activeSessions: { ses_read: { type: "running" }, ses_shell: { type: "running" } },
      snapshot: async (id: string) => ({ messages: [{ id: "msg_1", type: "assistant", time: { created: 1 }, content: [
        { type: "tool", name: id === "ses_read" ? "read" : "shell", state: { status: "running", input: id === "ses_read" ? { path: "/work/src/store.ts" } : { command: "bun test ./src/remote" } } },
      ] }] }),
    } })
    const run = (sessionIDs: readonly string[]) => executeRemoteOperation({ request: { ...request("session.family.activity", { sessionIDs }), sessionID: "ses_root" }, local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
    const outcome = await run(["ses_read", "ses_shell", "ses_idle"])
    expect(valueOf(outcome)).toEqual({ data: [
      { sessionID: "ses_root", executing: false },
      { sessionID: "ses_read", executing: true, activity: { kind: "tool", room: "research", text: "Reading store.ts" } },
      { sessionID: "ses_shell", executing: true, activity: { kind: "tool", room: "qa", text: "Running bun test ./src/remote" } },
      { sessionID: "ses_idle", executing: false },
    ] })
    expect(test.calls.filter((call) => call.method === "snapshot").map((call) => call.args[0])).toEqual(["ses_read", "ses_shell"])
    expect(test.calls.filter((call) => call.method === "snapshot").every((call) => recordOf(call.args[1]).directory === "/work" && recordOf(call.args[2]).limit === 8)).toBe(true)
    test.calls.length = 0
    expect(errorOf(await run(["ses_foreign"])).code).toBe("session_not_allowed")
    expect(test.calls.some((call) => call.method === "snapshot")).toBe(false)
    expect(errorOf(await executeRemoteOperation({ request: { ...request("session.family.activity", { sessionIDs: [] }), sessionID: "ses_read" },
      local: test.local, sessions: test.registry, subscriptions: test.subscriptions })).code).toBe("session_not_allowed")
  })
  test("summarizes reasoning and editing without leaking raw inputs", async () => {
    const sessions = [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_think", { updated: 2, parentID: "ses_root" }), sessionInfo("ses_edit", { updated: 3, parentID: "ses_root" })]
    const test = await harness({ sessions, results: { activeSessions: { ses_think: { type: "running" }, ses_edit: { type: "running" } },
      snapshot: async (id: string) => ({ messages: [{ type: "assistant", time: { created: 1 }, content: id === "ses_think" ? [{ type: "reasoning", text: "private chain" }]
        : [{ type: "tool", name: "patch", state: { status: "running", input: { patchText: "*** Update File: src/usage.css\n+TOP_SECRET=" + "x".repeat(300) } } }] }] }),
    } })
    const output = valueOf(await executeRemoteOperation({ request: { ...request("session.family.activity", { sessionIDs: ["ses_think", "ses_edit"] }), sessionID: "ses_root" }, local: test.local, sessions: test.registry, subscriptions: test.subscriptions }))
    expect(output).toEqual({ data: [
      { sessionID: "ses_root", executing: false },
      { sessionID: "ses_think", executing: true, activity: { kind: "thinking", room: "hold", text: "Thinking" } },
      { sessionID: "ses_edit", executing: true, activity: { kind: "tool", room: "developer", text: "Editing usage.css" } },
    ] })
    expect(JSON.stringify(output)).not.toContain("TOP_SECRET")
  })
  test("bounds search and fetch subjects and never relays a URL path", async () => {
    const sessions = [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_search", { updated: 2, parentID: "ses_root" }), sessionInfo("ses_fetch", { updated: 3, parentID: "ses_root" })]
    const test = await harness({ sessions, results: { activeSessions: { ses_search: { type: "running" }, ses_fetch: { type: "running" } },
      snapshot: async (id: string) => ({ messages: [{ type: "assistant", time: { created: 1 }, content: [{ type: "tool", name: id === "ses_search" ? "websearch" : "webfetch", state: { status: "running",
        input: id === "ses_search" ? { query: "a".repeat(200) } : { url: "https://example.org/private/token" } } }] }] }),
    } })
    const output = valueOf(await executeRemoteOperation({ request: { ...request("session.family.activity", { sessionIDs: ["ses_search", "ses_fetch"] }), sessionID: "ses_root" }, local: test.local, sessions: test.registry, subscriptions: test.subscriptions }))
    expect(output).toMatchObject({ data: [
      { sessionID: "ses_root", executing: false },
      { sessionID: "ses_search", activity: { room: "research" } },
      { sessionID: "ses_fetch", activity: { text: "Fetching example.org" } },
    ] })
    const text = recordOf(recordOf(arrayOf(recordOf(output).data)[1]).activity).text
    expect(typeof text).toBe("string")
    expect(Array.from(String(text)).length).toBeLessThanOrEqual(80)
    expect(JSON.stringify(output)).not.toContain("private/token")
  })
  test("redacts credential-shaped search subjects rather than forwarding tool input", async () => {
    const test = await harness({ sessions: [sessionInfo("ses_root", { updated: 1 }), sessionInfo("ses_child", { updated: 2, parentID: "ses_root" })], results: {
      activeSessions: { ses_child: { type: "running" } },
      snapshot: { messages: [{ type: "assistant", time: { created: 1 }, content: [{ type: "tool", name: "websearch", state: { status: "running", input: { query: "api_key=sk-sensitive-value" } } }] }] },
    } })
    const output = valueOf(await executeRemoteOperation({ request: { ...request("session.family.activity", { sessionIDs: ["ses_child"] }), sessionID: "ses_root" },
      local: test.local, sessions: test.registry, subscriptions: test.subscriptions }))
    expect(output).toMatchObject({ data: [{ sessionID: "ses_root", executing: false }, { sessionID: "ses_child", activity: { text: "Searching" } }] })
    expect(JSON.stringify(output)).not.toContain("sensitive-value")
  })
  test("maps each mutation onto its exact Protocol call and payload", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      results: {
        prompt: async () => ({ id: "msg_1" }),
        interrupt: async () => undefined,
        permissionReply: async () => undefined,
        guardrailReply: async () => undefined,
        formList: async () => [formInfo("frm_1", "ses_1"), formInfo("frm_2", "ses_1")],
        formReply: async () => undefined,
        formCancel: async () => undefined,
        autonomySet: async () => ({ mode: "yolo" }),
        guardrailRequestList: async () => [{ id: "grq_1", sessionID: "ses_1", rootSessionID: "ses_1" }],
        agentList: [{ id: "build", name: "Build", mode: "subagent", hidden: false }], modelList: [], modelDefault: null, providerList: [], commandList: [], skillList: [], referenceList: [],
        resourceCatalog: { resources: [{ name: "Accepted", uri: "mcp://accepted" }], templates: [] },
      },
    })

    const prompt = await executeRemoteOperation({
      request: request("session.prompt", {
        id: "msg_1",
        text: "hello",
        files: [{ uri: "mcp://accepted", name: "a.ts" }],
        agents: [{ name: "build" }],
        delivery: "queue",
        resume: false,
      }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(prompt)).toEqual({ data: { id: "msg_1" } })
    expect(calls.at(-1)).toEqual({
      method: "prompt",
      args: [
        "ses_1",
        { directory: "/work" },
        {
          id: "msg_1",
          text: "hello",
          files: [{ uri: "mcp://accepted", name: "a.ts" }],
          agents: [{ name: "build" }],
          delivery: "queue",
          resume: false,
        },
      ],
    })

    await executeRemoteOperation({ request: request("session.interrupt"), sessions: registry, subscriptions, local })
    expect(calls.at(-1)).toEqual({ method: "interrupt", args: ["ses_1", { directory: "/work" }] })

    await executeRemoteOperation({
      request: request("session.permission.reply", { requestID: "per_1", reply: "always", message: "ok" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "permissionReply", args: ["ses_1", { directory: "/work" }, "per_1", "always", "ok"] })

    await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_1", reply: "once" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "guardrailReply", args: ["ses_1", { directory: "/work" }, "grq_1", "once"] })

    await executeRemoteOperation({
      request: request("session.form.reply", { formID: "frm_1", answer: { choice: ["yes"], approved: true } }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({
      method: "formReply",
      args: ["ses_1", { directory: "/work" }, "frm_1", { choice: ["yes"], approved: true }],
    })

    await executeRemoteOperation({
      request: request("session.form.cancel", { formID: "frm_2" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "formCancel", args: ["ses_1", { directory: "/work" }, "frm_2"] })

    await executeRemoteOperation({
      request: request("session.autonomy.set", { yolo: 2, maxNoProgress: 2 }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({
      method: "autonomySet",
      args: ["ses_1", { directory: "/work" }, { yolo: 2, maxNoProgress: 2 }],
    })

    for (const payload of [{ sleep: true }, { sleep: false }, { autoAnswer: true }, { autoAnswer: false }]) {
      await executeRemoteOperation({ request: request("session.autonomy.set", payload), sessions: registry, subscriptions, local })
      expect(calls.at(-1)).toEqual({ method: "autonomySet", args: ["ses_1", { directory: "/work" }, payload] })
    }

    for (const payload of [{ guardrailDecision: true }, { guardrailDecision: false, sleep: true },
      { yolo: 3 }, { autoAnswer: "true" }, { autoAnswer: null }, { autoAnswer: true, yolo: 1 },
      { autoAnswer: false, sleep: false }, { autoAnswer: true, maxNoProgress: 2 }]) {
      const before = calls.length
      expect(errorOf(await executeRemoteOperation({ request: request("session.autonomy.set", payload), sessions: registry, subscriptions, local })).code).toBe("invalid_message")
      expect(calls.length).toBe(before)
    }

    await executeRemoteOperation({
      request: request("session.goal.set", { goal: "ship it" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({
      method: "autonomySet",
      args: ["ses_1", { directory: "/work" }, { goal: "ship it" }],
    })

    await executeRemoteOperation({
      request: request("session.goal.stop", {}),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "autonomySet", args: ["ses_1", { directory: "/work" }, { goal: null }] })
  })

  test("forwards session.prediction at the verified Location and rejects invalid memory", async () => {
    const moved = sessionInfo("ses_1", { updated: 1, directory: "/work/moved" })
    const suggested = { status: "suggested", text: "Run the focused tests" }
    const { local, registry, subscriptions, calls } = await harness({
      sessions: [moved],
      results: {
        getSession: async () => moved,
        listPage: async () => ({ data: [moved] }),
        prediction: async () => suggested,
      },
    })
    const forwarded = await executeRemoteOperation({
      request: request("session.prediction", {
        memory: ["knowledge", "repository"],
        hint: "relay",
      }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(forwarded)).toEqual(suggested)
    expect(calls.at(-1)).toEqual({
      method: "prediction",
      args: ["ses_1", { directory: "/work/moved" }, { memory: ["knowledge", "repository"], hint: "relay" }],
    })

    const unavailable = await harness({
      sessions: [moved],
      results: { getSession: async () => moved, prediction: async () => ({ status: "unavailable" }) },
    })
    expect(valueOf(await executeRemoteOperation({
      request: request("session.prediction", { memory: ["repository"] }),
      sessions: unavailable.registry,
      subscriptions: unavailable.subscriptions,
      local: unavailable.local,
    }))).toEqual({ status: "unavailable" })
    expect(unavailable.calls.at(-1)).toEqual({
      method: "prediction",
      args: ["ses_1", { directory: "/work/moved" }, { memory: ["repository"] }],
    })

    calls.length = 0
    for (const input of [
      { memory: ["repository", "repository"] },
      { memory: ["nope"] },
      { memory: ["repository", "knowledge", "repository"] },
      { memory: "repository" },
      { hint: "only" },
      { memory: ["repository"], hint: "x".repeat(2_001) },
      { memory: ["repository"], directory: "/tmp" },
    ]) {
      expect(errorOf(await executeRemoteOperation({
        request: request("session.prediction", input),
        sessions: registry,
        subscriptions,
        local,
      })).code).toBe("invalid_message")
    }
    expect(calls.filter((call) => call.method === "prediction")).toEqual([])
  })

  test("forwards session.promptGenerate at the verified Location and rejects invalid input", async () => {
    const moved = sessionInfo("ses_1", { updated: 1, directory: "/work/moved" })
    const generated = { status: "generated", text: "Fix the build and verify it." }
    const { local, registry, subscriptions, calls } = await harness({
      sessions: [moved],
      results: {
        getSession: async () => moved,
        listPage: async () => ({ data: [moved] }),
        promptGenerate: async () => generated,
      },
    })
    const forwarded = await executeRemoteOperation({
      request: request("session.promptGenerate", {
        mode: "steer",
        intent: "Cover the regression",
        memory: ["knowledge", "repository"],
      }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(forwarded)).toEqual(generated)
    expect(calls.at(-1)).toEqual({
      method: "promptGenerate",
      args: ["ses_1", { directory: "/work/moved" }, { mode: "steer", intent: "Cover the regression", memory: ["knowledge", "repository"] }],
    })

    const unavailable = await harness({
      sessions: [moved],
      results: { getSession: async () => moved, promptGenerate: async () => ({ status: "unavailable" }) },
    })
    expect(valueOf(await executeRemoteOperation({
      request: request("session.promptGenerate", { mode: "goal", intent: "Ship it", memory: [] }),
      sessions: unavailable.registry,
      subscriptions: unavailable.subscriptions,
      local: unavailable.local,
    }))).toEqual({ status: "unavailable" })

    calls.length = 0
    for (const input of [
      { mode: "start", intent: "Open", memory: ["repository", "repository"] },
      { mode: "later", intent: "Open", memory: [] },
      { mode: "start", intent: "   ", memory: [] },
      { mode: "start", intent: "x".repeat(4_001), memory: [] },
      { mode: "start", intent: "Open", memory: [], directory: "/tmp" },
      { intent: "Open", memory: [] },
    ]) {
      expect(errorOf(await executeRemoteOperation({
        request: request("session.promptGenerate", input),
        sessions: registry,
        subscriptions,
        local,
      })).code).toBe("invalid_message")
    }
    expect(calls.filter((call) => call.method === "promptGenerate")).toEqual([])
  })

  test("returns each read body verbatim and validates subscriptions without owning relay state", async () => {
    const snapshot = { sourceEpoch: "epoch_1", session: sessionInfo("ses_1", { updated: 1 }), messages: [], watermark: { seq: 4 } }
    const { local, registry, subscriptions, calls } = await harness({
      results: {
        snapshot: async () => snapshot,
        todoList: async () => [{ content: "Run tests", status: "in_progress", priority: "high" }],
        messages: async () => [{ id: "msg_1" }],
        log: async () => [{ id: "evt_1" }],
        autonomyGet: async () => ({ mode: "normal" }),
        permissionList: async () => [{ id: "per_1", sessionID: "ses_1" }],
        guardrailStatus: async () => ({ profile: "standard" }),
        guardrailRequestList: async () => [],
        formList: async () => [formInfo("frm_1", "ses_1")],
      },
    })

    expect(valueOf(await executeRemoteOperation({ request: request("session.snapshot"), sessions: registry, subscriptions, local }))).toEqual(snapshot)
    expect(valueOf(await executeRemoteOperation({ request: request("session.todo.list"), sessions: registry, subscriptions, local }))).toEqual({ data: [{ content: "Run tests", status: "in_progress", priority: "high" }] })
    expect(calls.at(-1)).toEqual({ method: "todoList", args: ["ses_1", { directory: "/work" }] })
    expect(valueOf(await executeRemoteOperation({ request: request("session.messages"), sessions: registry, subscriptions, local }))).toEqual({ data: [{ id: "msg_1" }] })
    expect(valueOf(await executeRemoteOperation({ request: request("session.log", { after: 4 }), sessions: registry, subscriptions, local }))).toEqual({ data: [{ id: "evt_1" }] })
    expect(valueOf(await executeRemoteOperation({ request: request("session.autonomy.get"), sessions: registry, subscriptions, local }))).toEqual({ data: { mode: "normal" } })
    expect(valueOf(await executeRemoteOperation({ request: request("session.permission.list"), sessions: registry, subscriptions, local }))).toEqual({ data: [{ id: "per_1", sessionID: "ses_1" }] })
    expect(valueOf(await executeRemoteOperation({ request: request("session.guardrail.status"), sessions: registry, subscriptions, local }))).toEqual({ data: { profile: "standard" } })
    expect(valueOf(await executeRemoteOperation({ request: request("session.form.list", {}), sessions: registry, subscriptions, local }))).toEqual([formInfo("frm_1", "ses_1")])
    expect(calls.filter((call) => call.method === "log").at(-1)).toEqual({ method: "log", args: ["ses_1", { directory: "/work" }, 4] })

    const before = calls.filter((call) => call.method !== "getSession").length
    expect(valueOf(await executeRemoteOperation({ request: request("session.subscribe"), sessions: registry, subscriptions, local }))).toBeNull()
    expect(valueOf(await executeRemoteOperation({ request: request("session.subscribe"), sessions: registry, subscriptions, local }))).toBeNull()
    expect(valueOf(await executeRemoteOperation({ request: request("session.unsubscribe"), sessions: registry, subscriptions, local }))).toBeNull()
    expect(calls.filter((call) => call.method !== "getSession").slice(before)).toEqual([])
    expect(subscriptions.count("ses_1")).toBe(0)
    expect(subscriptions.has("ses_1")).toBe(false)
    expect(valueOf(await executeRemoteOperation({ request: request("session.unsubscribe"), sessions: registry, subscriptions, local }))).toBeNull()
    expect(subscriptions.has("ses_1")).toBe(false)
  })

  test("maps every shared read operation the relay advertises", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      // `session.get` is served by the verification read itself, so the default
      // session info stands in for it.
      results: Object.fromEntries(
        readOperations
          .filter((operation) => operation !== "session.get")
          .map((operation) => [readMethod(operation), async () => []]),
      ),
    })
    for (const operation of readOperations) {
      const outcome = await executeRemoteOperation({
        request: operation === "session.log" ? request(operation, { after: 0 }) : request(operation),
        sessions: registry,
        subscriptions,
        local,
      })
      expect({ operation, frame: outcome[0] }).toMatchObject({ operation, frame: { ok: true } })
    }
    // `session.get` itself is the verification read, so it is counted below.
    expect(calls.filter((call) => call.method !== "getSession" && call.method !== "listPage").map((call) => call.method)).toEqual(
      readOperations.map(readMethod).filter((method) => method !== "getSession"),
    )
    // Every session-scoped read resolves and verifies its current backend Location.
    const scoped = readOperations.filter(requireSession)
    expect(calls.filter((call) => call.method === "getSession")).toHaveLength(scoped.length)
  })

  test("reports running status for shared sessions only", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      sessions: [sessionInfo("ses_1", { updated: 1 })],
      results: {
        activeSessions: async () => ({ ses_1: { type: "running" }, ses_hidden: { type: "running" } }),
      },
    })
    const outcome = await executeRemoteOperation({
      request: request("session.active"),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(outcome)).toEqual({ data: { ses_1: { type: "running" } } })
    expect(calls.filter((call) => call.method === "activeSessions")).toHaveLength(1)
    expect(calls.filter((call) => call.method === "listPage")).toEqual([])

    const rejected = await executeRemoteOperation({
      request: request("session.active", { sessionID: "ses_1" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(rejected).code).toBe("invalid_message")
  })

  test("follows the backend's authoritative current Location after a Session moves", async () => {
    const moved = sessionInfo("ses_1", { updated: 1, directory: "/work/moved" })
    const results: Partial<Record<keyof LocalServer, unknown>> = {
      getSession: async () => moved,
      listPage: async () => ({ data: [moved] }),
      messages: async () => [{ id: "msg_1" }],
    }
    const { local, calls } = fakeLocal(results)
    const registry = createSessionRegistry({
      local,
    })
    await registry.refresh()
    calls.length = 0

    const outcome = await executeRemoteOperation({
      request: request("session.messages"),
      sessions: registry,
      subscriptions: createSubscriptions(),
      local,
    })
    expect(valueOf(outcome)).toEqual({ data: [{ id: "msg_1" }] })
    expect(calls.at(-1)).toEqual({ method: "messages", args: ["ses_1", { directory: "/work/moved" }] })
  })
})

function readMethod(operation: (typeof readOperations)[number]) {
  const method: Record<(typeof readOperations)[number], keyof LocalServer> = {
    "session.get": "getSession",
    "session.messages": "messages",
    "session.compaction.list": "compactionList",
    "session.snapshot": "snapshot",
    "session.pending.list": "pendingList",
    "session.todo.list": "todoList",
    "session.active": "activeSessions",
    "session.log": "log",
    "session.autonomy.get": "autonomyGet",
    "session.permission.list": "permissionList",
    "session.guardrail.status": "guardrailStatus",
    "session.guardrail.request.list": "guardrailRequestList",
    "session.form.list": "formList",
  }
  return method[operation]
}

describe("native Form ownership", () => {
  test("replies to and cancels only pending forms owned by the addressed Session", async () => {
    const pending = [
      formInfo("frm_owned", "ses_1"),
      formInfo("frm_cross", "ses_other"),
      formInfo("frm_global", "global"),
    ]
    const { local, registry, subscriptions, calls } = await harness({
      results: {
        formList: async () => pending,
        formReply: async () => undefined,
        formCancel: async () => undefined,
      },
    })

    const replied = await executeRemoteOperation({
      request: request("session.form.reply", { formID: "frm_owned", answer: { approved: true } }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(replied)).toBeNull()
    expect(calls.at(-1)).toEqual({
      method: "formReply",
      args: ["ses_1", { directory: "/work" }, "frm_owned", { approved: true }],
    })

    for (const formID of ["frm_cross", "frm_global", "frm_unknown"]) {
      const before = calls.filter((call) => call.method === "formReply" || call.method === "formCancel").length
      const refused = await executeRemoteOperation({
        request: request("session.form.cancel", { formID }),
        sessions: registry,
        subscriptions,
        local,
      })
      expect(errorOf(refused).code).toBe("invalid_message")
      expect(calls.filter((call) => call.method === "formReply" || call.method === "formCancel")).toHaveLength(before)
    }
  })
})

describe("family-wide guardrail reviews", () => {
  test("keeps reviews for every backend Session and preserves explicit replies", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      results: {
        guardrailRequestList: async () => ({
          data: [
            { id: "grq_mine", sessionID: "ses_1", rootSessionID: "ses_1" },
            { id: "grq_sibling", sessionID: "ses_child", rootSessionID: "ses_1" },
          ],
        }),
        guardrailReply: async () => undefined,
      },
    })
    const listed = await executeRemoteOperation({
      request: request("session.guardrail.request.list"),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(listed)).toEqual({
      data: [
        { id: "grq_mine", sessionID: "ses_1", rootSessionID: "ses_1" },
        { id: "grq_sibling", sessionID: "ses_child", rootSessionID: "ses_1" },
      ],
    })

    const sibling = await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_sibling", reply: "once" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(sibling)).toBeNull()
    expect(calls.some((call) => call.method === "guardrailReply")).toBe(true)

    const allowed = await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_mine", reply: "once" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(allowed)).toBeNull()
    expect(calls.at(-1)).toEqual({ method: "guardrailReply", args: ["ses_1", { directory: "/work" }, "grq_mine", "once"] })
  })

  test("refuses an unknown review and allows a granted child addressed through the root", async () => {
    const infos = [sessionInfo("ses_1", { updated: 1 }), sessionInfo("ses_child", { updated: 1, parentID: "ses_1" })]
    const { local, registry, subscriptions, calls } = await harness({
      sessions: infos,
      results: {
        getSession: async (sessionID: string) => infos.find((info) => info.id === sessionID),
        guardrailRequestList: async () => [{ id: "grq_child", sessionID: "ses_child", rootSessionID: "ses_1" }],
        guardrailReply: async () => undefined,
      },
    })
    await registry.refresh()

    const unknown = await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_missing", reply: "reject" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(unknown).code).toBe("invalid_message")

    const throughRoot = await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_child", reply: "reject" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(throughRoot)).toBeNull()
    expect(calls.at(-1)).toEqual({
      method: "guardrailReply",
      args: ["ses_1", { directory: "/work" }, "grq_child", "reject"],
    })
  })
})

describe("session review box", () => {
  const base = { sessionID: "ses_child", rootSessionID: "ses_1", sessionTitle: "Child", created: 1, reason: "escalated", origin: { requestID: "grq_1" } }
  const items = [
    { ...base, itemID: "rvw_hard", kind: "guardrail", payload: { type: "guardrail", action: "shell", resources: ["rm -rf build"], ruleIDs: ["standard.hard.delete"], reason: "delete", hardReview: true, directories: [], fingerprint: "a".repeat(64), requestID: "grq_1" } },
    { ...base, itemID: "rvw_question", kind: "question", reason: "free_text", origin: { messageID: "msg_1", callID: "call_1" }, payload: { type: "form", title: "Scope", fields: [{ key: "q0", type: "string" }], questionTool: true } },
    { ...base, itemID: "rvw_child", kind: "subagent_question", reason: "low_confidence", confidence: 0.4, origin: { questionID: "qst_1" }, payload: { type: "subagent_question", text: "Which branch?" } },
    { ...base, itemID: "rvw_permission", kind: "permission", reason: "sleep_entry", origin: { requestID: "per_1" }, payload: { type: "permission", action: "edit", resources: ["src/a.ts"], fingerprint: "b".repeat(64), requestID: "per_1" } },
  ]
  const reviewHarness = () => harness({
    sessions: [sessionInfo("ses_1", { updated: 1 }), sessionInfo("ses_child", { updated: 1, parentID: "ses_1", agent: "general" })],
    results: { reviewList: async () => items, reviewDecide: async () => undefined },
  })
  const run = (test: Awaited<ReturnType<typeof reviewHarness>>, operation: RemoteRequest["operation"], input?: Record<string, unknown>, sessionID = "ses_1") =>
    executeRemoteOperation({ request: { ...request(operation, input), sessionID }, local: test.local, sessions: test.registry, subscriptions: test.subscriptions })

  test("lists the family's open items at the verified Location the backend resolves", async () => {
    const test = await reviewHarness()
    expect(valueOf(await run(test, "session.review.list"))).toEqual({ data: items })
    expect(test.calls.at(-1)).toEqual({ method: "reviewList", args: ["ses_1", { directory: "/work" }] })
    expect(valueOf(await run(test, "session.review.list", undefined, "ses_child"))).toEqual({ data: items })
    expect(errorOf(await run(test, "session.review.list", { itemID: "rvw_hard" })).code).toBe("invalid_message")
  })

  test("forwards each decision shape after confirming the item is open in the addressed family with that kind", async () => {
    const test = await reviewHarness()
    for (const [itemID, decision] of [
      ["rvw_hard", { kind: "guardrail", reply: "once" }],
      ["rvw_hard", { kind: "guardrail", reply: "reject" }],
      ["rvw_question", { kind: "question", answers: { q0: "main" } }],
      ["rvw_question", { kind: "question", answers: [["main"], []] }],
      ["rvw_question", { kind: "question", dismissed: true }],
      ["rvw_child", { kind: "subagent_question", text: "Use main", data: { branch: "main" } }],
      ["rvw_child", { kind: "subagent_question", dismissed: true }],
      ["rvw_permission", { kind: "permission", reply: "always" }],
    ] as const) {
      test.calls.length = 0
      expect(valueOf(await run(test, "session.review.decide", { itemID, decision }))).toBeNull()
      expect(test.calls.map((call) => call.method).filter((method) => method.startsWith("review"))).toEqual(["reviewList", "reviewDecide"])
      expect(test.calls.at(-1)).toEqual({ method: "reviewDecide", args: ["ses_1", { directory: "/work" }, itemID, decision] })
    }
  })

  test("refuses malformed, mismatched, unknown, and hard Always decisions before deciding", async () => {
    const test = await reviewHarness()
    for (const [input, listed] of [
      [{ itemID: "rvw_hard", decision: { kind: "guardrail", reply: "always" } }, true],
      [{ itemID: "rvw_question", decision: { kind: "guardrail", reply: "once" } }, true],
      [{ itemID: "rvw_missing", decision: { kind: "guardrail", reply: "once" } }, true],
      [{ itemID: "grq_1", decision: { kind: "guardrail", reply: "once" } }, false],
      [{ itemID: "rvw_hard", decision: { kind: "guardrail", reply: "maybe" } }, false],
      [{ itemID: "rvw_hard", decision: { kind: "guardrail", dismissed: true } }, false],
      [{ itemID: "rvw_hard", decision: { kind: "guardrail", reply: "once", text: "x" } }, false],
      [{ itemID: "rvw_question", decision: { kind: "question", answers: [[1]] } }, false],
      [{ itemID: "rvw_question", decision: { kind: "question", answers: { q0: { nested: true } } } }, false],
      [{ itemID: "rvw_question", decision: { kind: "question", dismissed: false } }, false],
      [{ itemID: "rvw_child", decision: { kind: "subagent_question", text: "" } }, false],
      [{ itemID: "rvw_child", decision: { kind: "subagent_question", text: "x", data: "y".repeat(9_000) } }, false],
      [{ itemID: "rvw_child", decision: { kind: "unknown" } }, false],
      [{ itemID: "rvw_child", decision: "dismiss" }, false],
      [{ itemID: "rvw_child" }, false],
      [{ itemID: "rvw_child", decision: { kind: "subagent_question", dismissed: true }, origin: "browser" }, false],
    ] as const) {
      test.calls.length = 0
      expect(errorOf(await run(test, "session.review.decide", input)).code).toBe("invalid_message")
      expect(test.calls.map((call) => call.method).filter((method) => method.startsWith("review"))).toEqual(listed ? ["reviewList"] : [])
    }
  })

  const recoveryItem = { ...base, itemID: "rvw_recovery", kind: "recovery", reason: "restart", origin: { messageID: "msg_1", callID: "call_1" },
    payload: { type: "recovery", tools: [{ messageID: "msg_1", callID: "call_1", name: "shell" }, { messageID: "msg_1", callID: "call_2", name: "edit" }] } }
  const stoppedPage = (tasks: readonly { sessionID: string; parentID: string; itemID?: string }[], next?: string) => ({
    data: tasks.map((task) => ({ sessionID: task.sessionID, parentID: task.parentID, state: "cancelled", revision: 2, ...(task.itemID === undefined ? {} : { stoppedRecovery: { itemID: task.itemID } }) })),
    summary: { total: tasks.length, active: 0, running: 0, waiting: 0 }, cursor: next === undefined ? {} : { next },
  })
  const familyPages: Record<string, unknown> = {
    ses_1: stoppedPage([{ sessionID: "ses_child", parentID: "ses_1", itemID: "rvw_stopped" }, { sessionID: "ses_sibling", parentID: "ses_1", itemID: "rvw_sibling" }, { sessionID: "ses_running", parentID: "ses_1" }]),
    ses_child: stoppedPage([{ sessionID: "ses_grand", parentID: "ses_child", itemID: "rvw_nested" }]),
    ses_other: stoppedPage([{ sessionID: "ses_foreign_child", parentID: "ses_other", itemID: "rvw_foreign" }]),
  }
  const recoveryHarness = (results: Record<string, unknown> = {}) => harness({
    sessions: [sessionInfo("ses_1", { updated: 1 }), sessionInfo("ses_child", { updated: 1, parentID: "ses_1", agent: "general" }),
      sessionInfo("ses_sibling", { updated: 1, parentID: "ses_1", agent: "general" }), sessionInfo("ses_running", { updated: 1, parentID: "ses_1", agent: "general" }),
      sessionInfo("ses_grand", { updated: 1, parentID: "ses_child", agent: "general" }), sessionInfo("ses_btw", { updated: 1, parentID: "ses_1", agent: "btw" }),
      sessionInfo("ses_other", { updated: 1 }), sessionInfo("ses_foreign_child", { updated: 1, parentID: "ses_other", agent: "general" })],
    results: { reviewList: async () => [...items, recoveryItem], reviewDecide: async () => undefined, subagentPage: async (parentID: string) => familyPages[parentID], ...results },
  })
  const continueStopped = (test: Awaited<ReturnType<typeof recoveryHarness>>, itemID: string, sessionID: string) =>
    run(test, "session.review.decide", { itemID, decision: { kind: "recovery", choice: "continue" } }, sessionID)

  test("forwards Continue and Stop for an open restart recovery item as human decisions of that kind", async () => {
    const test = await recoveryHarness()
    for (const choice of ["continue", "stop"] as const) {
      test.calls.length = 0
      const decision = { kind: "recovery", choice }
      expect(valueOf(await run(test, "session.review.decide", { itemID: "rvw_recovery", decision }))).toBeNull()
      expect(test.calls.map((call) => call.method).filter((method) => method.startsWith("review"))).toEqual(["reviewList", "reviewDecide"])
      expect(test.calls.at(-1)).toEqual({ method: "reviewDecide", args: ["ses_1", { directory: "/work" }, "rvw_recovery", decision] })
    }
  })

  test("forwards a human Continue for a stopped recovery that is no longer open, but never a Stop", async () => {
    const test = await recoveryHarness()
    expect(valueOf(await continueStopped(test, "rvw_stopped", "ses_child"))).toBeNull()
    expect(test.calls.at(-1)).toEqual({ method: "reviewDecide", args: ["ses_child", { directory: "/work" }, "rvw_stopped", { kind: "recovery", choice: "continue" }] })
    test.calls.length = 0
    expect(errorOf(await run(test, "session.review.decide", { itemID: "rvw_stopped", decision: { kind: "recovery", choice: "stop" } }, "ses_child")).code).toBe("invalid_message")
    expect(test.calls.map((call) => call.method)).not.toContain("reviewDecide")
  })

  test("refuses recovery decisions that are dismissed, malformed, or addressed to another item kind", async () => {
    const test = await recoveryHarness()
    for (const [input, decided] of [
      [{ itemID: "rvw_recovery", decision: { kind: "recovery", dismissed: true } }, false],
      [{ itemID: "rvw_recovery", decision: { kind: "recovery" } }, false],
      [{ itemID: "rvw_recovery", decision: { kind: "recovery", choice: "retry" } }, false],
      [{ itemID: "rvw_recovery", decision: { kind: "recovery", choice: "continue", text: "go" } }, false],
      [{ itemID: "rvw_recovery", decision: { kind: "recovery", choice: "continue", reply: "once" } }, false],
      [{ itemID: "rvw_recovery", decision: { kind: "guardrail", reply: "once" } }, false],
      [{ itemID: "rvw_hard", decision: { kind: "recovery", choice: "continue" } }, false],
      [{ itemID: "rvw_child", decision: { kind: "recovery", choice: "stop" } }, false],
      [{ itemID: "not-a-review", decision: { kind: "recovery", choice: "continue" } }, false],
    ] as const) {
      test.calls.length = 0
      expect(errorOf(await run(test, "session.review.decide", input)).code).toBe("invalid_message")
      expect(test.calls.some((call) => call.method === "reviewDecide")).toBe(decided)
    }
  })

  test("a Continue for an item that is not open is forwarded only after the stopped child's actual parent lists it, direct or nested", async () => {
    const direct = await recoveryHarness()
    expect(valueOf(await continueStopped(direct, "rvw_stopped", "ses_child"))).toBeNull()
    expect(direct.calls.filter((call) => call.method === "subagentPage")).toEqual([{ method: "subagentPage", args: ["ses_1", { directory: "/work" }, undefined] }])
    expect(direct.calls.filter((call) => call.method === "reviewDecide")).toHaveLength(1)
    const nested = await recoveryHarness()
    expect(valueOf(await continueStopped(nested, "rvw_nested", "ses_grand"))).toBeNull()
    expect(nested.calls.filter((call) => call.method === "subagentPage")).toEqual([{ method: "subagentPage", args: ["ses_child", { directory: "/work" }, undefined] }])
    expect(nested.calls.at(-1)).toEqual({ method: "reviewDecide", args: ["ses_grand", { directory: "/work" }, "rvw_nested", { kind: "recovery", choice: "continue" }] })
    const open = await recoveryHarness()
    await run(open, "session.review.decide", { itemID: "rvw_recovery", decision: { kind: "recovery", choice: "continue" } }, "ses_child")
    expect(open.calls.some((call) => call.method === "subagentPage")).toBe(false)
  })

  test("a Continue is refused before any decision for a foreign, mismatched, unstopped, unmanaged, or unreadable target", async () => {
    for (const [name, itemID, sessionID, results] of [
      ["a foreign item with a valid selected child", "rvw_foreign", "ses_child", {}],
      ["a sibling's stopped item", "rvw_sibling", "ses_child", {}],
      ["a nested item addressed to its ancestor", "rvw_nested", "ses_child", {}],
      ["a child that was never stopped", "rvw_stopped", "ses_running", {}],
      ["a root Session", "rvw_stopped", "ses_1", {}],
      ["a side chat", "rvw_stopped", "ses_btw", {}],
      ["an unreadable page", "rvw_stopped", "ses_child", { subagentPage: async () => ({ data: "nope" }) }],
      ["a page that cannot be read", "rvw_stopped", "ses_child", { subagentPage: new LocalFailureClass("transport", "timeout") }],
    ] as const) {
      const refused = await recoveryHarness(results)
      expect((errorOf(await continueStopped(refused, itemID, sessionID)) as { code: string }).code, name).not.toBe(undefined)
      expect(refused.calls.some((call) => call.method === "reviewDecide"), name).toBe(false)
    }
  })

  test("the actual parent's task pages are followed to the stopped child, and a cursor that repeats ends the search without a decision", async () => {
    const paged = await recoveryHarness({ subagentPage: async (_id: string, _location: unknown, cursor?: string) => cursor === undefined
      ? stoppedPage([{ sessionID: "ses_running", parentID: "ses_1" }], "older")
      : stoppedPage([{ sessionID: "ses_child", parentID: "ses_1", itemID: "rvw_stopped" }]) })
    expect(valueOf(await continueStopped(paged, "rvw_stopped", "ses_child"))).toBeNull()
    expect(paged.calls.filter((call) => call.method === "subagentPage").map((call) => call.args[2])).toEqual([undefined, "older"])
    const endless = await recoveryHarness({ subagentPage: async () => stoppedPage([{ sessionID: "ses_running", parentID: "ses_1" }], "again") })
    expect(errorOf(await continueStopped(endless, "rvw_stopped", "ses_child")).code).toBe("invalid_message")
    expect(endless.calls.filter((call) => call.method === "subagentPage")).toHaveLength(2)
    expect(endless.calls.some((call) => call.method === "reviewDecide")).toBe(false)
  })

  test("a repeated or unconfirmed continuation is refused or unknown once and never replayed", async () => {
    const repeated = await recoveryHarness({ reviewDecide: new LocalFailureClass("conflict", "already continued") })
    expect(errorOf(await continueStopped(repeated, "rvw_stopped", "ses_child")).code).toBe("invalid_message")
    expect(repeated.calls.filter((call) => call.method === "reviewDecide")).toHaveLength(1)
    const lost = await recoveryHarness({ reviewDecide: new LocalFailureClass("transport", "timeout") })
    expect(errorOf(await continueStopped(lost, "rvw_stopped", "ses_child")).code).toBe("outcome_unknown")
    expect(lost.calls.filter((call) => call.method === "reviewDecide")).toHaveLength(1)
    expect(errorOf(await run(lost, "session.review.decide", { itemID: "rvw_recovery", decision: { kind: "recovery", choice: "stop" } })).code).toBe("outcome_unknown")
  })

  test("reports a decided or withdrawn item as no longer open and never replays an uncertain decision", async () => {
    const missing = await harness({ results: { reviewList: async () => items, reviewDecide: new LocalFailureClass("not_found", "gone") } })
    expect(errorOf(await run(missing, "session.review.decide", { itemID: "rvw_hard", decision: { kind: "guardrail", reply: "once" } }))).toMatchObject({ code: "invalid_message" })
    const lost = await harness({ results: { reviewList: async () => items, reviewDecide: new LocalFailureClass("transport", "timeout") } })
    expect(errorOf(await run(lost, "session.review.decide", { itemID: "rvw_hard", decision: { kind: "guardrail", reply: "once" } })).code).toBe("outcome_unknown")
    expect(lost.calls.filter((call) => call.method === "reviewDecide")).toHaveLength(1)
  })
})

describe("session shell output read", () => {
  const ownedShell = { id: "sh_1", command: `cat <<'EOF'\n${"line\n".repeat(1_000)}EOF`, status: "exited", metadata: { sessionID: "ses_1" } }

  async function shellHarness(results: Partial<Record<keyof LocalServer, unknown>> = {}) {
    return harness({
      results: {
        shellGet: async () => ownedShell,
        shellOutput: async () => ({ output: "page", cursor: 4, size: 4, truncated: false }),
        ...results,
      },
    })
  }

  test("refuses a shell owned by another Session before reading any output", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness({
      shellGet: async () => ({ id: "sh_1", metadata: { sessionID: "ses_2" } }),
    })
    const outcome = await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_1" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("forbidden")
    // The refused read never reaches the local output route, so no bytes are copied.
    expect(calls.some((call) => call.method === "shellOutput")).toBe(false)
    expect(JSON.stringify(outcome)).not.toContain("page")
  })

  test("refuses a shell whose owning Session is not recorded", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness({
      shellGet: async () => ({ id: "sh_1", metadata: {} }),
    })
    const outcome = await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_1" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("forbidden")
    expect(calls.some((call) => call.method === "shellOutput")).toBe(false)
  })

  test("returns the stored page verbatim after verifying ownership at the session location", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness()
    const outcome = await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_1", cursor: 0, limit: 2_048 }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(outcome)).toEqual({ command: ownedShell.command, status: "exited", data: { output: "page", cursor: 4, size: 4, truncated: false } })
    expect(calls.filter((call) => call.method === "shellGet")).toEqual([
      { method: "shellGet", args: ["sh_1", { directory: "/work" }] },
    ])
    expect(calls.at(-1)).toEqual({
      method: "shellOutput",
      args: ["sh_1", { directory: "/work" }, { cursor: 0, limit: 2_048 }],
    })
  })

  test("defaults to one bounded local page when the page size is omitted", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness()
    await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_1" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "shellOutput", args: ["sh_1", { directory: "/work" }, { limit: 65_536 }] })
  })

  test("rejects page inputs and unknown fields before any local call", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness()
    const cases = [
      {},
      { shellID: "sh" },
      { shellID: "../etc/passwd" },
      { shellID: "sh_1/../../etc/passwd" },
      { shellID: 4 },
      { shellID: "sh_1", cursor: -1 },
      { shellID: "sh_1", cursor: 1.5 },
      { shellID: "sh_1", limit: 0 },
      { shellID: "sh_1", limit: 1.5 },
      { shellID: "sh_1", limit: 65_537 },
      { shellID: "sh_1", path: "/tmp/shell.out" },
      { shellID: "sh_1", file: "/tmp/shell.out" },
    ]
    for (const input of cases) {
      calls.length = 0
      const outcome = await executeRemoteOperation({
        request: request("session.shell.output", input),
        sessions: registry,
        subscriptions,
        local,
      })
      expect({ input, code: errorOf(outcome).code }).toMatchObject({ input, code: "invalid_message" })
      expect(calls).toEqual([])
    }
  })

  test("maps a shell that is gone to a closed error without reading output", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness({
      shellGet: () => Promise.reject(new LocalFailureClass("not_found", "gone")),
    })
    const outcome = await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_missing" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("invalid_message")
    expect(calls.some((call) => call.method === "shellOutput")).toBe(false)
  })

  test("refuses a backend-unknown Session before any scoped local call", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness()
    const outcome = await executeRemoteOperation({
      request: { ...request("session.shell.output", { shellID: "sh_1" }), sessionID: "ses_other" },
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("session_not_allowed")
    expect(calls.map((call) => call.method)).toEqual(["listPage"])
  })
})

describe("strict validation and error mapping", () => {
  test("rejects unknown fields, malformed values, and unknown operations before any local call", async () => {
    const { local, registry, subscriptions, calls } = await harness({})
    const cases: Array<[RemoteRequest, string]> = [
      [request("session.prompt", { text: "hi", metadata: {} }), "invalid_message"],
      [request("session.prompt", {}), "invalid_message"],
      [request("session.prompt", { text: "hi", id: "per_1" }), "invalid_message"],
      [request("session.prompt", { text: "hi", delivery: "now" }), "invalid_message"],
      [request("session.prompt", { text: "hi", files: [{ uri: 4 }] }), "invalid_message"],
      [request("session.log", { after: -1 }), "invalid_message"],
      [request("session.subagent.list", { cursor: "" }), "invalid_message"],
      [request("session.subagent.list", { limit: 11 }), "invalid_message"],
      [request("session.subagent.list", { directory: "/etc" }), "invalid_message"],
      [request("session.permission.reply", { requestID: "grq_1", reply: "once" }), "invalid_message"],
      [request("session.permission.reply", { requestID: "per_1", reply: "maybe" }), "invalid_message"],
      [request("session.form.reply", { formID: "frm_1", answer: { invalid: { nested: true } } }), "invalid_message"],
      [request("session.form.cancel", { formID: "bad" }), "invalid_message"],
      [request("session.autonomy.set", { yolo: 9 }), "invalid_message"],
      [request("session.autonomy.set", {}), "invalid_message"],
      [request("session.autonomy.set", { sleep: "yes" }), "invalid_message"],
      [request("session.autonomy.set", { guardrailDecision: 1 }), "invalid_message"],
      [request("session.autonomy.set", { guardrailDecision: true, sleep: null }), "invalid_message"],
      [request("session.autonomy.set", { yolo: 1, sleep: true }), "invalid_message"],
      [request("session.autonomy.set", { maxNoProgress: 2, guardrailDecision: true }), "invalid_message"],
      [request("session.autonomy.set", { sleep: true, goal: "x" }), "invalid_message"],
      [request("session.autonomy.set", { sleep: true, priorGuardrailDecision: false }), "invalid_message"],
      [request("session.goal.set", { goal: "" }), "invalid_message"],
      [request("session.goal.stop", { goal: "stop" }), "invalid_message"],
      [request("session.list", { limit: 0 }), "invalid_message"],
      [request("session.list", { order: "sideways" }), "invalid_message"],
      [request("workspace.list", { directory: "/etc" }), "invalid_message"],
      [request("session.create", { id: "invalid", workspace: "wsp_1" }), "invalid_message"],
      [request("session.create", { id: "ses_new", workspace: "wsp_1", directory: "/etc" }), "invalid_message"],
      [request("session.switchModel", { model: { providerID: "test", id: "model", profile: "" } }), "invalid_message"],
      [request("session.get", { directory: "/etc" }), "invalid_message"],
      [request("session.active", { limit: 1 }), "invalid_message"],
      // A frame outside the shared contract; the relay parser rejects it before this layer.
      [{ ...request("session.get"), operation: "session.unknown" as RemoteRequest["operation"] }, "unknown_operation"],
    ]
    for (const [frame, code] of cases) {
      calls.length = 0
      const outcome = await executeRemoteOperation({ request: frame, sessions: registry, subscriptions, local })
      expect(errorOf(outcome).code).toBe(code)
      expect(calls).toEqual([])
    }
  })

  test("maps local failures onto the relay error vocabulary without replaying mutations", async () => {
    const cases: Array<[keyof LocalServer, unknown, string, readonly string[]]> = [
      ["messages", new LocalFailureClass("not_found", "gone"), "session_not_allowed", ["session.messages"]],
      ["permissionReply", new LocalFailureClass("not_found", "gone"), "invalid_message", ["session.permission.reply"]],
      ["prompt", new LocalFailureClass("transport", "no answer"), "outcome_unknown", ["session.prompt"]],
      ["messages", new LocalFailureClass("transport", "no answer"), "internal_error", ["session.messages"]],
      ["prompt", new LocalFailureClass("conflict", "conflict"), "invalid_message", ["session.prompt"]],
      ["messages", new LocalFailureClass("too_large", "big"), "message_too_large", ["session.messages"]],
      ["getSession", new LocalFailureClass("server", "boom"), "internal_error", ["session.get"]],
    ]
    for (const [method, failure, code, operations] of cases) {
      const results: Partial<Record<keyof LocalServer, unknown>> = {}
      const { local, registry, subscriptions, calls } = await harness({ results })
      results[method] = () => Promise.reject(failure)
      for (const operation of operations) {
        const input =
          operation === "session.prompt"
            ? { text: "hi" }
            : operation === "session.permission.reply"
              ? { requestID: "per_1", reply: "once" }
              : undefined
        const outcome = await executeRemoteOperation({
          request: request(operation as never, input),
          sessions: registry,
          subscriptions,
          local,
        })
        expect(errorOf(outcome).code).toBe(code)
        // One attempt per request: an indeterminate mutation is never replayed.
        expect(calls.filter((call) => call.method === method)).toHaveLength(1)
      }
    }
  })
})

describe("bounded response chunking", () => {
  test("keeps a small response in one frame and reassembles a large one in order", () => {
    const small = successFrames("req_1", { data: [1, 2, 3] })
    expect(small).toHaveLength(1)

    const large = { data: Array.from({ length: 20_000 }, (_, index) => ({ index, text: `line ${index} "quoted"` })) }
    const text = JSON.stringify(large)
    expect(text.length).toBeGreaterThan(RemoteLimits.maxAgentMessageChars)
    const frames = successFrames("req_1", large)
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.length).toBeLessThanOrEqual(RemoteLimits.maxChunksPerResponse)
    const parts: string[] = []
    frames.forEach((frame, index) => {
      expect(JSON.stringify(frame).length).toBeLessThanOrEqual(RemoteLimits.maxAgentMessageChars)
      const chunked = frame as { ok: true; value: string; chunk: { index: number; last: boolean } }
      expect(chunked.chunk.index).toBe(index)
      expect(chunked.chunk.last).toBe(index === frames.length - 1)
      parts.push(chunked.value)
    })
    const reassembled = parseChunkedValue(parts)
    expect(reassembled.ok).toBe(true)
    if (reassembled.ok) expect(reassembled.value).toEqual(large)
  })

  test("fails explicitly instead of truncating a value beyond the chunk bound", () => {
    const huge = { data: "x".repeat(RemoteLimits.maxAgentMessageChars * RemoteLimits.maxChunksPerResponse + 1) }
    const frames = successFrames("req_1", huge)
    expect(frames).toHaveLength(1)
    expect(frames[0].ok).toBe(false)
    if (!frames[0].ok) expect(frames[0].error.code).toBe("message_too_large")
  })
})

describe("local endpoint scope", () => {
  test("accepts loopback only and refuses LAN or public endpoints", () => {
    for (const url of ["http://127.0.0.1:4096", "http://localhost:4096", "http://[::1]:4096", "http://0.0.0.0:4096"]) {
      expect(() => assertPrivateEndpoint({ url })).not.toThrow()
    }
    for (const url of [
      "http://192.168.1.20:4096",
      "http://10.0.0.5:4096",
      "http://172.16.4.4:4096",
      "http://workstation.local:4096",
      "https://ycoding.example:4096",
    ]) {
      expect(() => assertPrivateEndpoint({ url })).toThrow(/loopback/)
    }
  })
})

describe("session list paging", () => {
  test("an anchored active page contains its root when the anchor crosses a page boundary", () => {
    const sessions = Array.from({ length: 6 }, (_, index) => sessionInfo(`ses_anchor_${index}`, { updated: 6 - index }))
    expect(listPage(sessions, parseListQuery({ order: "active", limit: 2, around: "ses_anchor_2", before: 1 })).data.map((row) => row.id)).toEqual(["ses_anchor_1", "ses_anchor_2"])
  })

  test("paged list classification ignores failure-only output ceilings and shares one bounded observation", async () => {
    const sessions = Array.from({ length: 502 }, (_, index) => sessionInfo(`ses_scope_${index}`, { updated: index, directory: process.cwd() }))
    const h = await harness({ sessions, results: {
      outstandingSessions: { data: [], running: [sessions[0]!.id], failed: sessions.slice(1).map((row) => row.id), lost: [] },
    } })
    const cache = createOperationCache(() => 1_000)
    for (const status of ["waiting", "running", "idle"] as const) {
      const response = await executeRemoteOperation({ request: request("session.list", { status, order: "active", limit: 1, parentID: null }), local: h.local, sessions: h.registry, subscriptions: h.subscriptions, cache })
      expect(response[0]?.ok).toBe(true)
    }
    expect(h.calls.filter((call) => call.method === "outstandingSessions").map((call) => call.args)).toEqual([[false]])
    expect(h.calls.filter((call) => call.method === "permissionRequests")).toHaveLength(1)
    expect(h.calls.filter((call) => call.method === "formRequests")).toHaveLength(1)
    expect(h.calls.filter((call) => call.method === "guardrailRequestList")).toHaveLength(1)
  })

  test("waiting roots precede running and idle roots with complete exclusive bidirectional pages", () => {
    const sessions = [
      { ...sessionInfo("ses_wait_a", { updated: 999 }), time: { created: 1, updated: 999, active: 2, pinned: 1 } },
      { ...sessionInfo("ses_wait_b", { updated: 2 }), time: { created: 1, updated: 2, active: 2 } },
      sessionInfo("ses_wait_c", { updated: 3 }),
      sessionInfo("ses_run_a", { updated: 90 }), sessionInfo("ses_run_b", { updated: 80 }),
      sessionInfo("ses_idle_a", { updated: 200 }), sessionInfo("ses_idle_b", { updated: 100 }),
      { ...sessionInfo("ses_archived", { updated: 300 }), time: { created: 1, updated: 300, archived: 300 } },
      sessionInfo("ses_child", { updated: 400, parentID: "ses_run_b" }),
    ]
    const running = new Set(["ses_wait_a", "ses_run_a", "ses_child"])
    const waiting = new Set(["ses_wait_a", "ses_wait_b", "ses_wait_c"])
    const expected = {
      waiting: ["ses_wait_c", "ses_wait_a", "ses_wait_b"], running: ["ses_run_a", "ses_run_b"], idle: ["ses_idle_a", "ses_idle_b"],
      all: ["ses_wait_c", "ses_wait_a", "ses_wait_b", "ses_run_a", "ses_run_b", "ses_archived", "ses_idle_a", "ses_idle_b"],
    }
    for (const status of ["all", "waiting", "running", "idle"] as const) {
      const query = { order: "active", parentID: null, limit: 1, ...(status === "all" ? {} : { status }) }
      const pages = [listPage(sessions, parseListQuery(query), running, waiting)]
      while (pages.at(-1)?.cursor.next) pages.push(listPage(sessions, parseListQuery({ ...query, cursor: pages.at(-1)!.cursor.next }), running, waiting))
      expect(pages.flatMap((page) => page.data.map((session) => session.id))).toEqual(expected[status])
      for (let index = pages.length - 1; index > 0; index -= 1) {
        const previous = listPage(sessions, parseListQuery({ ...query, cursor: pages[index]!.cursor.previous }), running, waiting)
        expect(previous.data).toEqual(pages[index - 1]!.data)
      }
    }
    for (const key of [{ running: false }, { running: false, waiting: "yes" }])
      expect(() => parseListQuery({ order: "active", cursor: Buffer.from(JSON.stringify({ id: "ses_wait_a", time: 2, direction: "next", ...key })).toString("base64url") })).toThrow()
  })

  test("list status keeps loss-only roots out of Waiting and reports them as lost attention beside genuine requests", async () => {
    const directory = process.cwd()
    const sessions = ["waiting", "both", "lost", "failed", "running", "idle"].map((id, index) => sessionInfo(`ses_${id}`, { updated: index, directory }))
    const h = await harness({ sessions, results: {
      outstandingSessions: { data: [], running: ["ses_waiting", "ses_both", "ses_running"], failed: ["ses_both", "ses_lost", "ses_failed"], lost: ["ses_lost"] },
      permissionRequests: [{ id: "per_1", sessionID: "ses_waiting" }, { id: "per_2", sessionID: "ses_both" }], formRequests: [], guardrailRequestList: [],
    } })
    const ids = async (status: "waiting" | "running" | "idle") => recordOf(valueOf(await executeRemoteOperation({
      request: request("session.list", { status, order: "active", parentID: null }), local: h.local, sessions: h.registry, subscriptions: h.subscriptions,
    }))).data
    expect(await ids("waiting")).toEqual([sessions[1], sessions[0]])
    expect(await ids("running")).toEqual([sessions[4]])
    expect(await ids("idle")).toEqual([sessions[5], sessions[3], sessions[2]])
    const all = recordOf(valueOf(await executeRemoteOperation({
      request: request("session.list", { order: "active", parentID: null }), local: h.local, sessions: h.registry, subscriptions: h.subscriptions,
    })))
    expect(all.data).toEqual([sessions[1], sessions[0], sessions[4], sessions[5], sessions[3], sessions[2]])
    expect(all.status).toEqual({ running: ["ses_both", "ses_waiting", "ses_running"], attention: ["ses_both", "ses_waiting", "ses_lost"], lost: ["ses_lost"] })
  })

  test("listPage orders and filters Waiting by genuine requests only and snapshots loss-only roots in status.lost", () => {
    const sessions = [sessionInfo("ses_ask", { updated: 1 }), sessionInfo("ses_lost", { updated: 9 }), sessionInfo("ses_idle", { updated: 5 }),
      sessionInfo("ses_child", { updated: 20, parentID: "ses_lost" }), sessionInfo("ses_ask_lost", { updated: 2 })]
    const running = new Set<string>()
    const waiting = new Set(["ses_ask", "ses_ask_lost"])
    const lost = new Set(["ses_lost", "ses_ask_lost", "ses_child"])
    const page = (status?: "waiting" | "running" | "idle") => listPage(sessions, parseListQuery({ order: "active", parentID: null, ...(status === undefined ? {} : { status }) }), running, waiting, lost)
    expect(page("waiting").data.map((row) => row.id)).toEqual(["ses_ask_lost", "ses_ask"])
    expect(page("idle").data.map((row) => row.id)).toEqual(["ses_lost", "ses_idle"])
    expect(page().data.map((row) => row.id)).toEqual(["ses_ask_lost", "ses_ask", "ses_lost", "ses_idle"])
    expect(page()).toHaveProperty("status", { running: [], attention: ["ses_ask_lost", "ses_ask", "ses_lost"], lost: ["ses_lost"] })
    expect(page("waiting")).toHaveProperty("status", { running: [], attention: ["ses_ask_lost", "ses_ask"] })
    expect(listPage(sessions, parseListQuery({ order: "active", parentID: null }), running, waiting)).toHaveProperty("status", { running: [], attention: ["ses_ask_lost", "ses_ask"] })
  })

  test("a loss clears from list status once the owed notice is gone, without moving any root", async () => {
    const sessions = [sessionInfo("ses_lost", { updated: 1, directory: process.cwd() }), sessionInfo("ses_idle", { updated: 2, directory: process.cwd() })]
    let work = { data: [] as string[], running: [] as string[], failed: [] as string[], lost: ["ses_lost"] }
    const h = await harness({ sessions, results: { outstandingSessions: () => work } })
    const list = async () => recordOf(valueOf(await executeRemoteOperation({ request: request("session.list", { order: "active", parentID: null, status: "idle" }),
      local: h.local, sessions: h.registry, subscriptions: h.subscriptions, cache: createOperationCache(() => 0) })))
    expect((await list()).status).toEqual({ running: [], attention: ["ses_lost"], lost: ["ses_lost"] })
    work = { ...work, lost: [] }
    expect((await list()).status).toEqual({ running: [], attention: [] })
  })

  test("live background shell owners make their family running; settled notices remain outstanding only", async () => {
    const root = sessionInfo("ses_root", { updated: 1 })
    const child = sessionInfo("ses_child", { updated: 2, parentID: "ses_root" })
    let work = { data: ["ses_child"], running: ["ses_child"], failed: [] as string[], lost: [] }
    const h = await harness({ sessions: [root, child], results: { activeSessions: {}, outstandingSessions: () => work } })
    const list = async (status: "running" | "idle") => valueOf(await executeRemoteOperation({ request: request("session.list", { status, parentID: null, order: "active" }),
      local: h.local, sessions: h.registry, subscriptions: h.subscriptions }))
    expect(await sessionStatus(h.local, h.registry.snapshot(), {}, new Set())).toMatchObject({ running: ["ses_root"] })
    expect(recordOf(await list("running")).data).toEqual([root])
    expect(recordOf(await list("idle")).data).toEqual([])
    work = { ...work, running: [] }
    expect(await sessionStatus(h.local, h.registry.snapshot(), {}, new Set())).toMatchObject({ running: [], outstanding: ["ses_root"] })
    expect(recordOf(await list("running")).data).toEqual([])
    expect(recordOf(await list("idle")).data).toEqual([root])
  })

  test("active cursors reject changed running membership and rebase around a retained root", () => {
    const root = { ...sessionInfo("ses_root", { updated: 2 }), time: { created: 2, updated: 2 } }
    const child = sessionInfo("ses_child", { updated: 5, parentID: "ses_root" })
    const pinned = { ...sessionInfo("ses_pinned", { updated: 3 }), time: { created: 3, updated: 3, pinned: 9 } }
    const recent = sessionInfo("ses_recent", { updated: 4 })
    const sessions = [root, child, pinned, recent]
    const running = new Set(["ses_child"])
    const page = listPage(sessions, parseListQuery({ order: "active", parentID: null, limit: 1 }), running)
    expect(page.data.map((session) => session.id)).toEqual(["ses_root"])
    const after = listPage(sessions, parseListQuery({ order: "active", parentID: null, limit: 2, cursor: page.cursor.next }), new Set(["ses_child", "ses_recent"]))
    expect(after).toMatchObject({ stale: true, data: [] })
    const rebased = listPage(sessions, parseListQuery({ order: "active", parentID: null, limit: 2, around: "ses_root", before: 1 }), new Set(["ses_child", "ses_recent"]))
    expect(rebased.data.map((session) => session.id)).toEqual(["ses_recent", "ses_root"])
    expect(() => parseListQuery({ order: "active", cursor: Buffer.from(JSON.stringify({ id: "ses_root", time: 2, direction: "next" })).toString("base64url") })).toThrow()
  })

  test("active ordering uses reported activity before metadata edits or pins, with stable bidirectional pages", () => {
    const sessions = [
      { ...sessionInfo("ses_old_pin", { updated: 1000 }), time: { created: 1, updated: 1000, active: 5, pinned: 1 } },
      { ...sessionInfo("ses_idle_recent", { updated: 2 }), time: { created: 1, updated: 2, active: 90 } },
      { ...sessionInfo("ses_running_old", { updated: 900 }), time: { created: 1, updated: 900, active: 30, pinned: 2 } },
      { ...sessionInfo("ses_running_new", { updated: 3 }), time: { created: 1, updated: 3, active: 40 } },
      { ...sessionInfo("ses_unknown", { updated: 2 }), time: { created: 1, updated: 2 } },
    ]
    const running = new Set(["ses_running_old", "ses_running_new"])
    const expected = ["ses_running_new", "ses_running_old", "ses_idle_recent", "ses_old_pin", "ses_unknown"]
    expect(listPage(sessions, parseListQuery({ order: "active", limit: 10 }), running).data.map((session) => session.id)).toEqual(expected)
    const first = listPage(sessions, parseListQuery({ order: "active", limit: 2 }), running)
    const second = listPage(sessions, parseListQuery({ order: "active", limit: 2, cursor: first.cursor.next }), running)
    const last = listPage(sessions, parseListQuery({ order: "active", limit: 2, cursor: second.cursor.next }), running)
    expect([...first.data, ...second.data, ...last.data].map((session) => session.id)).toEqual(expected)
    const previous = listPage(sessions, parseListQuery({ order: "active", limit: 2, cursor: second.cursor.previous }), running)
    expect(previous.data.map((session) => session.id)).toEqual(expected.slice(0, 2))
    expect(listPage(sessions, parseListQuery({ order: "pinned", limit: 1 }), running).data[0]?.id).toBe("ses_old_pin")
  })

  test("status filters classify a root by its family, so an idle root with a running subagent is running", () => {
    const root = sessionInfo("ses_root", { updated: 2 })
    const child = sessionInfo("ses_child", { updated: 5, parentID: "ses_root" })
    const busy = sessionInfo("ses_busy", { updated: 3 })
    const idle = sessionInfo("ses_idle", { updated: 4 })
    const sessions = [root, child, busy, idle]
    const running = new Set(["ses_child", "ses_busy"])
    const ids = (status: "running" | "idle") =>
      listPage(sessions, parseListQuery({ status, parentID: null, limit: 10 }), running).data.map((session) => session.id)
    expect(ids("running")).toEqual(["ses_busy", "ses_root"])
    expect(ids("idle")).toEqual(["ses_idle"])
    expect(listPage(sessions, parseListQuery({ status: "running", parentID: "ses_root", limit: 10 }), running).data.map((session) => session.id)).toEqual(["ses_child"])
  })

  test("distinguishes recorded workspace identities in the same directory", async () => {
    const first = { ...sessionInfo("ses_one", { updated: 1, directory: process.cwd() }), location: { directory: process.cwd(), workspaceID: "one" } }
    const second = { ...sessionInfo("ses_two", { updated: 2, directory: process.cwd() }), location: { directory: process.cwd(), workspaceID: "two" } }
    const test = await harness({ sessions: [first, second], results: { projectList: [] } })
    const response = valueOf(await executeRemoteOperation({ request: request("workspace.list", { sessionsOnly: true }),
      local: test.local, sessions: test.registry, subscriptions: test.subscriptions })) as { data: { id: string; workspaceID?: string }[] }
    expect(response.data.map((group) => group.workspaceID).toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual(["one", "two"])
    expect(response.data[0]?.id).not.toBe(response.data[1]?.id)
    expect(listPage([first, second], parseListQuery({ workspace: response.data.find((group) => group.workspaceID === "one")?.id, limit: 10 })).data.map((session) => session.id)).toEqual(["ses_one"])
  })

  test("pages a selected recorded workspace with summary search, status, and stable pinned order", async () => {
    const directory = await mkdtemp(join(scratch, "ycoding-inventory-"))
    try {
      const first = { ...sessionInfo("ses_first", { updated: 1, title: "First", directory }), agent: "builder",
        model: { providerID: "test", id: "model", variant: "high" }, time: { created: 1, updated: 1, pinned: 2 } }
      const second = { ...sessionInfo("ses_second", { updated: 2, title: "Second", directory }), time: { created: 2, updated: 2, pinned: 1 } }
      const third = sessionInfo("ses_third", { updated: 3, title: "Third", directory })
      const elsewhere = sessionInfo("ses_elsewhere", { updated: 4, title: "Elsewhere", directory: "/other" })
      const test = await harness({ sessions: [first, second, third, elsewhere], results: { projectList: [] } })
      const groups = valueOf(await executeRemoteOperation({
        request: request("workspace.list", { sessionsOnly: true }), local: test.local, sessions: test.registry, subscriptions: test.subscriptions,
      })) as { data: { id: string; directory: string }[] }
      const workspace = groups.data.find((group) => group.directory === directory)
      expect(workspace).toBeDefined()
      expect(test.calls.filter((call) => call.method === "listPage")).toEqual([])
      const wirePage = valueOf(await executeRemoteOperation({ request: request("session.list", { workspace: workspace?.id, order: "pinned", limit: 1 }),
        local: test.local, sessions: test.registry, subscriptions: test.subscriptions })) as { data: SessionInfo[] }
      expect(wirePage.data.map((session) => session.id)).toEqual(["ses_second"])
      expect(test.calls.filter((call) => call.method === "listPage")).toEqual([])
      const page = listPage([first, second, third, elsewhere], parseListQuery({ workspace: workspace?.id, order: "pinned", limit: 1 }))
      expect(page.data.map((session) => session.id)).toEqual(["ses_second"])
      const following = listPage([first, second, third, elsewhere], parseListQuery({ workspace: workspace?.id, order: "pinned", limit: 2, cursor: page.cursor.next }))
      expect(following.data.map((session) => session.id)).toEqual(["ses_first", "ses_third"])
      const backwards = listPage([first, second, third, elsewhere], parseListQuery({ workspace: workspace?.id, order: "pinned", limit: 1, cursor: following.cursor.previous }))
      expect(backwards.data.map((session) => session.id)).toEqual(["ses_second"])
      const searched = listPage([first, second, third], parseListQuery({ workspace: workspace?.id, search: "builder", searchFields: "summary", limit: 10 }))
      expect(searched.data.map((session) => session.id)).toEqual(["ses_first"])
      expect(listPage([first, second], parseListQuery({ workspace: workspace?.id, search: "#high", searchFields: "summary", limit: 10 })).data.map((session) => session.id)).toEqual(["ses_first"])
      expect(listPage([first, second], parseListQuery({ search: "#high", limit: 10 })).data).toEqual([])
      const noModel = { ...second, model: undefined }
      expect(listPage([noModel], parseListQuery({ search: "/", searchFields: "summary", limit: 10 })).data).toEqual([])
      expect(listPage([first, second, third], parseListQuery({ search: "builder", limit: 10 })).data).toEqual([])
      const running = listPage([first, second, third], parseListQuery({ workspace: workspace?.id, status: "running", limit: 10 }), new Set(["ses_third"]))
      expect(running.data.map((session) => session.id)).toEqual(["ses_third"])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("orders, searches, limits, and pages the advertised set without leaking unlisted sessions", () => {
    const sessions = [
      sessionInfo("ses_a", { updated: 1, title: "Alpha" }),
      sessionInfo("ses_b", { updated: 2, title: "Beta" }),
      sessionInfo("ses_c", { updated: 3, title: "Gamma" }),
    ]
    const first = listPage(sessions, parseListQuery({ limit: 2 })) as { data: SessionInfo[]; cursor: { next?: string } }
    expect(first.data.map((session) => session.id)).toEqual(["ses_c", "ses_b"])
    expect(first.cursor.next).toBeDefined()

    const second = listPage(sessions, parseListQuery({ limit: 2, cursor: first.cursor.next })) as {
      data: SessionInfo[]
      cursor: { next?: string }
    }
    expect(second.data.map((session) => session.id)).toEqual(["ses_a"])
    expect(second.cursor.next).toBeUndefined()

    const ascending = listPage(sessions, parseListQuery({ order: "asc", limit: 10 })) as { data: SessionInfo[] }
    expect(ascending.data.map((session) => session.id)).toEqual(["ses_a", "ses_b", "ses_c"])

    const searched = listPage(sessions, parseListQuery({ search: "amm", limit: 10 })) as { data: SessionInfo[] }
    expect(searched.data.map((session) => session.id)).toEqual(["ses_c"])

    const roots = listPage(
      [...sessions, sessionInfo("ses_child", { updated: 4, parentID: "ses_a" })],
      parseListQuery({ parentID: null, limit: 10 }),
    ) as { data: SessionInfo[] }
    expect(roots.data.map((session) => session.id)).toEqual(["ses_c", "ses_b", "ses_a"])
  })
})
