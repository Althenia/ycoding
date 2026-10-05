import { describe, expect, test } from "bun:test"
import {
  RemoteLimits,
  RemoteProtocolVersion,
  RemoteWebSocketPath,
  alertTitle,
  deviceSignaturePayload,
  isAlertTitle,
  parseAgentMessage,
  parseChallengeRequest,
  parseClientMessage,
  parseDeviceRefreshRequest,
  parseDeviceTokenRequest,
  parseEnrollRequest,
  parseChunkedValue,
  parsePublicKey,
  parsePushSubscription,
  parsePushEndpoint,
  parsePushTestResponse,
  parseRelayToAgentMessage,
  noticePageValue,
  noticeSequence,
  parseNoticePage,
  parseRelayToClientMessage,
  remoteError,
  remoteOperations,
  remoteSessionOperations,
  requireSession,
  isNoticeRequest,
  serializeEvent,
  serializeNoticeFrame,
  serializeRequest,
  serializeResponse,
  serializeSessions,
  serializeStatus,
  type RemoteNoticeFrame,
  type RemoteOperation,
} from "../src/index"

test("notice cursors identify one positive safe integer without aliases", () => {
  expect(noticeSequence("ntc_1")).toBe(1)
  expect(noticeSequence("ntc_999999999999999")).toBe(999999999999999)
  for (const id of ["ntc_0", "ntc_01", "ntc_9007199254740993", "ntc_1.0", "ntc_-1"])
    expect(noticeSequence(id)).toBeUndefined()
  for (const id of ["ntc_0", "ntc_01", "ntc_9007199254740993"])
    expect(parseClientMessage(JSON.stringify({ type: "request", id: "req", operation: "notice.read", input: { ids: [id] } })).ok).toBe(false)
})

test("scoped attachment chunks stay within the client frame and require ordered upload fields", () => {
  const input = { uploadID: "4ab94d33-6e6b-41a3-a638-f0a6596854a9", index: 0, last: false, data: "AAAA" }
  const frame = { type: "request", id: "req_1", operation: "session.attachment.upload", sessionID: "ses_1", input }
  expect(parseClientMessage(JSON.stringify(frame))).toMatchObject({ ok: true, value: frame })
  expect(parseRelayToAgentMessage(JSON.stringify(frame))).toMatchObject({ ok: true, value: frame })
  for (const change of [{ index: -1 }, { data: "!" }, { data: "YQ==" }, { uploadID: "../other" }, { last: "true" }, { extra: true }])
    expect(parseClientMessage(JSON.stringify({ ...frame, input: { ...input, ...change } })).ok).toBe(false)
  expect(parseClientMessage(JSON.stringify({ ...frame, input: { ...input, data: "A".repeat(28_001) } })).ok).toBe(false)
  expect(parseClientMessage(JSON.stringify({ ...frame, input: { ...input, data: "A".repeat(28_000) } })).ok).toBe(true)
  expect(parseClientMessage(JSON.stringify({ ...frame, sessionID: undefined })).ok).toBe(false)
})

test("windowed snapshot and managed attachment reads admit only scoped bounded inputs", () => {
  const snapshot = { type: "request", id: "req_window", operation: "session.snapshot", sessionID: "ses_1", input: { limit: 200, before: "cursor_1" } }
  expect(parseClientMessage(JSON.stringify(snapshot))).toMatchObject({ ok: true, value: snapshot })
  for (const input of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { before: "cursor" }, { limit: 1, before: "x".repeat(257) }, { limit: 1, extra: true }])
    expect(parseClientMessage(JSON.stringify({ ...snapshot, input })).ok).toBe(false)
  expect(parseClientMessage(JSON.stringify({ ...snapshot, input: undefined })).ok).toBe(true)
  const attachment = { ...snapshot, operation: "session.attachment.read", input: { digest: "a".repeat(64) } }
  expect(parseClientMessage(JSON.stringify(attachment))).toMatchObject({ ok: true, value: attachment })
  for (const input of [{ digest: "A".repeat(64) }, { digest: "../x" }, { digest: "a".repeat(64), path: "file:///secret" }, {}])
    expect(parseClientMessage(JSON.stringify({ ...attachment, input })).ok).toBe(false)
  expect(parseClientMessage(JSON.stringify({ ...attachment, sessionID: undefined })).ok).toBe(false)
  expect(requireSession("session.attachment.read" as typeof remoteOperations[number])).toBe(true)
})

test("one-message stream requests accept only an indexed Session message ID", () => {
  const frame = { type: "request", id: "req_message", operation: "session.message.stream", sessionID: "ses_1", input: { messageID: "msg_1" } }
  expect(parseClientMessage(JSON.stringify(frame))).toMatchObject({ ok: true, value: frame })
  for (const input of [{ messageID: "../x" }, { messageID: "msg_1", offset: 1 }, { messageID: "msg_1", path: "/private" }])
    expect(parseClientMessage(JSON.stringify({ ...frame, input })).ok).toBe(false)
})

test("compaction history is a read-only Session-scoped operation with no caller placement or paging fields", () => {
  const request = { type: "request", id: "req_compactions", operation: "session.compaction.list", sessionID: "ses_1" }
  expect(parseClientMessage(JSON.stringify(request))).toMatchObject({ ok: true, value: request })
  expect(parseRelayToAgentMessage(JSON.stringify(request))).toMatchObject({ ok: true, value: request })
  expect(parseClientMessage(JSON.stringify({ ...request, sessionID: undefined }))).toMatchObject({ ok: false, error: { code: "session_required" } })
  for (const input of [{ limit: 1 }, { directory: "/tmp" }, { workspaceID: "wsp_1" }, {}])
    expect(parseClientMessage(JSON.stringify({ ...request, input })).ok).toBe(false)
})

test("manual compaction admits only a Session and a stable compaction ID", () => {
  const frame = { type: "request", id: "req_compact", operation: "session.compact", sessionID: "ses_1", input: { id: "cmp_web_1" } }
  expect(parseClientMessage(JSON.stringify(frame))).toMatchObject({ ok: true, value: frame })
  expect(parseRelayToAgentMessage(JSON.stringify(frame))).toMatchObject({ ok: true, value: frame })
  expect(parseClientMessage(JSON.stringify({ ...frame, sessionID: undefined }))).toMatchObject({ ok: false, error: { code: "session_required" } })
  for (const input of [undefined, {}, { id: "msg_wrong" }, { id: "cmp_" }, { id: "cmp_web_1", directory: "/private" }, { id: "cmp_web_1", workspaceID: "wsp_other" }])
    expect(parseClientMessage(JSON.stringify({ ...frame, input })).ok).toBe(false)
})

test("prompt skills are optional bounded nonempty IDs inside the closed prompt input", () => {
  const frame = { type: "request", id: "req_skills", operation: "session.prompt", sessionID: "ses_1", input: { id: "msg_1", text: "Review", delivery: "queue", skills: ["audit", "test"] } }
  expect(parseClientMessage(JSON.stringify(frame))).toMatchObject({ ok: true, value: frame })
  expect(parseRelayToAgentMessage(JSON.stringify(frame))).toMatchObject({ ok: true, value: frame })
  for (const skills of [[], ["x".repeat(128)], Array.from({ length: 200 }, (_, index) => `skill_${index}`)])
    expect(parseClientMessage(JSON.stringify({ ...frame, input: { ...frame.input, skills } })).ok).toBe(true)
  for (const skills of ["audit", null, [""], [" "], [1], [{ id: "audit" }], ["x".repeat(129)], Array.from({ length: 201 }, () => "audit")]) {
    expect(parseClientMessage(JSON.stringify({ ...frame, input: { ...frame.input, skills } })).ok).toBe(false)
    expect(parseRelayToAgentMessage(JSON.stringify({ ...frame, input: { ...frame.input, skills } })).ok).toBe(false)
  }
  expect(parseClientMessage(JSON.stringify({ ...frame, input: { ...frame.input, metadata: { skills: [{ id: "audit" }] } } })).ok).toBe(false)
  expect(parseClientMessage(JSON.stringify({ ...frame, input: { text: "No skills" } })).ok).toBe(true)
})

test("machine keep-awake controls are global and accept only the explicit enabled flag", () => {
  const read = { type: "request", id: "req_awake", operation: "machine.keepAwake.get" }
  const write = { ...read, operation: "machine.keepAwake.set", input: { enabled: true } }
  for (const frame of [read, write, { ...write, input: { enabled: false } }]) {
    expect(parseClientMessage(JSON.stringify(frame))).toMatchObject({ ok: true, value: frame })
    expect(parseRelayToAgentMessage(JSON.stringify(frame))).toMatchObject({ ok: true, value: frame })
    expect(parseClientMessage(JSON.stringify({ ...frame, sessionID: "ses_1" })).ok).toBe(false)
  }
  for (const input of [undefined, {}, { enabled: "true" }, { enabled: true, directory: "/private" }, { enabled: true, workspaceID: "wsp_other" }])
    expect(parseClientMessage(JSON.stringify({ ...write, input })).ok).toBe(false)
  expect(parseClientMessage(JSON.stringify({ ...read, input: {} })).ok).toBe(false)
})

test("machine latency ingest and reads accept only bounded anonymous samples for the connected device", () => {
  const sample = { kind: "request", at: "2026-10-04T12:00:00.000Z", operation: "session.list", outcome: "ok", queueMs: 5, settlementMs: 20, totalMs: 25 }
  const task = { kind: "long-task", at: sample.at, durationMs: 70 }
  const append = { type: "request", id: "req_latency", operation: "machine.latency.append", input: { samples: [sample, task] } }
  const list = { type: "request", id: "req_latency_list", operation: "machine.latency.list", input: { limit: 200, before: "cursor_1" } }
  for (const frame of [append, list, { ...list, input: undefined }]) {
    expect(parseClientMessage(JSON.stringify(frame))).toMatchObject({ ok: true })
    expect(parseRelayToAgentMessage(JSON.stringify(frame))).toMatchObject({ ok: true })
    expect(parseClientMessage(JSON.stringify({ ...frame, sessionID: "ses_1" })).ok).toBe(false)
  }
  for (const input of [undefined, {}, { samples: [] }, { samples: Array.from({ length: 21 }, () => sample) },
    { samples: [sample], directory: "/private" }, { samples: [{ ...sample, input: { text: "private" } }] },
    { samples: [{ ...sample, operation: "machine.latency.append" }] }, { samples: [{ ...sample, operation: "account.read" }] },
    { samples: [{ ...sample, operation: "session.list", totalMs: -1 }] },
    { samples: [{ ...sample, settlementMs: 600_001 }] }, { samples: [{ ...sample, at: "yesterday" }] },
    { samples: [{ ...task, attribution: "/private" }] }, { samples: [{ ...task, durationMs: 0 }] }])
    expect(parseClientMessage(JSON.stringify({ ...append, input })).ok).toBe(false)
  for (const input of [{ limit: 0 }, { limit: 201 }, { before: "" }, { before: "x".repeat(257) }, { limit: 1, workspace: "/private" }, {}])
    expect(parseClientMessage(JSON.stringify({ ...list, input })).ok).toBe(input !== undefined && Object.keys(input).length === 0)
})

test("captured changes is a read-only Session-scoped paged operation without caller placement", () => {
  const frame = { type: "request", id: "req_changes", operation: "session.capturedChanges.list", sessionID: "ses_root" }
  expect(parseClientMessage(JSON.stringify(frame))).toMatchObject({ ok: true, value: frame })
  expect(parseRelayToAgentMessage(JSON.stringify({ ...frame, input: { cursor: "opaque_cursor" } }))).toMatchObject({ ok: true })
  expect(parseClientMessage(JSON.stringify({ ...frame, sessionID: undefined }))).toMatchObject({ ok: false, error: { code: "session_required" } })
  for (const input of [{ directory: "/private" }, { workspaceID: "wsp_other" }, { cursor: "" }, { cursor: "x".repeat(257) }, { limit: 1 }, {}])
    expect(parseClientMessage(JSON.stringify({ ...frame, input })).ok).toBe(false)
})

test("Team operations stay root-scoped with bounded child, shell, side-chat, and economics inputs", () => {
  const request = (operation: string, input?: unknown) => ({ type: "request", id: "team_1", sessionID: "ses_root", operation,
    ...(input === undefined ? {} : { input }) })
  for (const [operation, input] of [
    ["session.subagent.cancel", { childID: "ses_child" }],
    ["session.subagent.answer", { childID: "ses_child", questionID: "qst_1", text: "staging" }],
    ["session.team.shell.list", undefined],
    ["session.team.shell.kill", { shellID: "sh_1" }],
    ["session.side-chat.list", undefined],
    ["session.side-chat.list", { cursor: "opaque" }],
    ["session.side-chat.create", { id: "ses_btw_new" }],
    ["session.team.economics", { sessionIDs: ["ses_child"] }],
  ] as const) {
    expect(parseClientMessage(JSON.stringify(request(operation, input)))).toMatchObject({ ok: true })
    expect(parseClientMessage(JSON.stringify({ ...request(operation, input), sessionID: undefined })).ok).toBe(false)
  }
  for (const [operation, input] of [
    ["session.subagent.cancel", { childID: "../foreign" }],
    ["session.subagent.answer", { childID: "ses_child", questionID: "qst_1", text: "" }],
    ["session.subagent.answer", { childID: "ses_child", questionID: "bad", text: "answer" }],
    ["session.team.shell.list", { directory: "/private" }],
    ["session.team.shell.kill", { shellID: "sh_1", sessionID: "ses_foreign" }],
    ["session.side-chat.list", { cursor: "x".repeat(1_025) }],
    ["session.side-chat.create", { id: "ses_btw_new", agent: "god" }],
    ["session.team.economics", { sessionIDs: [] }],
    ["session.team.economics", { sessionIDs: ["ses_child", "ses_child"] }],
    ["session.team.economics", { sessionIDs: Array.from({ length: 16 }, (_, index) => `ses_${index}`) }],
  ] as const) expect(parseClientMessage(JSON.stringify(request(operation, input))).ok).toBe(false)
})

test("cancel frames carry the sender's own correlation ID on both control surfaces", () => {
  const frame = JSON.stringify({ type: "cancel", id: "req_message" })
  expect(parseRelayToAgentMessage(frame)).toMatchObject({ ok: true, value: { type: "cancel", id: "req_message" } })
  expect(parseClientMessage(frame)).toMatchObject({ ok: true, value: { type: "cancel", id: "req_message" } })
  expect(parseRelayToAgentMessage(JSON.stringify({ type: "cancel", id: "bad!" })).ok).toBe(false)
  expect(parseClientMessage(JSON.stringify({ type: "cancel", id: "bad!" })).ok).toBe(false)
})

test("push subscription input admits only bounded known push services and key shapes", () => {
  const categories = { "agent-completed": true, "approval-requested": false, "machine-offline": true }
  const input = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BA" + "A".repeat(85), auth: "A".repeat(22) }, categories }
  expect(parsePushSubscription(input)).toMatchObject({ ok: true, value: input })
  expect(parsePushEndpoint({ endpoint: input.endpoint })).toMatchObject({ ok: true, value: { endpoint: input.endpoint } })
  const renewal = { endpoint: "https://web.push.apple.com/renewed", keys: input.keys, replaces: input.endpoint }
  expect(parsePushSubscription(renewal)).toEqual({ ok: true, value: renewal })
  for (const invalid of [
    { endpoint: input.endpoint, keys: input.keys },
    { ...input, replaces: input.endpoint },
    { ...renewal, replaces: "https://evil.example/old" },
    { ...input, categories: { "agent-completed": true, "approval-requested": true } },
    { ...input, categories: { ...categories, "machine-offline": "yes" } },
    { ...input, categories: { ...categories, test: true } },
  ]) expect(parsePushSubscription(invalid).ok).toBe(false)
  for (const endpoint of ["https://updates.push.services.mozilla.com/wpush/abc", "https://web.push.apple.com/Q", "https://foo.push.apple.com/Q", "https://foo.notify.windows.com/WNS"])
    expect(parsePushSubscription({ ...input, endpoint }).ok).toBe(true)
  for (const endpoint of ["http://fcm.googleapis.com/send", "https://fcm.googleapis.com.evil.example/send",
    "https://evil.example/send", "https://user@fcm.googleapis.com/send", "https://fcm.googleapis.com:8443/send"])
    expect(parsePushSubscription({ ...input, endpoint }).ok).toBe(false)
  for (const invalid of [
    { ...input, keys: { ...input.keys, auth: "short" } },
    { ...input, keys: { ...input.keys, p256dh: "short" } },
    { ...input, extra: "untrusted" },
  ]) expect(parsePushSubscription(invalid).ok).toBe(false)
})

test("push test responses report only the push service outcome and its HTTP status", () => {
  for (const value of [{ outcome: "accepted", status: 201 }, { outcome: "rejected", status: 403 }, { outcome: "expired", status: 410 }, { outcome: "unreachable" }] as const)
    expect(parsePushTestResponse(value)).toEqual({ ok: true, value })
  for (const value of [{ outcome: "delivered", status: 201 }, { outcome: "accepted" }, { outcome: "unreachable", status: 0 },
    { outcome: "accepted", status: 201, endpoint: "https://fcm.googleapis.com/fcm/send/abc" }, { outcome: "rejected", status: 99 }])
    expect(parsePushTestResponse(value).ok).toBe(false)
})

test("usage operations are global and validate refresh and bounded ReportInput", () => {
  for (const [operation, input] of [
    ["usage.providers", { refresh: true }], ["usage.providers", {}], ["usage.providers", undefined],
    ["usage.summary", undefined],
    ["usage.report", { group: "model", from: 0, to: 100, offset: 0, limit: 200, sort: "cost", order: "desc" }],
    ["usage.report", { group: "day", timeZone: "America/New_York" }],
  ] as const) expect(parseClientMessage(JSON.stringify({ type: "request", id: "r", operation, ...(input === undefined ? {} : { input }) }))).toMatchObject({ ok: true })
  for (const [operation, input] of [
    ["usage.providers", { refresh: "true" }], ["usage.providers", { refresh: true, raw: true }],
    ["usage.summary", {}], ["usage.report", {}], ["usage.report", { group: "model", limit: 201 }],
    ["usage.report", { group: "hour", from: 10, to: 10 }], ["usage.report", { group: "model", sort: "secret" }],
    ["usage.report", { group: "day", timeZone: "" }], ["usage.report", { group: "day", timeZone: 42 }],
  ] as const) expect(parseClientMessage(JSON.stringify({ type: "request", id: "r", operation, input }))).toMatchObject({ ok: false, error: { code: "invalid_message" } })
  for (const operation of ["usage.providers", "usage.summary", "usage.report"])
    expect(parseClientMessage(JSON.stringify({ type: "request", id: "r", operation, sessionID: "ses_1", input: operation === "usage.report" ? { group: "model" } : undefined })).ok).toBe(false)
})

const jwk = {
  kty: "EC",
  crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
} as const

describe("remote envelope: request", () => {
  test("requires a Session and no input for the todo read", () => {
    expect(parseClientMessage('{"type":"request","id":"a","operation":"session.todo.list","sessionID":"ses_1"}')).toMatchObject({ ok: true })
    for (const request of [
      { operation: "session.todo.list" },
      { operation: "session.todo.list", sessionID: "ses_1", input: {} },
      { operation: "session.todo.list", sessionID: "ses_1", input: { directory: "/other" } },
    ]) expect(parseClientMessage(JSON.stringify({ type: "request", id: "a", ...request })).ok).toBe(false)
    expect(requireSession("session.todo.list" as RemoteOperation)).toBe(true)
  })
  test("round-trips a bounded session operation", () => {
    const encoded = serializeRequest({
      type: "request",
      id: "req_1",
      operation: "session.prompt",
      sessionID: "ses_1",
      input: { text: "hello" },
    })
    const parsed = parseClientMessage(encoded)
    expect(parsed).toEqual({
      ok: true,
      value: { type: "request", id: "req_1", operation: "session.prompt", sessionID: "ses_1", input: { text: "hello" } },
    })
  })

  test("accepts a request without a session or input", () => {
    expect(parseClientMessage('{"type":"request","id":"a","operation":"session.list"}')).toEqual({
      ok: true,
      value: { type: "request", id: "a", operation: "session.list" },
    })
  })

  test("validates the exact workspace inventory and Session creation request shapes", () => {
    expect(parseClientMessage('{"type":"request","id":"a","operation":"workspace.list"}')).toEqual({
      ok: true,
      value: { type: "request", id: "a", operation: "workspace.list" },
    })
    expect(parseClientMessage('{"type":"request","id":"a","operation":"workspace.list","input":{"sessionsOnly":true}}')).toMatchObject({
      ok: true,
      value: { operation: "workspace.list", input: { sessionsOnly: true } },
    })
    expect(
      parseClientMessage('{"type":"request","id":"a","operation":"session.create","input":{"id":"ses_new","workspace":"wsp_1"}}'),
    ).toMatchObject({
      ok: true,
      value: { operation: "session.create", input: { id: "ses_new", workspace: "wsp_1" } },
    })
    for (const frame of [
      '{"type":"request","id":"a","operation":"workspace.list","input":{}}',
      '{"type":"request","id":"a","operation":"workspace.list","input":{"directory":"/tmp"}}',
      '{"type":"request","id":"a","operation":"session.create"}',
      '{"type":"request","id":"a","operation":"session.create","input":{"id":"ses_new"}}',
      '{"type":"request","id":"a","operation":"session.create","input":{"id":"bad","workspace":"wsp_1"}}',
      '{"type":"request","id":"a","operation":"session.create","input":{"id":"ses_new","workspace":"wsp_1","directory":"/tmp"}}',
      `{"type":"request","id":"a","operation":"session.create","input":{"id":"ses_new","workspace":"${"w".repeat(129)}"}}`,
    ]) expect(parseClientMessage(frame)).toMatchObject({ ok: false, error: { code: "invalid_message" } })
  })

  test("validates catalog, file find, model and agent operation inputs", () => {
    for (const [operation, input, sessionID] of [
      ["workspace.catalog", { workspace: "wsp_1" }],
      ["workspace.file.find", { workspace: "wsp_1", query: "src", limit: 50 }],
      ["session.catalog", undefined, "ses_1"],
      ["session.file.find", { query: "src", limit: 1 }, "ses_1"],
      ["session.switchModel", { model: { providerID: "openai", id: "gpt", variant: "high" } }, "ses_1"],
      ["session.switchAgent", { agent: "build" }, "ses_1"],
      ["session.command", { command: "test", files: [{ uri: "file:///work/a.ts" }] }, "ses_1"],
      ["session.skill", { skill: "test", resume: false }, "ses_1"],
      ["session.create", { id: "ses_new", workspace: "wsp_1", agent: "build", model: { providerID: "openai", id: "gpt" } }],
      ["session.prompt", { text: "test", files: [{ uri: "file:///work/a.ts" }], agents: [{ name: "build" }], resume: false }, "ses_1"],
    ] as const) {
      const request = { type: "request", id: "a", operation, ...(sessionID === undefined ? {} : { sessionID }), ...(input === undefined ? {} : { input }) }
      expect(parseClientMessage(JSON.stringify(request))).toMatchObject({ ok: true })
    }
    for (const [operation, input] of [
      ["workspace.catalog", { workspace: "" }],
      ["workspace.catalog", { workspace: "wsp_1", directory: "/work" }],
      ["workspace.file.find", { workspace: "wsp_1", query: "" }],
      ["workspace.file.find", { workspace: "wsp_1", query: "x", limit: 51 }],
      ["session.create", { id: "ses_new", workspace: "wsp_1", model: { providerID: "a", id: "b", secret: "x" } }],
    ] as const) expect(parseClientMessage(JSON.stringify({ type: "request", id: "a", operation, input }))).toMatchObject({ ok: false, error: { code: "invalid_message" } })
  })

  test("admits only bounded parent-scoped subagent page inputs", () => {
    expect(parseClientMessage('{"type":"request","id":"a","operation":"session.subagent.list","sessionID":"ses_parent"}')).toMatchObject({ ok: true })
    expect(parseClientMessage('{"type":"request","id":"a","operation":"session.subagent.list","sessionID":"ses_parent","input":{"cursor":"page_2"}}')).toMatchObject({ ok: true })
    expect(parseClientMessage('{"type":"request","id":"a","operation":"session.family.activity","sessionID":"ses_parent","input":{"sessionIDs":["ses_child"]}}')).toMatchObject({ ok: true })
    for (const input of [undefined, { sessionIDs: ["ses_child", "ses_child"] }, { sessionIDs: ["ses_parent"] }, { sessionIDs: Array.from({ length: 16 }, (_, i) => `ses_${i}`) }, { sessionIDs: ["../../etc/passwd"] }]) {
      const frame = { type: "request", id: "a", operation: "session.family.activity", sessionID: "ses_parent", ...(input === undefined ? {} : { input }) }
      expect(parseClientMessage(JSON.stringify(frame)).ok).toBe(false)
    }
    for (const raw of [
      '{"type":"request","id":"a","operation":"session.subagent.list"}',
      '{"type":"request","id":"a","operation":"session.subagent.list","sessionID":"ses_parent","input":{"limit":11}}',
      '{"type":"request","id":"a","operation":"session.subagent.list","sessionID":"ses_parent","input":{"directory":"/other"}}',
      '{"type":"request","id":"a","operation":"session.subagent.list","sessionID":"ses_parent","input":{"cursor":""}}',
    ]) expect(parseClientMessage(raw).ok).toBe(false)
  })

  test("rejects malformed frames, unknown operations, and unknown keys", () => {
    expect(parseClientMessage("not json")).toEqual({
      ok: false,
      error: { code: "invalid_message", message: "Message is not valid JSON" },
    })
    expect(parseClientMessage('{"type":"request","operation":"session.list"}')).toMatchObject({
      ok: false,
      error: { code: "invalid_message" },
    })
    expect(
      parseClientMessage('{"type":"request","id":"a","operation":"session.evil.operation","sessionID":"ses_1"}'),
    ).toMatchObject({ ok: false, error: { code: "unknown_operation" } })
    expect(
      parseClientMessage('{"type":"request","id":"a","operation":"session.list","extra":true}'),
    ).toMatchObject({ ok: false, error: { code: "invalid_message" } })
    expect(parseClientMessage('{"type":"request","id":"a b","operation":"session.list"}')).toMatchObject({
      ok: false,
      error: { code: "invalid_message" },
    })
    expect(parseClientMessage('{"type":"request","id":"a","operation":"session.get","sessionID":"nope"}')).toMatchObject({
      ok: false,
      error: { code: "invalid_message" },
    })
    expect(
      parseClientMessage('{"type":"request","id":"a","operation":"session.list","input":[1,2]}'),
    ).toMatchObject({ ok: false, error: { code: "invalid_message" } })
  })

  test("rejects requests above the client frame bound", () => {
    const frame = serializeRequest({
      type: "request",
      id: "a",
      operation: "session.list",
      input: { padding: "x".repeat(RemoteLimits.maxClientMessageChars) },
    })
    expect(parseClientMessage(frame)).toEqual({
      ok: false,
      error: { code: "message_too_large", message: "Message exceeds the client frame bound" },
    })
  })
})

describe("remote envelope: response", () => {
  test("round-trips successful and failed responses", () => {
    expect(parseAgentMessage(serializeResponse({ type: "response", id: "a", ok: true, value: { data: [] } }))).toEqual({
      ok: true,
      value: { type: "response", id: "a", ok: true, value: { data: [] } },
    })
    expect(
      parseAgentMessage(
        serializeResponse({ type: "response", id: "a", ok: false, error: { code: "internal_error", message: "boom" } }),
      ),
    ).toEqual({ ok: true, value: { type: "response", id: "a", ok: false, error: { code: "internal_error", message: "boom" } } })
  })

  test("rejects mixed success/error shapes and unknown error codes", () => {    expect(parseAgentMessage('{"type":"response","id":"a","ok":true,"error":{"code":"internal_error","message":"m"}}')).toMatchObject(
      { ok: false, error: { code: "invalid_message" } },
    )
    expect(parseAgentMessage('{"type":"response","id":"a","ok":false}')).toMatchObject({
      ok: false,
      error: { code: "invalid_message" },
    })
    expect(
      parseAgentMessage('{"type":"response","id":"a","ok":false,"error":{"code":"made_up","message":"m"}}'),
    ).toMatchObject({ ok: false, error: { code: "invalid_message" } })
    expect(
      parseAgentMessage('{"type":"response","id":"a","ok":false,"error":{"code":"internal_error","message":1}}'),
    ).toMatchObject({ ok: false, error: { code: "invalid_message" } })
  })
})

describe("remote envelope: chunked responses", () => {
  test("round-trips ordered chunks and reassembles the value", () => {
    const value = { messages: Array.from({ length: 3 }, (_, index) => ({ index, text: "x".repeat(8) })) }
    const text = JSON.stringify(value)
    const parts = [text.slice(0, 23), text.slice(23, 47), text.slice(47)]
    const frames = parts.map((part, index) =>
      serializeResponse({
        type: "response",
        id: "a",
        ok: true,
        value: part,
        chunk: { index, last: index === parts.length - 1 },
      }),
    )
    for (const frame of frames) expect(parseAgentMessage(frame)).toMatchObject({ ok: true })
    const received = frames.map((frame) => {
      const parsed = parseAgentMessage(frame)
      if (!parsed.ok || parsed.value.type !== "response" || !parsed.value.ok) throw new Error("unexpected frame")
      return parsed.value.value as string
    })
    expect(parseChunkedValue(received)).toEqual({ ok: true, value })
    expect(parseChunkedValue(["[1,2"])).toMatchObject({ ok: false, error: { code: "invalid_message" } })
    expect(parseChunkedValue([])).toMatchObject({ ok: false, error: { code: "invalid_message" } })
  })

  test("rejects malformed chunk markers", () => {
    expect(parseAgentMessage('{"type":"response","id":"a","ok":true,"value":"x","chunk":{"index":0}}')).toMatchObject({
      ok: false,
      error: { code: "invalid_message" },
    })
    expect(
      parseAgentMessage('{"type":"response","id":"a","ok":true,"value":"x","chunk":{"index":-1,"last":false}}'),
    ).toMatchObject({ ok: false, error: { code: "invalid_message" } })
    expect(
      parseAgentMessage(
        `{"type":"response","id":"a","ok":true,"value":"x","chunk":{"index":${RemoteLimits.maxChunksPerResponse},"last":true}}`,
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_message" } })
    expect(
      parseAgentMessage('{"type":"response","id":"a","ok":false,"error":{"code":"internal_error","message":"m"},"chunk":{"index":0,"last":true}}'),
    ).toMatchObject({ ok: false, error: { code: "invalid_message" } })
  })
})

describe("remote envelope: event, advertisement, heartbeat", () => {
  test("uses a bounded refresh signal instead of a capped Session inventory", () => {
    expect(parseAgentMessage('{"type":"sessions"}')).toEqual({ ok: true, value: { type: "sessions" } })
    expect(parseAgentMessage('{"type":"sessions","sessionIDs":["ses_a"]}').ok).toBe(false)
  })

  test("accepts session events and rejects inventory-shaped invalidations", () => {
    expect(parseAgentMessage(serializeEvent({ type: "event", sessionID: "ses_1", event: { type: "step.started" } }))).toEqual({
      ok: true,
      value: { type: "event", sessionID: "ses_1", event: { type: "step.started" } },
    })
    expect(parseAgentMessage(serializeSessions({ type: "sessions" }))).toEqual({ ok: true, value: { type: "sessions" } })
    expect(parseAgentMessage('{"type":"event","event":{}}')).toMatchObject({ ok: false, error: { code: "invalid_message" } })
    expect(parseAgentMessage('{"type":"sessions","sessionIDs":["nope"]}')).toMatchObject({
      ok: false,
      error: { code: "invalid_message" },
    })
  })

  test("accepts heartbeats in both directions", () => {
    expect(parseClientMessage('{"type":"ping"}')).toEqual({ ok: true, value: { type: "ping" } })
    expect(parseClientMessage('{"type":"pong"}')).toEqual({ ok: true, value: { type: "pong" } })
    expect(parseAgentMessage('{"type":"ping"}')).toEqual({ ok: true, value: { type: "ping" } })
    expect(parseAgentMessage('{"type":"pong"}')).toEqual({ ok: true, value: { type: "pong" } })
  })

  test("accepts relay subscription snapshots only on the agent control surface", () => {
    const frame = '{"type":"subscriptions","clientID":"client-1","sessionIDs":["ses_a","ses_b"]}'
    expect(parseRelayToAgentMessage(frame)).toEqual({
      ok: true,
      value: { type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_a", "ses_b"] },
    })
    expect(parseClientMessage(frame).ok).toBe(false)
    expect(parseRelayToAgentMessage('{"type":"subscriptions","clientID":"client-1","sessionIDs":[]}')).toEqual({
      ok: true,
      value: { type: "subscriptions", clientID: "client-1", sessionIDs: [] },
    })
    expect(
      parseRelayToAgentMessage(JSON.stringify({
        type: "subscriptions",
        clientID: "client-1",
        sessionIDs: Array.from({ length: RemoteLimits.maxSubscriptionsPerClient + 1 }, (_, index) => `ses_${index}`),
      })).ok,
    ).toBe(false)
  })

  test("separates agent and client roles", () => {
    const response = serializeResponse({ type: "response", id: "a", ok: true, value: null })
    expect(parseClientMessage(response)).toMatchObject({ ok: false, error: { code: "invalid_message" } })
    expect(parseClientMessage(serializeEvent({ type: "event", sessionID: "ses_1", event: {} }))).toMatchObject({
      ok: false,
      error: { code: "invalid_message" },
    })
    expect(parseClientMessage(serializeSessions({ type: "sessions" }))).toMatchObject({
      ok: false,
      error: { code: "invalid_message" },
    })
    expect(
      parseAgentMessage('{"type":"request","id":"a","operation":"session.list"}'),
    ).toMatchObject({ ok: false, error: { code: "invalid_message" } })
    const oversized = serializeEvent({
      type: "event",
      sessionID: "ses_1",
      event: { padding: "x".repeat(RemoteLimits.maxAgentMessageChars) },
    })
    expect(parseAgentMessage(oversized)).toEqual({
      ok: false,
      error: { code: "message_too_large", message: "Message exceeds the agent frame bound" },
    })
  })
})

describe("remote operations", () => {
  test("exposes exactly the session operations the relay proxies", () => {
    expect(remoteOperations).toEqual([
      "workspace.list",
      "session.list",
      "session.active",
      "session.get",
      "session.messages",
      "session.capturedChanges.list",
      "session.compaction.list",
      "session.compact",
      "session.snapshot",
      "session.pending.list",
      "session.attachment.read",
      "session.message.stream",
      "session.todo.list",
      "session.subagent.list",
      "session.subagent.cancel",
      "session.subagent.answer",
      "session.team.economics",
      "session.team.shell.list",
      "session.team.shell.kill",
      "session.side-chat.list",
      "session.side-chat.create",
      "session.family.activity",
      "session.log",
      "session.subscribe",
      "session.unsubscribe",
      "session.prompt",
      "session.attachment.upload",
      "session.interrupt",
      "session.permission.list",
      "session.permission.reply",
      "session.guardrail.status",
      "session.guardrail.request.list",
      "session.guardrail.reply",
      "session.form.list",
      "session.form.reply",
      "session.form.cancel",
      "session.shell.output",
      "session.autonomy.get",
      "session.autonomy.set",
      "session.goal.set",
      "session.goal.stop",
      "session.create",
      "session.status",
      "session.catalog",
      "workspace.catalog",
      "session.file.find",
      "workspace.file.find",
      "session.switchModel",
      "session.switchAgent",
      "session.command",
      "session.skill",
      "usage.providers",
      "usage.summary",
      "usage.report",
      "machine.keepAwake.get",
      "machine.keepAwake.set",
      "machine.latency.append",
      "machine.latency.list",
    ])
    expect(remoteOperations.filter(requireSession)).toEqual([...remoteSessionOperations])
    expect(requireSession("workspace.list")).toBe(false)
    expect(requireSession("session.create")).toBe(false)
    expect(requireSession("session.list")).toBe(false)
    expect(requireSession("session.active")).toBe(false)
    expect(requireSession("session.prompt")).toBe(true)
    expect(requireSession("session.subagent.list")).toBe(true)
    expect(requireSession("session.family.activity")).toBe(true)
    expect(parseAgentMessage('{"type":"response","id":"r","ok":false,"error":{"code":"subagent_read_only","message":"Managed subagent"}}')).toMatchObject({ ok: true })
    expect(requireSession("session.goal.stop")).toBe(true)
    expect(requireSession("session.compact")).toBe(true)
    expect(requireSession("machine.keepAwake.get")).toBe(false)
    expect(requireSession("machine.keepAwake.set")).toBe(false)
    expect(requireSession("machine.latency.append")).toBe(false)
    expect(requireSession("machine.latency.list")).toBe(false)
    expect(RemoteProtocolVersion).toBe(4)
    expect(RemoteWebSocketPath).toEqual({ client: "/ws/v4/client", agent: "/ws/v4/agent" })
    expect(parseClientMessage('{"type":"request","id":"r","operation":"session.question.list","sessionID":"ses_1"}').ok).toBe(false)
  })

  test("validates a complete bounded unique status frame on the agent surface", () => {
    expect(RemoteLimits.maxStatusSessions).toBe(500)
    const status = { type: "status" as const, running: ["ses_a"], attention: ["ses_b"] }
    expect(parseAgentMessage(JSON.stringify(status))).toEqual({ ok: true, value: status })
    expect(parseClientMessage(JSON.stringify(status)).ok).toBe(false)
    expect(parseAgentMessage(JSON.stringify({ ...status, outstanding: ["ses_c"] }))).toEqual({
      ok: true, value: { ...status, outstanding: ["ses_c"] },
    })
    expect(parseAgentMessage(JSON.stringify({ ...status, attention: ["ses_b", "ses_c"], failed: ["ses_c"] }))).toEqual({
      ok: true, value: { ...status, attention: ["ses_b", "ses_c"], failed: ["ses_c"] },
    })
    for (const frame of [
      { type: "status", running: [], attention: ["ses_b"], failed: ["ses_c"] },
      { type: "status", running: [], attention: ["ses_b"], failed: ["ses_b", "ses_b"] },
      { type: "status", running: [], attention: ["ses_b"], failed: ["not-session"] },
      { type: "status", running: [], attention: ["ses_b"], failed: "ses_b" },
      { type: "status", running: [], attention: Array.from({ length: 500 }, (_, index) => `ses_${index}`), failed: Array.from({ length: 501 }, (_, index) => `ses_${index}`) },
      { type: "status", running: ["ses_a", "ses_a"], attention: [] },
      { type: "status", running: ["ses_a"], attention: ["not-session"] },
      { type: "status", running: [], attention: [], secret: "x" },
      { type: "status", running: Array.from({ length: 501 }, (_, index) => `ses_${index}`), attention: [] },
      { type: "status", running: [], attention: [], outstanding: ["ses_a", "ses_a"] },
      { type: "status", running: [], attention: [], outstanding: Array.from({ length: 501 }, (_, index) => `ses_${index}`) },
    ]) expect(parseAgentMessage(JSON.stringify(frame)).ok).toBe(false)
  })

  test("carries bounded alert details only for attention roots", () => {
    const status = { type: "status" as const, running: [], attention: ["ses_b", "ses_c"], failed: ["ses_c"],
      details: [{ sessionID: "ses_b", title: "Fix login", need: "permission" as const }, { sessionID: "ses_c", title: "Ship release" }] }
    expect(parseAgentMessage(serializeStatus(status))).toEqual({ ok: true, value: status })
    expect(parseRelayToClientMessage(serializeStatus(status))).toEqual({ ok: true, value: status })
    for (const need of ["permission", "question", "review"] as const)
      expect(parseAgentMessage(JSON.stringify({ ...status, details: [{ sessionID: "ses_b", need }] })).ok).toBe(true)
    for (const details of [
      [{ sessionID: "ses_a", title: "Not in attention" }],
      [{ sessionID: "ses_b" }, { sessionID: "ses_b" }],
      [{ sessionID: "ses_b", need: "failed" }],
      [{ sessionID: "ses_b", title: "" }],
      [{ sessionID: "ses_b", title: " padded " }],
      [{ sessionID: "ses_b", title: "line\nbreak" }],
      [{ sessionID: "ses_b", title: "x".repeat(RemoteLimits.maxAlertTitleChars + 1) }],
      [{ sessionID: "ses_b", prompt: "private" }],
      { sessionID: "ses_b" },
    ]) expect(parseAgentMessage(JSON.stringify({ ...status, details })).ok).toBe(false)
    expect(parseAgentMessage(JSON.stringify({ ...status, details: [{ sessionID: "ses_b", title: "😀".repeat(RemoteLimits.maxAlertTitleChars) }] })).ok).toBe(true)
  })

  test("bounds a Session title for an alert", () => {
    expect(alertTitle("  Fix\n  the\tlogin  ")).toBe("Fix the login")
    expect(alertTitle(" \n ")).toBeUndefined()
    const long = alertTitle("word ".repeat(100))
    expect(long !== undefined && isAlertTitle(long) && long.endsWith("…")).toBe(true)
    expect(Array.from(long ?? "").length).toBe(RemoteLimits.maxAlertTitleChars)
  })

  test("admits every reconnect read operation and requires a session for it", () => {
    expect(parseClientMessage('{"type":"request","id":"r","operation":"session.active"}')).toEqual({
      ok: true,
      value: { type: "request", id: "r", operation: "session.active" },
    })
    expect(parseClientMessage('{"type":"request","id":"r","operation":"session.active","sessionID":"ses_1"}')).toEqual({
      ok: true,
      value: { type: "request", id: "r", operation: "session.active", sessionID: "ses_1" },
    })

    const reads: readonly RemoteOperation[] = [
      "session.snapshot",
      "session.pending.list",
      "session.compaction.list",
      "session.permission.list",
      "session.guardrail.status",
      "session.guardrail.request.list",
      "session.form.list",
      "session.shell.output",
      "session.autonomy.get",
    ]
    for (const operation of reads) {
      expect(requireSession(operation)).toBe(true)
      expect(parseClientMessage(JSON.stringify({ type: "request", id: "r", operation, sessionID: "ses_1" }))).toEqual({
        ok: true,
        value: { type: "request", id: "r", operation, sessionID: "ses_1" },
      })
      expect(parseClientMessage(JSON.stringify({ type: "request", id: "r", operation }))).toEqual({
        ok: false,
        error: { code: "session_required", message: "Operation requires a session" },
        id: "r",
      })
    }
    expect(parseClientMessage('{"type":"request","id":"r","operation":"session.permission.approve","sessionID":"ses_1"}')).toEqual({
      ok: false,
      error: { code: "unknown_operation", message: "Unknown operation" },
      id: "r",
    })
  })
})

describe("device authentication shapes", () => {
  test("accepts a valid one-use enrollment request and rejects tampered ones", () => {
    expect(
      parseEnrollRequest({
        enrollmentID: "enr_1",
        code: "ABCD-EFGH-JKLM-NPQR-STVW",
        name: "Studio Mac",
        publicKey: jwk,
      }),
    ).toEqual({
      ok: true,
      value: { enrollmentID: "enr_1", code: "ABCD-EFGH-JKLM-NPQR-STVW", name: "Studio Mac", publicKey: jwk },
    })
    expect(parseEnrollRequest({ enrollmentID: "enr_1", code: "short", name: "x", publicKey: jwk })).toMatchObject({
      ok: false,
    })
    expect(
      parseEnrollRequest({ enrollmentID: "enr_1", code: "ABCD-EFGH-JKLM-NPQR-STVW", name: "", publicKey: jwk }),
    ).toMatchObject({ ok: false })
    expect(
      parseEnrollRequest({ enrollmentID: "enr_1", code: "ABCD-EFGH-JKLM-NPQR-STVW", name: "x".repeat(101), publicKey: jwk }),
    ).toMatchObject({ ok: false })
    expect(
      parseEnrollRequest({
        enrollmentID: "enr_1",
        code: "ABCD-EFGH-JKLM-NPQR-STVW",
        name: "x",
        publicKey: { ...jwk, crv: "P-384" },
      }),
    ).toMatchObject({ ok: false })
  })

  test("validates the P-256 public key encoding", () => {
    expect(parsePublicKey(jwk)).toEqual({ ok: true, value: jwk })
    expect(parsePublicKey({ kty: "EC", crv: "P-256", x: "not+base64url", y: jwk.y })).toMatchObject({ ok: false })
    expect(parsePublicKey({ kty: "RSA", crv: "P-256", x: jwk.x, y: jwk.y })).toMatchObject({ ok: false })
    expect(parsePublicKey({ kty: "EC", crv: "P-256", x: "AAAA", y: jwk.y })).toMatchObject({ ok: false })
    expect(parsePublicKey(null)).toMatchObject({ ok: false })
  })

  test("parses challenge, token, and refresh requests", () => {
    expect(parseChallengeRequest({ deviceID: "dev_1" })).toEqual({ ok: true, value: { deviceID: "dev_1" } })
    expect(parseChallengeRequest({})).toMatchObject({ ok: false })
    expect(
      parseDeviceTokenRequest({ deviceID: "dev_1", challengeID: "chl_1", signature: "AAAA" }),
    ).toEqual({ ok: true, value: { deviceID: "dev_1", challengeID: "chl_1", signature: "AAAA" } })
    expect(parseDeviceTokenRequest({ deviceID: "dev_1", challengeID: "chl_1" })).toMatchObject({ ok: false })
    expect(parseDeviceRefreshRequest({ deviceID: "dev_1", refreshToken: "token" })).toEqual({
      ok: true,
      value: { deviceID: "dev_1", refreshToken: "token" },
    })
    expect(parseDeviceRefreshRequest({ deviceID: "dev_1", refreshToken: "" })).toMatchObject({ ok: false })
  })

  test("defines one canonical signature payload", () => {
    expect(deviceSignaturePayload("chl_1", "n0nce")).toBe("ycoding-device-v1\nchl_1\nn0nce")
  })

  test("keeps the error vocabulary closed", () => {
    expect(remoteError("session_not_allowed", "Session is not served by the connected agent")).toEqual({
      code: "session_not_allowed",
      message: "Session is not served by the connected agent",
    })
  })
})

describe("notice log contract", () => {
  const notice = { id: "ntc_1", category: "approval-requested", sessionID: "ses_a", createdAt: 1_700_000_000_000 } as const
  const request = (operation: string, input?: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "request", id: "req_1", operation, ...(input === undefined ? {} : { input }), ...extra })

  test("admits the relay-local notice operations with bounded strict input", () => {
    expect(parseClientMessage(request("notice.subscribe"))).toEqual({ ok: true, value: { type: "request", id: "req_1", operation: "notice.subscribe" } })
    expect(parseClientMessage(request("notice.readAll"))).toEqual({ ok: true, value: { type: "request", id: "req_1", operation: "notice.readAll" } })
    expect(parseClientMessage(request("notice.list", { before: "ntc_51" }))).toEqual({
      ok: true, value: { type: "request", id: "req_1", operation: "notice.list", input: { before: "ntc_51" } },
    })
    expect(parseClientMessage(request("notice.read", { ids: ["ntc_1", "ntc_2"] }))).toEqual({
      ok: true, value: { type: "request", id: "req_1", operation: "notice.read", input: { ids: ["ntc_1", "ntc_2"] } },
    })
    expect(isNoticeRequest({ type: "request", id: "r", operation: "notice.read", input: { ids: ["ntc_1"] } })).toBe(true)
    expect(isNoticeRequest({ type: "request", id: "r", operation: "session.list" })).toBe(false)
    expect(isNoticeRequest({ type: "ping" })).toBe(false)
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `ntc_${index + 1}`)
    expect(parseClientMessage(request("notice.read", { ids: ids(RemoteLimits.maxNoticeBatch) })).ok).toBe(true)
    for (const frame of [
      request("notice.subscribe", {}),
      request("notice.subscribe", { push: null }),
      request("notice.subscribe", { push: "A".repeat(43) }),
      request("notice.readAll", { ids: [] }),
      request("notice.subscribe", undefined, { sessionID: "ses_a" }),
      request("notice.list"),
      request("notice.list", {}),
      request("notice.list", { before: "ses_1" }),
      request("notice.list", { before: "ntc_1", extra: true }),
      request("notice.list", { before: "ntc_1234567890123456" }),
      request("notice.read"),
      request("notice.read", { ids: [] }),
      request("notice.read", { ids: ids(RemoteLimits.maxNoticeBatch + 1) }),
      request("notice.read", { ids: ["ntc_1", "ntc_1"] }),
      request("notice.read", { ids: ["../x"] }),
      request("notice.read", { ids: ["ntc_x"] }),
      request("notice.read", { ids: [1] }),
      request("notice.read", { ids: ["ntc_1"], extra: true }),
    ]) expect(parseClientMessage(frame).ok).toBe(false)
  })

  test("keeps notice operations off the agent surface and out of the forwarded operation set", () => {
    expect(parseRelayToAgentMessage(request("notice.subscribe")).ok).toBe(false)
    expect(parseRelayToAgentMessage(request("notice.readAll")).ok).toBe(false)
    expect(remoteOperations.some((operation) => operation.startsWith("notice."))).toBe(false)
  })

  test("parses relay frames for a browser and refuses to let an agent originate them", () => {
    const frames: RemoteNoticeFrame[] = [
      { type: "notice.added", notices: [notice, { ...notice, id: "ntc_2", category: "agent-completed" }], total: 9 },
      { type: "notice.removed", ids: ["ntc_1", "ntc_2"], total: 0 },
      { type: "notice.cleared" },
      { type: "notice.unavailable" },
      { type: "notice.offline", at: 1_790_000_000_000 },
      { type: "notice.present", items: [{ kind: "notice", notice }, { kind: "notice", notice: { ...notice, id: "ntc_2" } }, { kind: "offline", at: 1_790_000_000_000 }] },
      { type: "notice.present", items: [{ kind: "notice", notice, detail: { title: "Fix login", need: "failed" } },
        { kind: "notice", notice: { ...notice, id: "ntc_2" }, detail: { need: "question", repeat: true } }, { kind: "notice", notice: { ...notice, id: "ntc_3" }, detail: {} }] },
    ]
    for (const frame of frames) {
      expect(parseRelayToClientMessage(JSON.stringify(frame))).toEqual({ ok: true, value: frame })
      expect(serializeNoticeFrame(frame)).toBe(JSON.stringify(frame))
      expect(parseAgentMessage(JSON.stringify(frame)).ok).toBe(false)
      expect(parseClientMessage(JSON.stringify(frame)).ok).toBe(false)
    }
    expect(parseRelayToClientMessage('{"type":"status","running":["ses_a"],"attention":[]}')).toEqual({
      ok: true, value: { type: "status", running: ["ses_a"], attention: [] },
    })
    expect(parseRelayToClientMessage('{"type":"response","id":"r","ok":true,"value":null}')).toEqual({
      ok: true, value: { type: "response", id: "r", ok: true, value: null },
    })
    expect(parseRelayToClientMessage('{"type":"ping"}')).toEqual({ ok: true, value: { type: "ping" } })
  })

  test("rejects malformed or oversized notice frames", () => {
    const many = Array.from({ length: RemoteLimits.maxNoticeBatch + 1 }, (_, index) => ({ ...notice, id: `ntc_${index}` }))
    for (const frame of [
      { type: "notice.snapshot", notices: [], total: 0 },
      { type: "notice.added", notices: [] , total: 0 },
      { type: "notice.added", notices: [notice] },
      { type: "notice.added", notices: [notice], total: -1 },
      { type: "notice.added", notices: [notice], total: 1.5 },
      { type: "notice.added", notices: [{ ...notice, category: "machine-offline" }], total: 1 },
      { type: "notice.added", notices: [{ ...notice, sessionID: "not-a-session" }], total: 1 },
      { type: "notice.added", notices: [{ ...notice, createdAt: -1 }], total: 1 },
      { type: "notice.added", notices: [{ ...notice, createdAt: 1.5 }], total: 1 },
      { type: "notice.added", notices: [{ ...notice, id: "../x" }], total: 1 },
      { type: "notice.added", notices: [{ ...notice, title: "secret" }], total: 1 },
      { type: "notice.added", notices: [notice, notice], total: 2 },
      { type: "notice.added", notices: many, total: many.length },
      { type: "notice.added", notices: [notice], total: 1, extra: true },
      { type: "notice.removed", ids: [], total: 0 },
      { type: "notice.removed", ids: ["ntc_1"] },
      { type: "notice.removed", ids: ["ntc_1", "ntc_1"], total: 0 },
      { type: "notice.removed", ids: many.map((entry) => entry.id), total: 0 },
      { type: "notice.removed", ids: [7], total: 0 },
      { type: "notice.cleared", total: 0 },
      { type: "notice.unavailable", reason: "storage_full" },
      { type: "notice.offline" },
      { type: "notice.offline", at: 0 },
      { type: "notice.offline", at: 1.5 },
      { type: "notice.offline", at: "1790000000000" },
      { type: "notice.offline", at: 1, deviceID: "dev_1" },
      { type: "notice.present", items: [{ kind: "notice", notice, detail: { need: "finished" } }] },
      { type: "notice.present", items: [{ kind: "notice", notice, detail: { title: "two\nlines" } }] },
      { type: "notice.present", items: [{ kind: "notice", notice, detail: { title: "Fix", prompt: "private" } }] },
      { type: "notice.present", items: [{ kind: "notice", notice, detail: "Fix" }] },
      { type: "notice.present", items: [{ kind: "notice", notice, detail: { repeat: false } }] },
      { type: "notice.present", items: [] },
      { type: "notice.present" },
      { type: "notice.present", items: [{ kind: "notice", notice }, { kind: "notice", notice }] },
      { type: "notice.present", items: [{ kind: "offline", at: 5 }, { kind: "offline", at: 5 }] },
      { type: "notice.present", items: [{ kind: "offline", at: 0 }] },
      { type: "notice.present", items: [{ kind: "offline", at: 1, deviceID: "dev_1" }] },
      { type: "notice.present", items: [{ kind: "notice", notice: { ...notice, endpoint: "https://fcm.googleapis.com/fcm/send/abc" } }] },
      { type: "notice.present", items: [{ kind: "push", notice }] },
      { type: "notice.present", items: many.map((entry) => ({ kind: "notice", notice: entry })) },
    ]) expect(parseRelayToClientMessage(JSON.stringify(frame)).ok).toBe(false)
    expect(parseRelayToClientMessage("not json").ok).toBe(false)
    expect(parseRelayToClientMessage("x".repeat(RemoteLimits.maxAgentMessageChars + 1))).toMatchObject({ ok: false, error: { code: "message_too_large" } })
  })

  test("validates the page a subscribe or list response carries", () => {
    const page = { notices: [notice, { ...notice, id: "ntc_2" }], next: "ntc_1", total: 7, unavailable: false }
    expect(parseNoticePage(page)).toEqual({ ok: true, value: page })
    expect(parseNoticePage(JSON.parse(JSON.stringify(noticePageValue(page))))).toEqual({ ok: true, value: page })
    expect(parseNoticePage({ notices: [], total: 0, unavailable: true })).toEqual({ ok: true, value: { notices: [], total: 0, unavailable: true } })
    const full = Array.from({ length: RemoteLimits.noticePageSize + 1 }, (_, index) => ({ ...notice, id: `ntc_${index}` }))
    for (const bad of [
      null, [], "page", {},
      { notices: [], total: 0 },
      { notices: [], total: -1, unavailable: false },
      { notices: [], total: 0, unavailable: "no" },
      { notices: [], next: "ses_1", total: 0, unavailable: false },
      { notices: [notice, notice], total: 2, unavailable: false },
      { notices: full, total: full.length, unavailable: false },
      { notices: [{ ...notice, title: "secret" }], total: 1, unavailable: false },
      { notices: [], total: 0, unavailable: false, extra: 1 },
    ]) expect(parseNoticePage(bad).ok).toBe(false)
  })

  test("derives the ordering sequence from a notice id only when it is well formed", () => {
    expect(noticeSequence("ntc_42")).toBe(42)
    expect(noticeSequence("ntc_999999999999999")).toBe(999_999_999_999_999)
    for (const id of ["ntc_", "ntc_x", "ntc_1234567890123456", "ses_1", "ntc_-1", "ntc_1.5"]) expect(noticeSequence(id)).toBeUndefined()
  })
})
