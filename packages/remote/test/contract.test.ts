import { describe, expect, test } from "bun:test"
import {
  RemoteLimits,
  RemoteProtocolVersion,
  RemoteWebSocketPath,
  deviceSignaturePayload,
  parseAgentMessage,
  parseChallengeRequest,
  parseClientMessage,
  parseDeviceRefreshRequest,
  parseDeviceTokenRequest,
  parseEnrollRequest,
  parseChunkedValue,
  parsePublicKey,
  parseRelayToAgentMessage,
  remoteError,
  remoteOperations,
  remoteSessionOperations,
  requireSession,
  serializeEvent,
  serializeRequest,
  serializeResponse,
  serializeSessions,
  type RemoteOperation,
} from "../src/index"

const jwk = {
  kty: "EC",
  crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
} as const

describe("remote envelope: request", () => {
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
      "session.snapshot",
      "session.log",
      "session.subscribe",
      "session.unsubscribe",
      "session.prompt",
      "session.interrupt",
      "session.permission.list",
      "session.permission.reply",
      "session.guardrail.status",
      "session.guardrail.request.list",
      "session.guardrail.reply",
      "session.form.list",
      "session.form.reply",
      "session.form.cancel",
      "session.fileChange.list",
      "session.shell.output",
      "session.autonomy.get",
      "session.autonomy.set",
      "session.goal.set",
      "session.goal.stop",
      "session.create",
    ])
    expect(remoteOperations).toEqual(["workspace.list", "session.list", "session.active", ...remoteSessionOperations, "session.create"])
    expect(requireSession("workspace.list")).toBe(false)
    expect(requireSession("session.create")).toBe(false)
    expect(requireSession("session.list")).toBe(false)
    expect(requireSession("session.active")).toBe(false)
    expect(requireSession("session.prompt")).toBe(true)
    expect(requireSession("session.goal.stop")).toBe(true)
    expect(RemoteProtocolVersion).toBe(3)
    expect(RemoteWebSocketPath).toEqual({ client: "/ws/v3/client", agent: "/ws/v3/agent" })
    expect(parseClientMessage('{"type":"request","id":"r","operation":"session.question.list","sessionID":"ses_1"}').ok).toBe(false)
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
      "session.permission.list",
      "session.guardrail.status",
      "session.guardrail.request.list",
      "session.form.list",
      "session.fileChange.list",
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
