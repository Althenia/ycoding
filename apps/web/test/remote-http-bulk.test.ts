import { expect, test } from "bun:test"
import { decodeStrict, FrameSchema } from "@ycoding-ai/remote"
import { transportFixture } from "./wire-peer"

const origin = "https://fixture.invalid"
const deviceID = "dev_1"
const sessionID = "ses_1"
const digest = "a".repeat(64)
const assetRequest = { sessionID, input: { digest } }

test("pairs an attachment GET with its request and waits for the socket terminal before exposing bytes", async () => {
  const bytes = Uint8Array.from({ length: 65539 }, (_, index) => index % 251)
  const terminal = Promise.withResolvers<() => void>()
  const f = transportFixture({ handler: (_request, dispatch, peer) => {
    const send = peer.message.bind(peer)
    peer.message = (raw) => {
      if (typeof raw !== "string" && decodeStrict(FrameSchema, new Uint8Array(raw)).body.case === "bulkEnd")
        terminal.resolve(() => send(raw))
      else send(raw)
    }
    peer.asset(dispatch, bytes, "image/png", true)
  } })
  try {
    const peer = f.sockets[0]!
    const receive = peer.receive.bind(peer)
    peer.receive = (raw) => {
      receive(raw)
      if (typeof raw === "string") return
      const body = decodeStrict(FrameSchema, new Uint8Array(raw)).body
      if (body.case === "control" && body.value.kind.case === "credit" && body.value.kind.value.transferId)
        queueMicrotask(() => f.advance(25))
    }
    const paths: string[] = []
    let published = false
    const read = f.transport.request("session.attachment.read", { ...assetRequest, httpBulk: { deviceID, fetch: async (path, init) => {
      paths.push(path)
      expect(init).toMatchObject({ credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store" })
      return peer.readHttp(new URL(path, origin))
    } } }).then((outcome) => { published = true; return outcome })
    const handoff = await terminal.promise
    expect(published).toBe(false)
    const requestID = peer.requests()[0]!.id
    expect(paths).toEqual([`/api/remote/devices/${deviceID}/sessions/${sessionID}/attachments/${digest}?connectionEpoch=${peer.connection.connectionEpoch}&requestID=${requestID}&transferID=fixture-${requestID}`])
    handoff()
    const outcome = await read
    expect(outcome.status).toBe("ok")
    if (outcome.status !== "ok") throw new Error("Expected an owned attachment")
    const asset = outcome.value
    if (typeof asset !== "object" || asset === null || !("release" in asset) || typeof asset.release !== "function")
      throw new Error("Expected an owned result")
    try {
      expect(asset).toMatchObject({ mime: "image/png", data: bytes })
    } finally { asset.release() }
  } finally { f.transport.close() }
})

test.each(["mismatched declaration", "truncated body", "HTTP authorization refused"])("does not publish an attachment with %s", async (fault) => {
  const f = transportFixture({ handler: (_request, dispatch, peer) => peer.asset(dispatch, Uint8Array.of(1, 2, 3), "image/png", true) })
  try {
    const outcome = await f.transport.request("session.attachment.read", { ...assetRequest, httpBulk: { deviceID, fetch: async (path) => {
      if (fault === "HTTP authorization refused") return new Response(null, { status: 403 })
      const real = f.sockets[0]!.readHttp(new URL(path, origin))
      const headers = new Headers(real.headers)
      if (fault === "mismatched declaration") headers.set("x-ycoding-transfer-id", "someone-elses-transfer")
      return new Response(Uint8Array.of(1), { headers })
    } } })
    expect(outcome).toMatchObject({ status: "unknown" })
    expect(f.sockets[0]!.sent.some((frame) => frame.body.case === "control" && frame.body.value.kind.case === "cancel")).toBe(true)
  } finally { f.transport.close() }
})

test.each(["request abort", "request timeout", "socket close"])("cancels a pending HTTP body on %s", async (reason) => {
  const f = transportFixture({ handler: (_request, dispatch, peer) => peer.asset(dispatch, Uint8Array.of(1), "image/png", true) })
  const controller = new AbortController()
  const waiting = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  try {
    const read = f.transport.request("session.attachment.read", { ...assetRequest, signal: controller.signal, timeoutMs: 10, httpBulk: { deviceID, fetch: async (path) => {
      const declared = f.sockets[0]!.readHttp(new URL(path, origin))
      return new Response(new ReadableStream({
        pull() { waiting.resolve() },
        cancel() { cancelled.resolve() },
      }, { highWaterMark: 0 }), { headers: declared.headers })
    } } })
    await waiting.promise
    if (reason === "request abort") controller.abort()
    if (reason === "request timeout") f.advance(10)
    if (reason === "socket close") f.sockets[0]!.drop()
    expect(await read).toMatchObject({ status: "unknown" })
    await cancelled.promise
    expect(f.sockets).toHaveLength(1)
  } finally { f.transport.close() }
})

test.each(["inline success", "not found"])("does not open HTTP when projected message admission settles as %s", async (mode) => {
  const messageID = "msg_1"
  const result = { data: { id: messageID, type: "user", text: "short", time: { created: 1 } } }
  const f = transportFixture({ handler: (_request, dispatch, peer) => {
    if (mode === "inline success") peer.result(dispatch, result)
    else peer.error(dispatch, "ycoding.v5.MessageNotFoundError", { _tag: "MessageNotFoundError", sessionID, messageID, message: "Not found" })
  } })
  try {
    let calls = 0
    const outcome = await f.transport.request("session.message", { sessionID, input: { messageID }, httpBulk: { deviceID, fetch: async () => {
      calls++
      return new Response(null, { status: 500 })
    } } })
    if (mode === "inline success") expect(outcome).toMatchObject({ status: "ok", value: result })
    else expect(outcome).toMatchObject({ status: "failed", error: { code: "not_found" } })
    expect(calls).toBe(0)
  } finally { f.transport.close() }
})
